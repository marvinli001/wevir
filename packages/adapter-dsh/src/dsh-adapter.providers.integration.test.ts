// Provider 桥接（T3.4）的真实 dsh 集成测试：模型换成本地脚本化的服务（test-fixtures/mock-model.ts），不需要 Key。
// - 生成的 overlay（JSON 写成的 YAML）dsh 照收，Key 经 apiKeyEnv 从子进程环境到达 Provider 的请求头；
// - 多个 Provider 并存时每个会话按 set_config_option 选定的路由发请求；
// - Provider 变更的生效（ADR-0001 补记 5）：运行中的 dsh 不读改过的 overlay；configureProviders 重启之后，新会话
//   与 resume 回来的旧会话都用新配置。dsh 升级时重跑这个文件（UPSTREAM.md 的升级检查清单）。

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { methods } from '@agentclientprotocol/sdk';
import { type AgentEvent, isTurnTerminal, type ProviderConfig } from '@wevir/runtime-adapter';
import { afterEach, describe, expect, it } from 'vitest';
import { DshAdapter } from './dsh-adapter.js';
import { providerOverlayPath } from './provider-config.js';
import { type MockRequestMeta, startMockModel } from './test-fixtures/mock-model.js';

const KEY_A = 'sk-wevir-mock-a-not-a-secret';
const KEY_B = 'sk-wevir-mock-b-not-a-secret';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(label: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `wevir-dsh-providers-it-${label}-`)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 一个本地 Provider：记下每个请求的头与请求体的顶层字段，回一句带自己名字的话。 */
async function mockProvider(name: string) {
  const requests: MockRequestMeta[] = [];
  const fields: string[][] = [];
  const model = await startMockModel((request, meta) => {
    requests.push(meta);
    fields.push(Object.keys(request));
    return { text: [`来自 ${name}`] };
  });
  cleanups.push(() => model.close());
  return { ...model, requests, fields };
}

const compatible = (id: string, baseURL: string, apiKey: string): ProviderConfig => ({
  id,
  kind: 'openai-compatible',
  displayName: `Mock ${id}`,
  api: 'openai-completions',
  baseURL,
  models: [{ id: 'mock-model', contextWindow: 65536, maxTokens: 4096, reasoningEfforts: [] }],
  defaultModelId: 'mock-model',
  apiKey,
});

function newAdapter(home: string, providers: ProviderConfig[]) {
  const adapter = new DshAdapter({
    home,
    providers,
    streamTap: false,
    logger: { warn: () => {} },
  });
  cleanups.push(() => adapter.dispose());
  return adapter;
}

async function turn(adapter: DshAdapter, engineSessionId: string, text: string) {
  const events = adapter.subscribe(engineSessionId)[Symbol.asyncIterator]();
  await adapter.send(engineSessionId, { content: [{ type: 'text', text }] });
  const out: AgentEvent[] = [];
  for (;;) {
    const { value, done } = await events.next();
    if (done) throw new Error('订阅在回合结束前结束');
    out.push(value);
    if (isTurnTerminal(value)) return out;
  }
}

const messageText = (events: AgentEvent[]) =>
  events
    .filter((e) => e.type === 'assistant.message')
    .map((e) => (e as { text: string }).text)
    .join('');

describe('DshAdapter Provider 桥接（真实 dsh + mock Provider）', () => {
  it('生成的 overlay 被 dsh 接受；两个 Provider 各用各的 Key；会话按选定的路由发请求', {
    timeout: 60_000,
  }, async () => {
    const a = await mockProvider('A');
    const b = await mockProvider('B');
    const adapter = newAdapter(tempDir('home'), [
      compatible('mock-a', a.baseURL, KEY_A),
      compatible('mock-b', b.baseURL, KEY_B),
    ]);
    const cwd = tempDir('ws');

    const sa = await adapter.createSession({ cwd, providerId: 'mock-a', modelId: 'mock-model' });
    const sb = await adapter.createSession({ cwd, providerId: 'mock-b', modelId: 'mock-model' });
    expect(sa.modelId).toBe('mock-model');
    expect(messageText(await turn(adapter, sb.engineSessionId, '你好'))).toBe('来自 B');
    expect(messageText(await turn(adapter, sa.engineSessionId, '你好'))).toBe('来自 A');

    expect(a.requests.map((r) => r.headers.authorization)).toEqual([`Bearer ${KEY_A}`]);
    expect(b.requests.map((r) => r.headers.authorization)).toEqual([`Bearer ${KEY_B}`]);
    expect(a.requests[0]?.url).toBe('/v1/chat/completions');
    expect(readFileSync(providerOverlayPath(adapter.process.paths), 'utf8')).not.toMatch(
      /sk-wevir-mock/,
    );
  });

  it('DeepSeek 官方路由：Key 经 x-api-key 到达 llm-deepseek 的 Messages 端点；请求不带会话日志与插件清单', {
    timeout: 60_000,
  }, async () => {
    const mock = await mockProvider('DeepSeek');
    const adapter = newAdapter(tempDir('home'), [
      {
        id: 'deepseek-official',
        kind: 'deepseek-official',
        displayName: 'DeepSeek',
        baseURL: mock.baseURL.replace(/\/v1$/, '/anthropic'),
        models: [],
        defaultModelId: 'deepseek-flash',
        apiKey: KEY_A,
      },
    ]);
    const session = await adapter.createSession({
      cwd: tempDir('ws'),
      providerId: 'deepseek-official',
      modelId: 'deepseek-flash',
    });
    expect(session.modelId).toBe('deepseek-flash');
    // mock 只会说 OpenAI 的流式格式，这个回合会失败；这里只看请求到了哪里、带了什么。
    await turn(adapter, session.engineSessionId, '你好');
    expect(mock.requests[0]?.url).toBe('/anthropic/v1/messages');
    expect(mock.requests[0]?.headers['x-api-key']).toBe(KEY_A);
    // dsh 默认附带的两个扩展字段，overlay 关掉了（docs/security.md §4）。
    expect(mock.fields[0]).toContain('messages');
    expect(mock.fields[0]).not.toContain('dsh_session_log');
    expect(mock.fields[0]).not.toContain('dsh_plugin_packages');
  });

  it('Provider 变更：运行中的 dsh 不读改过的 overlay；重启之后新会话与 resume 的旧会话都用新配置', {
    timeout: 90_000,
  }, async () => {
    const a = await mockProvider('A');
    const b = await mockProvider('B');
    const adapter = newAdapter(tempDir('home'), [compatible('mock', a.baseURL, KEY_A)]);
    const cwd = tempDir('ws');
    const s1 = await adapter.createSession({ cwd, providerId: 'mock', modelId: 'mock-model' });
    expect(messageText(await turn(adapter, s1.engineSessionId, '第一句'))).toBe('来自 A');

    // 1. 直接改 overlay 文件（同一 Provider 指向 B）：已有会话与新会话都还走 A。
    const overlay = providerOverlayPath(adapter.process.paths);
    writeFileSync(overlay, readFileSync(overlay, 'utf8').replace(a.baseURL, b.baseURL));
    expect(messageText(await turn(adapter, s1.engineSessionId, '第二句'))).toBe('来自 A');
    const s2 = await adapter.createSession({ cwd, providerId: 'mock', modelId: 'mock-model' });
    expect(messageText(await turn(adapter, s2.engineSessionId, '第三句'))).toBe('来自 A');
    expect(b.requests).toHaveLength(0);

    // 2. configureProviders：没有回合，立即重启；挂着的会话以 config_changed 脱开。
    const exited = adapter.subscribe(s1.engineSessionId)[Symbol.asyncIterator]();
    await adapter.configureProviders([compatible('mock', b.baseURL, KEY_B)]);
    expect((await exited.next()).value).toMatchObject({
      type: 'engine.exited',
      reason: 'config_changed',
    });
    const s3 = await adapter.createSession({ cwd, providerId: 'mock', modelId: 'mock-model' });
    expect(messageText(await turn(adapter, s3.engineSessionId, '第四句'))).toBe('来自 B');

    // 3. 旧会话 resume（T3.5 之前直接走 ACP）之后同样用新的地址与 Key：路由按 Provider ID 在请求时解析。
    const connection = adapter.process.connection;
    await connection.agent.request(methods.agent.session.resume, {
      sessionId: s1.engineSessionId,
      cwd,
      mcpServers: [],
    });
    const resumed = await connection.agent.request(methods.agent.session.prompt, {
      sessionId: s1.engineSessionId,
      prompt: [{ type: 'text', text: '第五句' }],
    });
    expect(resumed.stopReason).toBe('end_turn');
    expect(b.requests.map((r) => r.headers.authorization)).toEqual([
      `Bearer ${KEY_B}`,
      `Bearer ${KEY_B}`,
    ]);
    expect(a.requests).toHaveLength(3);
  });
});
