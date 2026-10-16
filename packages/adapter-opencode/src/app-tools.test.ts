// 应用级工具（opencode-event-mapping.md §4.4）：生成的插件（在 Node 里加载，Host 是一个记请求的假端点）、配置里的那一项、服务器
// 挂上插件与换掉没挂上的那个、工具名。真实 opencode 上的一次调用在 opencode-adapter.contract.real.integration.test.ts。

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_TOOLS_NO_APPROVAL } from '@wevir/runtime-adapter';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  appToolsPluginEntry,
  engineToolName,
  PLUGIN_DIRECTORY,
  writeAppToolsPlugin,
  zodModuleUrl,
} from './app-tools.js';
import { OpenCodeTurnMapper } from './mapping.js';
import { openCodeEngineDir } from './opencode-adapter.js';
import { serverConfigContent } from './permissions.js';
import { type FakeHarness, fakeHarness } from './test-fixtures/harness.js';

const dirs: string[] = [];
const servers: Server[] = [];
let harness: FakeHarness | undefined;
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wevir-opencode-app-tools-'));
  dirs.push(dir);
  return dir;
}

const TOOLS = [
  {
    name: 'wevir_session_list',
    title: 'List Wevir sessions',
    description: 'List sessions.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['project', 'all'] },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
        query: { type: 'string', description: 'Only titles containing these words.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'wevir_session_create',
    title: 'Create a Wevir session',
    description: 'Open a new session.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        reportBack: { type: 'boolean' },
        worktree: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
      required: ['prompt'],
    },
  },
];

interface Received {
  headers: IncomingMessage['headers'];
  body: { method: string; params: { name?: string; arguments?: unknown } };
}

/** 假的 Host 端点：tools/list 回 TOOLS；tools/call 按 `reply` 回答；认不出的会话回 404。 */
async function fakeHost(
  reply: (name: string, args: unknown) => unknown = () => ({
    content: [{ type: 'text', text: '{"ok":true}' }],
    structuredContent: { ok: true },
  }),
) {
  const received: Received[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    received.push({ headers: req.headers, body });
    if (req.headers['x-wevir-engine-session'] === 'ses_stranger') {
      res.writeHead(404).end('404');
      return;
    }
    const result =
      body.method === 'tools/list'
        ? { tools: TOOLS }
        : reply(body.params.name as string, body.params.arguments);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  return { url, received };
}

type PluginTool = {
  description: string;
  args: Record<string, z.ZodType>;
  execute(args: unknown, context: unknown): Promise<{ title: string; output: string }>;
};

/** 写插件再在 Node 里加载它，照 opencode 调它（`input` 用不到）。 */
async function loadPlugin(options: unknown): Promise<{ tool?: Record<string, PluginTool> }> {
  const url = writeAppToolsPlugin(tempDir());
  const module = (await import(url)) as Record<string, unknown>;
  // opencode 把模块导出的每个函数都当成插件：只能有默认导出。
  expect(Object.keys(module)).toEqual(['default']);
  const plugin = module.default as (input: unknown, options: unknown) => Promise<unknown>;
  return (await plugin({}, options)) as { tool?: Record<string, PluginTool> };
}

function context(sessionID: string, ask: (input: unknown) => Promise<void> = async () => {}) {
  const asked: unknown[] = [];
  return {
    asked,
    value: {
      sessionID,
      messageID: 'msg_1',
      agent: 'build',
      directory: '/tmp',
      worktree: '/tmp',
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async (input: unknown) => {
        asked.push(input);
        await ask(input);
      },
    },
  };
}

describe('插件文件', () => {
  it('按内容的摘要命名，内容不变不重写；zod 按绝对地址 import，没有令牌', () => {
    const engineDir = tempDir();
    const url = writeAppToolsPlugin(engineDir);
    const file = fileURLToPath(url);
    expect(file.startsWith(join(engineDir, PLUGIN_DIRECTORY, 'wevir-app-tools-'))).toBe(true);
    expect(file.endsWith('.mjs')).toBe(true);
    const source = readFileSync(file, 'utf8');
    expect(source).toContain(`import { z } from ${JSON.stringify(zodModuleUrl())};`);
    expect(zodModuleUrl().startsWith('file://')).toBe(true);
    expect(existsSync(fileURLToPath(zodModuleUrl()))).toBe(true);
    expect(source).toContain('SPDX-License-Identifier: Apache-2.0');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    const mtime = statSync(file).mtimeMs;
    expect(writeAppToolsPlugin(engineDir)).toBe(url);
    expect(statSync(file).mtimeMs).toBe(mtime);
    expect(readdirSync(join(engineDir, PLUGIN_DIRECTORY))).toHaveLength(1);
    // zod 的地址变了（Wevir 升级）就是另一个文件。
    expect(writeAppToolsPlugin(engineDir, 'file:///elsewhere/zod/index.js')).not.toBe(url);
  });

  it('配置里的那一项：地址、引擎令牌与不经审批的工具', () => {
    expect(
      appToolsPluginEntry('file:///p.mjs', { url: 'http://127.0.0.1:1/mcp', token: 't' }),
    ).toEqual([
      'file:///p.mjs',
      { url: 'http://127.0.0.1:1/mcp', token: 't', noApproval: [...APP_TOOLS_NO_APPROVAL] },
    ]);
  });

  it('并进 OPENCODE_CONFIG_CONTENT：留着用户的插件，换掉以前的 Wevir 插件', () => {
    const entry = appToolsPluginEntry('file:///data/plugins/wevir-app-tools-new.mjs', {
      url: 'http://127.0.0.1:1/mcp',
      token: 't',
    });
    const merged = JSON.parse(
      serverConfigContent(
        JSON.stringify({
          plugin: ['my-plugin', ['file:///old/plugins/wevir-app-tools-old.mjs', { token: 'x' }]],
        }),
        entry,
      ),
    );
    expect(merged.plugin).toEqual(['my-plugin', entry]);
    expect(merged.permission).toMatchObject({ bash: 'ask' });
    expect(JSON.parse(serverConfigContent(undefined, entry)).plugin).toEqual([entry]);
    // 没有应用级工具时不加，用户的照留。
    expect(JSON.parse(serverConfigContent('{"plugin":["my-plugin"]}')).plugin).toEqual([
      'my-plugin',
    ]);
    expect(JSON.parse(serverConfigContent(undefined)).plugin).toBeUndefined();
  });
});

describe('插件', () => {
  it('启动时列出 Host 的工具，参数是 zod 的 shape（必填与可选照 JSON Schema）', async () => {
    const host = await fakeHost();
    const hooks = await loadPlugin({ url: host.url, token: 'engine-token', noApproval: [] });
    expect(Object.keys(hooks.tool ?? {})).toEqual(['wevir_session_list', 'wevir_session_create']);
    expect(host.received[0]?.headers.authorization).toBe('Bearer engine-token');
    expect(host.received[0]?.headers['x-wevir-engine-session']).toBeUndefined();
    const list = z.object(hooks.tool?.wevir_session_list?.args ?? {});
    expect(list.safeParse({}).success).toBe(true);
    expect(list.safeParse({ scope: 'all', limit: 3 }).success).toBe(true);
    expect(list.safeParse({ scope: 'other' }).success).toBe(false);
    expect(list.safeParse({ limit: 1.5 }).success).toBe(false);
    expect(z.toJSONSchema(list)).toMatchObject({
      properties: { query: { description: 'Only titles containing these words.' } },
    });
    const create = z.object(hooks.tool?.wevir_session_create?.args ?? {});
    expect(create.safeParse({}).success).toBe(false);
    expect(create.safeParse({ prompt: 'go', worktree: null }).success).toBe(true);
  });

  it('只读的工具不问，直接带引擎会话 ID 调 Host', async () => {
    const host = await fakeHost();
    const hooks = await loadPlugin({
      url: host.url,
      token: 'engine-token',
      noApproval: ['wevir_session_list'],
    });
    const ctx = context('ses_a');
    const result = await hooks.tool?.wevir_session_list?.execute({ scope: 'all' }, ctx.value);
    expect(ctx.asked).toEqual([]);
    expect(result).toMatchObject({ title: 'List Wevir sessions', output: '{"ok":true}' });
    const call = host.received.at(-1);
    expect(call?.headers['x-wevir-engine-session']).toBe('ses_a');
    expect(call?.headers.authorization).toBe('Bearer engine-token');
    expect(call?.body).toMatchObject({
      method: 'tools/call',
      params: { name: 'wevir_session_list', arguments: { scope: 'all' } },
    });
  });

  it('别的工具先经 opencode 的权限系统；拒绝了就不调 Host', async () => {
    const host = await fakeHost();
    const hooks = await loadPlugin({
      url: host.url,
      token: 'engine-token',
      noApproval: ['wevir_session_list'],
    });
    const allowed = context('ses_a');
    await hooks.tool?.wevir_session_create?.execute({ prompt: 'go' }, allowed.value);
    expect(allowed.asked).toEqual([
      {
        permission: 'wevir_session_create',
        patterns: ['*'],
        always: ['*'],
        metadata: { prompt: 'go' },
      },
    ]);
    const calls = host.received.length;
    const rejected = context('ses_a', async () => {
      throw new Error('The user rejected permission to use this specific tool call.');
    });
    await expect(
      hooks.tool?.wevir_session_create?.execute({ prompt: 'go' }, rejected.value),
    ).rejects.toThrow('rejected');
    expect(host.received).toHaveLength(calls);
  });

  it('工具报错时抛出原因；Host 认不出的会话、列不出工具', async () => {
    const host = await fakeHost(() => ({
      content: [{ type: 'text', text: 'Sessions you open cannot get broader permissions.' }],
      isError: true,
    }));
    const hooks = await loadPlugin({ url: host.url, token: 't', noApproval: [] });
    await expect(
      hooks.tool?.wevir_session_create?.execute({ prompt: 'go' }, context('ses_a').value),
    ).rejects.toThrow('broader permissions');
    await expect(
      hooks.tool?.wevir_session_create?.execute({ prompt: 'go' }, context('ses_stranger').value),
    ).rejects.toThrow('does not belong to Wevir');
    // Host 不在：不挂工具，插件照样加载。
    expect(await loadPlugin({ url: 'http://127.0.0.1:9/mcp', token: 't', noApproval: [] })).toEqual(
      {},
    );
    expect(await loadPlugin({})).toEqual({});
  });
});

describe('适配器', () => {
  it('声明 appTools；绑定引擎令牌后起的服务器挂上插件', async () => {
    harness = fakeHarness();
    const h = harness;
    expect(h.adapter.appTools).toBe(true);
    const asked: string[][] = [];
    h.adapter.bindEngineAppTools((kinds) => {
      asked.push([...kinds]);
      return { url: 'http://127.0.0.1:1/mcp', token: 'engine-token' };
    });
    await h.adapter.accounts.read('opencode');
    expect(asked.at(-1)).toEqual(['opencode']);
    const plugin = h.fake.startOptions.at(-1)?.appToolsPlugin;
    expect(plugin?.[1]).toEqual({
      url: 'http://127.0.0.1:1/mcp',
      token: 'engine-token',
      noApproval: [...APP_TOOLS_NO_APPROVAL],
    });
    const file = fileURLToPath(plugin?.[0] ?? '');
    expect(file.startsWith(join(openCodeEngineDir(h.home), PLUGIN_DIRECTORY))).toBe(true);
    expect(existsSync(file)).toBe(true);
  });

  it('Host 监听之前起的服务器没有插件：绑定后没人借用就换一个', async () => {
    harness = fakeHarness();
    const h = harness;
    await h.adapter.accounts.read('opencode');
    expect(h.fake.starts).toBe(1);
    expect(h.fake.startOptions[0]?.appToolsPlugin).toBeUndefined();
    h.adapter.bindEngineAppTools(() => ({ url: 'http://127.0.0.1:1/mcp', token: 't' }));
    await h.adapter.accounts.read('opencode', { refresh: true });
    expect(h.fake.starts).toBe(2);
    expect(h.fake.startOptions[1]?.appToolsPlugin?.[1]).toMatchObject({ token: 't' });
    // 已经挂上的不再换。
    await h.adapter.accounts.read('opencode', { refresh: true });
    expect(h.fake.starts).toBe(2);
  });

  it('Host 还给不出令牌时照常起，不挂插件', async () => {
    harness = fakeHarness();
    const h = harness;
    h.adapter.bindEngineAppTools(() => undefined);
    await h.adapter.accounts.read('opencode');
    expect(h.fake.startOptions[0]?.appToolsPlugin).toBeUndefined();
  });
});

describe('工具名', () => {
  it('插件的工具报成 mcp__wevir__…，别的原样', () => {
    expect(engineToolName('wevir_session_create')).toBe('mcp__wevir__wevir_session_create');
    expect(engineToolName('bash')).toBe('bash');
    expect(engineToolName('wevir')).toBe('wevir');
    const mapper = new OpenCodeTurnMapper('ses_1');
    const events = mapper.part({
      id: 'prt_1',
      sessionID: 'ses_1',
      messageID: 'msg_1',
      type: 'tool',
      callID: 'call_1',
      tool: 'wevir_session_list',
      state: { status: 'running', input: { scope: 'all' }, time: { start: 1 } },
    });
    expect(events).toMatchObject([
      { type: 'tool.started', toolName: 'mcp__wevir__wevir_session_list' },
    ]);
    expect(mapper.toolName('call_1')).toBe('mcp__wevir__wevir_session_list');
  });
});
