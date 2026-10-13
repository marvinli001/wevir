// DshAdapter 的 Provider 桥接（T3.4）：dsh 换成 test-fixtures/fake-dsh.mjs 的 acp 模式（真实子进程），检查
// overlay 与子进程环境、每个会话的路由选择，以及 Provider 变更后的重启时机。真实 dsh 的验证在
// dsh-adapter.providers.integration.test.ts。

import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AgentEvent,
  isAdapterError,
  isTurnTerminal,
  type ProviderConfig,
} from '@wevir/runtime-adapter';
import { afterEach, describe, expect, it } from 'vitest';
import { DshAdapter, type DshAdapterOptions } from './dsh-adapter.js';
import { providerOverlayPath } from './provider-config.js';

const FAKE_DSH = fileURLToPath(new URL('./test-fixtures/fake-dsh.mjs', import.meta.url));
const KEY = 'sk-wevir-fake-0123456789abcdef';

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(label: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `wevir-dsh-providers-${label}-`)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const gateway = (patch: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: 'my-gateway',
  kind: 'openai-compatible',
  displayName: 'My Gateway',
  api: 'openai-completions',
  baseURL: 'https://gateway.example/v1',
  models: [{ id: 'model-a', contextWindow: 131072 }, { id: 'model-b' }],
  defaultModelId: 'model-a',
  apiKey: KEY,
  ...patch,
});

const deepseek: ProviderConfig = {
  id: 'deepseek-official',
  kind: 'deepseek-official',
  displayName: 'DeepSeek',
  models: [],
  defaultModelId: 'deepseek-flash',
  apiKey: `${KEY}-deepseek`,
};

function setup(options: Partial<DshAdapterOptions> = {}) {
  const warnings: string[] = [];
  const adapter = new DshAdapter({
    home: tempDir('home'),
    entry: FAKE_DSH,
    env: { FAKE_DSH_MODE: 'acp' },
    streamTap: false,
    disposeTimeouts: { stdinEofMs: 400, sigtermMs: 400, sigkillMs: 400 },
    restart: { maxRestarts: 0 },
    logger: { warn: (message) => void warnings.push(message) },
    ...options,
  });
  cleanups.push(() => adapter.dispose());
  const cwd = tempDir('ws');
  return { adapter, warnings, cwd };
}

interface FakeRecord {
  argv: string[];
  env: Record<string, string>;
  received: Array<{ method?: string; params?: Record<string, unknown> }>;
}

/** 当前（最近一个）假 dsh 进程的记录。每个进程启动时重写这个文件。 */
function fakeRecord(adapter: DshAdapter): FakeRecord {
  return JSON.parse(readFileSync(join(adapter.process.paths.dshHome, 'fake-dsh.json'), 'utf8'));
}

function sent(adapter: DshAdapter, method: string) {
  return fakeRecord(adapter)
    .received.filter((m) => m.method === method)
    .map((m) => m.params);
}

/** DSH_HOME 下除假 dsh 自己的记录（它把收到的环境写进 fake-dsh.json）以外的全部文件内容。 */
function dshHomeFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .map((name) => join(dir, name))
    .filter((file) => statSync(file).isFile() && !file.endsWith('fake-dsh.json'))
    .map((file) => readFileSync(file, 'utf8'));
}

async function untilTerminal(events: AsyncIterator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for (;;) {
    const { value, done } = await events.next();
    if (done) return out;
    out.push(value);
    if (isTurnTerminal(value)) return out;
  }
}

async function errorCode(promise: Promise<unknown>): Promise<unknown> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  return isAdapterError(error) ? error.code : error;
}

describe('DshAdapter：Provider 配置', () => {
  it('overlay 以 --patch 传入、只含变量名；Key 只在子进程环境里', async () => {
    const { adapter, cwd } = setup({ providers: [deepseek, gateway()] });
    await adapter.createSession({ cwd, providerId: 'my-gateway', modelId: 'model-a' });

    const overlay = providerOverlayPath(adapter.process.paths);
    const record = fakeRecord(adapter);
    expect(record.argv).toEqual(['--profile', 'acp', '--patch', overlay]);
    expect(record.env.WEVIR_PROVIDER_MY_GATEWAY_KEY).toBe(KEY);
    expect(record.env.WEVIR_PROVIDER_DEEPSEEK_OFFICIAL_KEY).toBe(`${KEY}-deepseek`);
    expect(record.env.FAKE_DSH_MODE).toBe('acp');

    const content = readFileSync(overlay, 'utf8');
    expect(content).toContain('"apiKeyEnv": "WEVIR_PROVIDER_MY_GATEWAY_KEY"');
    expect(content).not.toContain(KEY);
    for (const file of dshHomeFiles(adapter.process.paths.dshHome)) expect(file).not.toContain(KEY);
  });

  it('调用方的 patches 排在 Provider overlay 之后（同 id 的条目由它们覆盖）', async () => {
    const { adapter, cwd } = setup({ providers: [gateway()], patches: ['/tmp/extra.yml'] });
    await adapter.createSession({ cwd, providerId: 'my-gateway', modelId: 'model-a' });
    expect(fakeRecord(adapter).argv).toEqual([
      '--profile',
      'acp',
      '--patch',
      providerOverlayPath(adapter.process.paths),
      '--patch',
      '/tmp/extra.yml',
    ]);
  });

  it('没配置过 Provider 时不传 Provider overlay', async () => {
    const { adapter, cwd } = setup();
    await adapter.createSession({ cwd, providerId: 'wevir-test', modelId: 'wevir-mock' });
    expect(fakeRecord(adapter).argv).toEqual(['--profile', 'acp']);
  });

  it('不合法的 Provider：configureProviders 报 invalid_input，什么都不改', async () => {
    const { adapter } = setup({ providers: [gateway()] });
    const before = readFileSync(providerOverlayPath(adapter.process.paths), 'utf8');
    expect(
      await errorCode(adapter.configureProviders([gateway({ api: 'anthropic-messages' })])),
    ).toBe('invalid_input');
    expect(readFileSync(providerOverlayPath(adapter.process.paths), 'utf8')).toBe(before);
  });

  it('validateProvider 与 provider-config 的检查相同', () => {
    const { adapter } = setup();
    expect(adapter.validateProvider(gateway())).toEqual([]);
    expect(adapter.validateProvider(gateway({ id: 'deepseek-official' }))[0]?.path).toEqual(['id']);
  });
});

describe('DshAdapter：会话的路由', () => {
  it('session/new 之后用 set_config_option 选定 Provider 与模型（值是 dsh 的 [provider, model] 编码）', async () => {
    const { adapter, cwd } = setup({ providers: [gateway()] });
    const session = await adapter.createSession({
      cwd,
      providerId: 'my-gateway',
      modelId: 'model-b',
    });
    expect(sent(adapter, 'session/set_config_option')).toEqual([
      { sessionId: session.engineSessionId, configId: 'model', value: '["my-gateway","model-b"]' },
    ]);
    expect(session.modelId).toBe('model-b');
  });

  it('已是所要的路由时不再设置；给了不同的推理强度时设置 reasoning_effort', async () => {
    const { adapter, cwd } = setup();
    await adapter.createSession({ cwd, providerId: 'wevir-test', modelId: 'wevir-mock' });
    expect(sent(adapter, 'session/set_config_option')).toEqual([]);
    const session = await adapter.createSession({
      cwd,
      providerId: 'wevir-test',
      modelId: 'wevir-mock',
      reasoningEffort: 'max',
    });
    expect(sent(adapter, 'session/set_config_option')).toEqual([
      { sessionId: session.engineSessionId, configId: 'reasoning_effort', value: 'max' },
    ]);
    expect(session.reasoningEffort).toBe('max');
  });

  it('dsh 选不上（没有这个模型）：报 invalid_input，引擎侧的会话关掉，不留给 Host', async () => {
    const { adapter, cwd } = setup({ providers: [gateway()] });
    const error = await adapter
      .createSession({ cwd, providerId: 'my-gateway', modelId: 'missing-model' })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(isAdapterError(error, 'invalid_input')).toBe(true);
    expect((error as Error).message).toContain('missing-model');
    expect(sent(adapter, 'session/close')).toEqual([{ sessionId: 'fake-1' }]);
    expect(adapter.sessionCount).toBe(0);
  });
});

describe('DshAdapter：Provider 变更的生效', () => {
  it('dsh 还没启动：只改配置，不启动进程；第一次启动就用新配置', async () => {
    const { adapter, cwd } = setup({ providers: [gateway()] });
    await adapter.configureProviders([gateway({ apiKey: `${KEY}-v2` })]);
    expect(adapter.process.generation).toBe(0);
    await adapter.createSession({ cwd, providerId: 'my-gateway', modelId: 'model-a' });
    expect(adapter.process.generation).toBe(1);
    expect(fakeRecord(adapter).env.WEVIR_PROVIDER_MY_GATEWAY_KEY).toBe(`${KEY}-v2`);
  });

  it('没有回合：立即重启，挂着的会话以 engine.exited（config_changed）脱开，新进程用新 Key', async () => {
    const { adapter, cwd } = setup({ providers: [gateway()] });
    const { engineSessionId } = await adapter.createSession({
      cwd,
      providerId: 'my-gateway',
      modelId: 'model-a',
    });
    const events = adapter.subscribe(engineSessionId)[Symbol.asyncIterator]();

    await adapter.configureProviders([gateway({ apiKey: `${KEY}-v2` }), deepseek]);
    expect(adapter.process.generation).toBe(2);
    expect(adapter.process.state).toBe('ready');
    expect(adapter.process.launchConfigStale).toBe(false);
    expect((await events.next()).value).toEqual({
      type: 'engine.exited',
      engineSessionId,
      exitCode: null,
      signal: null,
      reason: 'config_changed',
    });
    expect((await events.next()).done).toBe(true);
    expect(
      await errorCode(adapter.send(engineSessionId, { content: [{ type: 'text', text: 'x' }] })),
    ).toBe('session_closed');
    const env = fakeRecord(adapter).env;
    expect(env.WEVIR_PROVIDER_MY_GATEWAY_KEY).toBe(`${KEY}-v2`);
    expect(env.WEVIR_PROVIDER_DEEPSEEK_OFFICIAL_KEY).toBe(`${KEY}-deepseek`);

    // 新会话照常建在新进程上。
    await adapter.createSession({
      cwd,
      providerId: 'deepseek-official',
      modelId: 'deepseek-flash',
    });
  });

  it('有回合在跑：不打断，等回合结束再重启', async () => {
    const { adapter, cwd } = setup({ providers: [gateway()] });
    const { engineSessionId } = await adapter.createSession({
      cwd,
      providerId: 'my-gateway',
      modelId: 'model-a',
    });
    const events = adapter.subscribe(engineSessionId)[Symbol.asyncIterator]();
    await adapter.send(engineSessionId, { content: [{ type: 'text', text: 'hang 请开始' }] });

    await adapter.configureProviders([gateway({ apiKey: `${KEY}-v2` })]);
    expect(adapter.process.generation).toBe(1);
    expect(adapter.process.launchConfigStale).toBe(true);

    await adapter.cancel(engineSessionId);
    const turn = await untilTerminal(events);
    expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'cancelled' });
    // 回合结束后重启：会话随即以 config_changed 脱开。
    expect((await events.next()).value).toMatchObject({
      type: 'engine.exited',
      reason: 'config_changed',
    });
    await adapter.createSession({ cwd, providerId: 'my-gateway', modelId: 'model-a' });
    expect(adapter.process.generation).toBe(2);
    expect(fakeRecord(adapter).env.WEVIR_PROVIDER_MY_GATEWAY_KEY).toBe(`${KEY}-v2`);
  });
});
