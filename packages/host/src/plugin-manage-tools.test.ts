// 安装之后的插件管理（`wevir_plugins_browse` / `wevir_plugins_manage`）：开关、移除、改连接器与输入项、从市场安装、从别的应用导入、
// 发起 OAuth 登录。echo 引擎声明能挂应用级工具，按 MCP 直接调 Host 的端点；市场用本地的假镜像与测试密钥签名的索引，不连真实仓库。

import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import type { HostId, SessionId, WevirMarketIndex } from '@wevir/protocol';
import type { AppToolsEndpoint, EngineSession, SessionConfig } from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppMcpServer } from './app-mcp.js';
import { AppTools, engineSessionResolver } from './app-tools.js';
import { EventStore } from './event-store.js';
import { ExternalImport } from './external-import/service.js';
import { MarketService } from './market/service.js';
import { MemoryStore } from './memory.js';
import { PluginRegistry } from './plugins.js';
import { SessionManager } from './session-manager.js';
import { identity, useStorages, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const storages = useStorages();
const T0 = '2026-10-29T00:00:00.000Z';
const SECRET = 'sk-test-value-0123456789';
const cleanups: Array<() => Promise<void>> = [];
// biome-ignore lint/suspicious/noExplicitAny: 测试里读任意形状的工具结果。
type Json = Record<string, any>;
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

class ToolEcho extends EchoAdapter {
  readonly appTools = true;
  readonly endpoints = new Map<string, AppToolsEndpoint | undefined>();

  override async createSession(config: SessionConfig): Promise<EngineSession> {
    const session = await super.createSession(config);
    this.endpoints.set(session.engineSessionId, config.appTools);
    return session;
  }
}

// ── 假市场：三个镜像都回同一份用测试私钥签名的索引与条目文件 ──
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const manifest = (version: string) =>
  Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      id: 'notes',
      name: 'Notes',
      version,
      connectors: {
        notes: {
          transport: 'stdio',
          command: 'node',
          args: ['server.js'],
          // biome-ignore lint/suspicious/noTemplateCurlyInString: 插件清单的字面占位符
          env: { NOTES_TOKEN: '${input:TOKEN}' },
        },
      },
      inputs: [{ key: 'TOKEN', label: 'Token', secret: true, required: true }],
    }),
  );
const skillFile = Buffer.from('---\nname: pdf\ndescription: Read PDFs\n---\n\nUse it.\n');

function marketFixture() {
  let version = '1.0.0';
  const repo = (): Record<string, Buffer> => ({
    'plugins/notes/wevir-plugin.json': manifest(version),
    'plugins/notes/server.js': Buffer.from('console.log("notes")\n'),
    'skills/pdf/SKILL.md': skillFile,
  });
  const entry = (id: string, kind: 'plugin' | 'skill', path: string) => {
    const files = Object.entries(repo())
      .filter(([file]) => file.startsWith(`${path}/`))
      .map(([file, bytes]) => ({
        path: file.slice(path.length + 1),
        size: bytes.length,
        sha256: sha(bytes),
      }));
    return {
      id,
      kind,
      path,
      name: id === 'notes' ? 'Notes' : 'PDF',
      version: id === 'notes' ? version : '1.0.0',
      description: id === 'notes' ? 'Keep notes' : 'Read PDF files',
      category: 'productivity',
      listedAt: T0,
      verification: { level: 'official', since: '2026-10' },
      contents:
        id === 'notes'
          ? {
              connectors: [
                { name: 'notes', transport: 'stdio', command: 'node', args: ['server.js'] },
              ],
              skills: [],
              inputs: [{ key: 'TOKEN', label: 'Token', secret: true, required: true }],
            }
          : { connectors: [], skills: [{ name: 'pdf', description: 'Read PDFs' }], inputs: [] },
      files,
      digest: 'c'.repeat(64),
    };
  };
  let sequence = 1;
  const index = (): WevirMarketIndex =>
    ({
      schemaVersion: 1,
      name: 'Wevir',
      generatedAt: T0,
      sequence,
      commit: 'a'.repeat(40),
      categories: [],
      featured: [],
      entries: [entry('notes', 'plugin', 'plugins/notes'), entry('pdf', 'skill', 'skills/pdf')],
    }) as WevirMarketIndex;
  const fake = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.startsWith('/dist/')) {
      const body = Buffer.from(JSON.stringify(index()));
      if (url.pathname.endsWith('/index.json')) return new Response(body);
      return new Response(`${sign(null, body, privateKey).toString('base64')}\n`);
    }
    const body = repo()[url.pathname.split('/').slice(2).join('/')];
    return body === undefined
      ? new Response('no', { status: 404 })
      : new Response(new Uint8Array(body));
  }) as typeof fetch;
  const mirror = (host: string) => (ref: string, path: string) => `https://${host}/${ref}/${path}`;
  return {
    options: {
      fetch: fake,
      publicKeys: [publicKey.export({ type: 'spki', format: 'der' }).toString('base64')],
      mirrors: { github: mirror('github'), cnb: mirror('cnb'), gitee: mirror('gitee') },
    },
    /** 发布新版本：之后 `refresh` 读到的索引与文件是它。 */
    publish(next: string) {
      version = next;
      sequence += 1;
    },
  };
}

function put(path: string, text: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

async function setup() {
  const root = realpathSync(tempDir());
  const storage = storages.open(join(root, 'data'));
  const workspace = join(root, 'project');
  const userHome = join(root, 'user');
  mkdirSync(workspace);
  storage.workspaces.insert({
    id: 'ws_1',
    rootPath: workspace,
    displayName: 'project',
    createdAt: T0,
    updatedAt: T0,
  });
  storage.providers.insert({
    id: 'mock',
    kind: 'openai-compatible',
    displayName: 'Mock',
    api: 'openai-completions',
    baseURL: 'http://127.0.0.1:9/v1',
    models: [{ id: 'm' }],
    defaultModelId: 'm',
    createdAt: T0,
    updatedAt: T0,
  });
  const errors: unknown[] = [];
  const events = new EventStore({ storage, deltaWindowMs: 5, onError: (e) => errors.push(e) });
  const adapter = new ToolEcho({ stepDelayMs: 500 });
  let tools: AppTools | undefined;
  let mcp: AppMcpServer | undefined;
  const manager = new SessionManager({
    storage,
    events,
    adapter,
    onError: (e) => errors.push(e),
    appTools: {
      grant: (sessionId) => mcp?.grant(sessionId),
      prepareEvent: (sessionId, event) =>
        tools?.plugins?.prepareEvent(sessionId, event) ?? Promise.resolve(event),
      resolved: (sessionId, toolCallId, approved) =>
        tools?.plugins?.resolved(sessionId, toolCallId, approved),
      dispose: () => tools?.plugins?.close(),
    },
    onTurnFinished: (info) => tools?.onTurnFinished(info),
  });
  const plugins = new PluginRegistry({
    home: join(root, 'data'),
    userHome,
    roots: () => [workspace],
    adapter,
  });
  await plugins.load();
  const fixture = marketFixture();
  const market = new MarketService({
    dir: join(root, 'data', 'plugins', 'market', 'official'),
    preference: () => 'github',
    ...fixture.options,
  });
  const importer = new ExternalImport({
    userHome,
    env: {},
    workspaces: {
      list: () => storage.workspaces.list(),
      get: (id) => storage.workspaces.get(id),
    },
    memory: new MemoryStore({ dir: join(root, 'data', 'memory') }),
    plugins,
  });
  const logins: unknown[] = [];
  tools = new AppTools({
    plugins,
    pluginServices: {
      market,
      importer,
      oauth: {
        login: async (ref) => {
          logins.push(ref);
          return {
            loginId: 'login_1',
            authUrl: 'https://auth.example.test/authorize?state=abc&client_id=wevir',
          };
        },
      },
    },
    storage,
    events,
    sessions: manager,
    hostId: 'host_test' as HostId,
    sendWhileBusy: () => 'queue',
  });
  const appTools = tools;
  mcp = new AppMcpServer({
    tools: tools.tools,
    filterTools: (sessionId, list) => appTools.filterTools(sessionId, list),
    instructions: (sessionId) => appTools.instructions(sessionId),
    version: '0.0.0',
    onError: (e) => errors.push(e),
    engineSession: engineSessionResolver(storage, 'echo'),
  });
  const appMcp = mcp;
  const http: Server = createServer((req, res) => {
    if (!appMcp.handle(req, res)) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as AddressInfo).port;
  appMcp.setPort(port);
  cleanups.push(async () => {
    appMcp.close();
    await manager.dispose();
    await adapter.dispose();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });

  /** 有进行中回合的会话（插件改动要在回合里）。 */
  const active = async () => {
    const id = (
      await manager.create({
        workspaceId: 'ws_1',
        providerId: 'mock',
        permissionMode: 'full_access',
      })
    ).id;
    await manager.send({ sessionId: id, content: [{ type: 'text', text: 'slow' }] }, identity);
    return id;
  };
  let nextId = 0;
  /** 调工具，返回 `structuredContent`；`isError` 时返回错误文本。 */
  const call = async (
    sessionId: SessionId,
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<Json> => {
    nextId += 1;
    const record = storage.sessions.get(sessionId);
    const token = record && adapter.endpoints.get(record.engineSessionId)?.token;
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: nextId,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    const result = ((await response.json()) as Json).result;
    if (result.isError) return { error: result.content[0]?.text ?? '' };
    return result.structuredContent ?? {};
  };
  const pending = async (id: SessionId) => {
    await vi.waitFor(() => expect(events.snapshot(id)?.pendingApprovals).toHaveLength(1));
    const approval = events.snapshot(id)?.pendingApprovals[0];
    if (!approval) throw new Error('missing approval');
    return approval;
  };
  const decide = async (id: SessionId, allow: boolean) => {
    const approval = await pending(id);
    await manager.respondToApproval(
      { approvalId: approval.id, optionId: allow ? 'allow' : 'deny' },
      identity,
    );
    return approval;
  };
  /** 调一个要批准的动作：返回卡片上的摘要与结果。 */
  const approved = async (
    id: SessionId,
    args: Record<string, unknown>,
    allow = true,
  ): Promise<{ summary: string; result: Json }> => {
    const operation = call(id, 'wevir_plugins_manage', args);
    const approval = await decide(id, allow);
    return { summary: approval.detail?.display.summary ?? '', result: await operation };
  };
  const noStage = () =>
    vi.waitFor(() => {
      expect(readdirSync(plugins.dir).filter((name) => name.startsWith('.install-'))).toEqual([]);
    });
  return {
    storage,
    events,
    plugins,
    fixture,
    userHome,
    workspace,
    logins,
    errors,
    active,
    call,
    approved,
    noStage,
  };
}

describe('插件管理：市场', () => {
  it('搜索列出条目、认证与是否已装；装之前用户看到包的真实内容，缺必填输入项先问', async () => {
    const h = await setup();
    const id = await h.active();
    const all = await h.call(id, 'wevir_plugins_browse', { source: 'market' });
    expect(all.total).toBe(2);
    const found = await h.call(id, 'wevir_plugins_browse', { source: 'market', query: 'PDF read' });
    expect(found.entries).toEqual([
      expect.objectContaining({
        id: 'pdf',
        kind: 'skill',
        skills: ['pdf'],
        verification: { level: 'official' },
      }),
    ]);
    expect(found.entries[0]).not.toHaveProperty('installed');

    const missing = await h.call(id, 'wevir_plugins_manage', {
      action: 'market_install',
      id: 'notes',
    });
    expect(missing.error).toContain('Missing required plugin inputs: TOKEN');
    expect(
      await h.call(id, 'wevir_plugins_manage', { action: 'market_install', id: 'nope' }),
    ).toMatchObject({ error: expect.stringContaining('No market entry "nope"') });

    const denied = await h.approved(
      id,
      { action: 'market_install', id: 'notes', inputs: { TOKEN: SECRET } },
      false,
    );
    expect(denied.summary).toContain('"command": "node"');
    expect(denied.summary).toContain('"entry": "notes"');
    expect(denied.summary).not.toContain(SECRET);
    expect(denied.result.error).toContain('denied');
    expect((await h.plugins.list()).plugins).toEqual([]);

    const done = await h.approved(id, {
      action: 'market_install',
      id: 'notes',
      inputs: { TOKEN: SECRET },
    });
    expect(done.result).toMatchObject({ plugin: { id: 'notes', version: '1.0.0', enabled: true } });
    expect(JSON.stringify(done.result)).not.toContain(SECRET);
    const listed = await h.call(id, 'wevir_plugins_browse', { source: 'market', query: 'notes' });
    expect(listed.entries[0].installed).toEqual({ version: '1.0.0', enabled: true });
    await h.noStage();
    expect(h.errors).toEqual([]);
  });

  it('已装的要 replace 才升级，保留填过的输入项', async () => {
    const h = await setup();
    const id = await h.active();
    await h.approved(id, { action: 'market_install', id: 'notes', inputs: { TOKEN: SECRET } });
    h.fixture.publish('1.1.0');
    await h.call(id, 'wevir_plugins_browse', { source: 'market', refresh: true });
    expect(
      await h.call(id, 'wevir_plugins_manage', { action: 'market_install', id: 'notes' }),
    ).toMatchObject({ error: expect.stringContaining('pass replace to upgrade it to 1.1.0') });
    const upgraded = await h.approved(id, { action: 'market_install', id: 'notes', replace: true });
    expect(upgraded.summary).toContain('"replaces": "1.0.0"');
    expect(upgraded.result).toMatchObject({ plugin: { version: '1.1.0' } });
    const [plugin] = (await h.plugins.list()).plugins ?? [];
    expect(plugin?.inputs).toEqual([expect.objectContaining({ key: 'TOKEN', set: true })]);
    await h.noStage();
  });
});

describe('插件管理：开关、输入项、改连接器、移除', () => {
  it('开关不另外请批准；输入项与连接器的改动要批准，摘要与结果都不带密钥值', async () => {
    const h = await setup();
    const id = await h.active();
    await h.approved(id, { action: 'market_install', id: 'notes', inputs: { TOKEN: SECRET } });

    expect(
      await h.call(id, 'wevir_plugins_manage', { action: 'disable', kind: 'plugin', id: 'Notes' }),
    ).toMatchObject({ plugin: { id: 'notes', enabled: false } });
    expect(
      await h.call(id, 'wevir_plugins_manage', { action: 'enable', kind: 'plugin', id: 'notes' }),
    ).toMatchObject({ plugin: { enabled: true } });

    const other = 'sk-other-value-987654321';
    const inputs = await h.approved(id, {
      action: 'set_inputs',
      id: 'notes',
      inputs: { TOKEN: other },
    });
    expect(inputs.summary).toContain('"TOKEN": "set"');
    expect(inputs.summary + JSON.stringify(inputs.result)).not.toContain(other);
    expect(
      await h.call(id, 'wevir_plugins_manage', {
        action: 'set_inputs',
        id: 'notes',
        inputs: { NOPE: 'x' },
      }),
    ).toMatchObject({ error: expect.stringContaining('Undeclared plugin inputs: NOPE') });

    await h.plugins.add('docs', { transport: 'stdio', command: 'docs-mcp' });
    const update = await h.approved(id, {
      action: 'update',
      id: 'docs',
      name: 'docs_two',
      config: { env: { DOCS_KEY: SECRET }, args: ['--verbose'] },
    });
    expect(update.summary).toContain('"DOCS_KEY": "set"');
    expect(update.summary).toContain('"rename": "docs_two"');
    expect(update.summary + JSON.stringify(update.result)).not.toContain(SECRET);
    expect(update.result).toMatchObject({
      connector: { name: 'docs_two', config: { args: ['--verbose'], env: { DOCS_KEY: true } } },
    });
    expect(
      await h.call(id, 'wevir_plugins_manage', {
        action: 'update',
        id: 'docs_two',
        config: { url: 'not a url' },
      }),
    ).toHaveProperty('error');
    expect(h.errors).toEqual([]);
  }, 30_000);

  it('移除要批准，拒绝时不动；插件的摘要列出一起删掉的连接器', async () => {
    const h = await setup();
    const id = await h.active();
    await h.approved(id, { action: 'market_install', id: 'notes', inputs: { TOKEN: SECRET } });
    await h.plugins.add('docs', { transport: 'stdio', command: 'docs-mcp' });

    const kept = await h.approved(id, { action: 'remove', kind: 'connector', id: 'docs' }, false);
    expect(kept.result.error).toContain('denied');
    expect((await h.plugins.list()).connectors.map((item) => item.name)).toContain('docs');

    const plugin = await h.approved(id, { action: 'remove', kind: 'plugin', id: 'notes' });
    expect(plugin.summary).toContain('notes_notes');
    expect(plugin.result).toMatchObject({ removed: { kind: 'plugin', id: 'notes' } });
    await h.approved(id, { action: 'remove', kind: 'connector', id: 'docs' });
    const list = await h.plugins.list();
    expect(list.plugins).toEqual([]);
    expect(list.connectors).toEqual([]);
    expect(
      await h.call(id, 'wevir_plugins_manage', { action: 'remove', kind: 'skill', id: 'gone' }),
    ).toMatchObject({ error: expect.stringContaining('No skill "gone"') });
  });
});

describe('插件管理：导入与登录', () => {
  it('扫描不问；导入要批准，只认扫描出的 key，带问题的拒绝', async () => {
    const h = await setup();
    const id = await h.active();
    put(
      join(h.userHome, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          github: { command: 'gh-mcp', env: { GITHUB_TOKEN: SECRET } },
          leaky: { command: 'srv', args: ['--api-key', 'abcdef123456'] },
        },
      }),
    );
    put(
      join(h.userHome, '.claude', 'skills', 'alpha', 'SKILL.md'),
      '---\nname: alpha\ndescription: Alpha skill\n---\nBody\n',
    );
    const scan = await h.call(id, 'wevir_plugins_browse', { source: 'claude' });
    expect(JSON.stringify(scan)).not.toContain(SECRET);
    expect(scan.connectors.map((item: { name: string }) => item.name)).toEqual(['github', 'leaky']);
    const github = scan.connectors[0].key;
    const leaky = scan.connectors[1].key;
    const alpha = scan.skills.find((item: { name: string }) => item.name === 'alpha')?.key;

    expect(
      await h.call(id, 'wevir_plugins_manage', {
        action: 'import',
        app: 'claude',
        items: [{ key: 'missing' }],
      }),
    ).toMatchObject({ error: expect.stringContaining('Unknown import keys: missing') });
    expect(
      await h.call(id, 'wevir_plugins_manage', {
        action: 'import',
        app: 'claude',
        items: [{ key: leaky }],
      }),
    ).toMatchObject({ error: expect.stringContaining('looks_secret') });

    const imported = await h.approved(id, {
      action: 'import',
      app: 'claude',
      items: [{ key: github }, { key: alpha }],
    });
    expect(imported.summary).toContain('"command": "gh-mcp"');
    expect(imported.summary).toContain('Alpha skill');
    expect(imported.summary).not.toContain(SECRET);
    expect(imported.result.results).toEqual([
      expect.objectContaining({ outcome: 'imported', kind: 'connector', name: 'github' }),
      expect.objectContaining({ outcome: 'imported', kind: 'skill', name: 'alpha' }),
    ]);
  });

  it('登录只交出登录链接；不用 OAuth 的连接器回原因并指向插件页', async () => {
    const h = await setup();
    const id = await h.active();
    await h.plugins.add('remote', { transport: 'http', url: 'https://mcp.example.test/mcp' });
    await h.plugins.add('local', { transport: 'stdio', command: 'local-mcp' });
    const started = await h.call(id, 'wevir_plugins_manage', { action: 'sign_in', id: 'remote' });
    expect(started).toMatchObject({
      status: 'signing_in',
      signInUrl: 'https://auth.example.test/authorize?state=abc&client_id=wevir',
      next: expect.stringContaining('wevir_plugins_list'),
    });
    expect(h.logins).toEqual([{ name: 'remote' }]);
    const local = await h.call(id, 'wevir_plugins_manage', { action: 'sign_in', id: 'local' });
    expect(local.error).toContain('does not use OAuth');
    expect(local.error).toContain('Plugins page');
  });
});
