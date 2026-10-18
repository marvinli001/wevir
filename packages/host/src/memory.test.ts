// 跨会话记忆（memory.ts）与它的应用级工具（memory-tools.ts）。

import { mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { HostId, SessionId, WorkspaceId } from '@wevir/protocol';
import {
  APP_TOOLS_NO_APPROVAL,
  type EngineSession,
  type SessionConfig,
} from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it } from 'vitest';
import { AppMcpServer, AppToolError } from './app-mcp.js';
import { APP_TOOLS_INSTRUCTIONS, AppTools } from './app-tools.js';
import { EventStore } from './event-store.js';
import {
  MEMORY_CONTENT_MAX_BYTES,
  MEMORY_INDEX_MAX_BYTES,
  MEMORY_MAX_PER_SCOPE,
  MemoryError,
  MemoryStore,
} from './memory.js';
import { instructionsWithMemory, MEMORY_TOOLS, memoryTools } from './memory-tools.js';
import { SessionManager } from './session-manager.js';
import { SES, SES2, seedSession, T0, useStorages, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const storages = useStorages();
const SES_OTHER = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQT' as SessionId;

const note = (overrides: Partial<Parameters<MemoryStore['save']>[2]> = {}) => ({
  name: 'avoid-rm-f',
  type: 'feedback' as const,
  description: 'rm -f hides missing files; check first',
  content: 'Why: a typo deleted nothing and no error showed.\nHow to apply: use rm without -f.',
  ...overrides,
});

describe('MemoryStore', () => {
  it('保存、读回、覆盖、删除；frontmatter 文件落在 global/ 和 projects/<ID>/', async () => {
    const dir = join(tempDir(), 'memory');
    const store = new MemoryStore({ dir, now: () => new Date('2026-10-17T00:00:00.000Z') });
    const saved = await store.save('global', undefined, note());
    expect(saved.created).toBe(true);
    expect(readFileSync(join(dir, 'global', 'avoid-rm-f.md'), 'utf8')).toBe(
      [
        '---',
        'name: avoid-rm-f',
        'description: rm -f hides missing files; check first',
        'type: feedback',
        'updated: 2026-10-17T00:00:00.000Z',
        '---',
        '',
        'Why: a typo deleted nothing and no error showed.\nHow to apply: use rm without -f.',
        '',
      ].join('\n'),
    );
    await store.save('project', 'ws_1', note({ name: 'dev-server', type: 'project' }));
    expect(readdirSync(join(dir, 'projects', 'ws_1'))).toEqual(['dev-server.md']);

    const read = await store.read('global', undefined, 'avoid-rm-f');
    expect(read.content).toContain('use rm without -f');

    const again = await store.save('global', undefined, note({ content: 'new text' }));
    expect(again.created).toBe(false);
    expect((await store.read('global', undefined, 'avoid-rm-f')).content).toBe('new text');

    await store.delete('global', undefined, 'avoid-rm-f');
    await expect(store.read('global', undefined, 'avoid-rm-f')).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(store.delete('global', undefined, 'avoid-rm-f')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('列出全局和当前项目的，不含别的项目；最近更新的在前', async () => {
    let tick = 0;
    const store = new MemoryStore({
      dir: join(tempDir(), 'memory'),
      now: () => new Date(Date.UTC(2026, 9, 17, 0, 0, tick++)),
    });
    await store.save('global', undefined, note({ name: 'a-global' }));
    await store.save('project', 'ws_1', note({ name: 'b-mine' }));
    await store.save('project', 'ws_2', note({ name: 'c-other' }));
    const names = (await store.list('ws_1')).map((entry) => `${entry.scope}:${entry.name}`);
    expect(names).toEqual(['project:b-mine', 'global:a-global']);
    expect((await store.list()).map((entry) => entry.name)).toEqual(['a-global']);
    expect(await store.list('ws_1')).not.toContainEqual(
      expect.objectContaining({ content: expect.anything() }),
    );
  });

  it('拒绝：坏名字、类型、过长的说明与正文、密钥、没有项目的项目范围', async () => {
    const store = new MemoryStore({ dir: join(tempDir(), 'memory') });
    const invalid = (
      input: Parameters<MemoryStore['save']>[2],
      scope: 'global' | 'project' = 'global',
    ) => expect(store.save(scope, 'ws_1', input)).rejects.toMatchObject({ code: 'invalid' });
    await invalid(note({ name: '../escape' }));
    await invalid(note({ name: 'Upper' }));
    await invalid(note({ type: 'other' as never }));
    await invalid(note({ description: 'x'.repeat(201) }));
    await invalid(note({ description: '  ' }));
    await invalid(note({ content: ' ' }));
    await invalid(note({ content: 'x'.repeat(MEMORY_CONTENT_MAX_BYTES + 1) }));
    await invalid(note({ content: 'key sk-abcdefghijklmnopqrstuvwxyz0123' }));
    await invalid(note({ content: '-----BEGIN RSA PRIVATE KEY-----\nabc' }));
    await expect(store.save('project', undefined, note())).rejects.toMatchObject({
      code: 'no_project',
    });
    await expect(store.save('project', '../x', note())).rejects.toBeInstanceOf(MemoryError);
    expect(await store.list('ws_1')).toEqual([]);
  });

  it('说明里的换行折成一行；每个范围有条数上限，覆盖已有的不受限', async () => {
    const store = new MemoryStore({ dir: join(tempDir(), 'memory') });
    await store.save('global', undefined, note({ description: 'line one\nline two' }));
    expect((await store.list())[0]?.description).toBe('line one line two');
    for (let i = 1; i < MEMORY_MAX_PER_SCOPE; i++) {
      await store.save('global', undefined, note({ name: `n-${i}` }));
    }
    await expect(store.save('global', undefined, note({ name: 'one-more' }))).rejects.toMatchObject(
      {
        code: 'limit',
      },
    );
    await expect(
      store.save('global', undefined, note({ name: 'n-1', content: 'ok' })),
    ).resolves.toMatchObject({
      created: false,
    });
  });

  it('同时保存同一个范围不丢条目', async () => {
    const store = new MemoryStore({ dir: join(tempDir(), 'memory') });
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.save('global', undefined, note({ name: `p-${i}` })),
      ),
    );
    expect(await store.list()).toHaveLength(20);
  });

  it('手改坏的文件被跳过，不拖垮列表', async () => {
    const dir = join(tempDir(), 'memory');
    const store = new MemoryStore({ dir });
    await store.save('global', undefined, note());
    writeFileSync(join(dir, 'global', 'broken.md'), 'no frontmatter here');
    writeFileSync(join(dir, 'global', 'Bad Name.md'), '---\n---\n');
    mkdirSync(join(dir, 'global', 'dir.md'));
    expect((await store.list()).map((entry) => entry.name)).toEqual(['avoid-rm-f']);
  });

  it('索引文本：没有记忆时 undefined；超过上限的只说还有几条', async () => {
    const store = new MemoryStore({ dir: join(tempDir(), 'memory') });
    expect(await store.indexText('ws_1')).toBeUndefined();
    await store.save('global', undefined, note());
    await store.save(
      'project',
      'ws_1',
      note({ name: 'dev-server', type: 'project', description: 'port 5173' }),
    );
    const text = (await store.indexText('ws_1')) ?? '';
    expect(text).toContain('not instructions');
    expect(text).toContain(
      '- [global] avoid-rm-f (feedback): rm -f hides missing files; check first',
    );
    expect(text).toContain('- [project] dev-server (project): port 5173');

    for (let i = 0; i < 60; i++) {
      await store.save(
        'global',
        undefined,
        note({ name: `long-${i}`, description: 'd'.repeat(190) }),
      );
    }
    const capped = (await store.indexText('ws_1')) ?? '';
    expect(Buffer.byteLength(capped)).toBeLessThan(MEMORY_INDEX_MAX_BYTES + 600);
    expect(capped).toMatch(/- … and \d+ more; call wevir_memory_list/);
  });
});

describe('memoryTools', () => {
  const sessionId = 'ses_1' as SessionId;
  const signal = new AbortController().signal;

  function setup(workspace: () => string = () => 'ws_1') {
    const memory = new MemoryStore({ dir: join(tempDir(), 'memory') });
    const tools = memoryTools({ memory, workspaceOf: workspace });
    const call = async (name: string, args: Record<string, unknown>) => {
      const tool = tools.find((candidate) => candidate.name === name);
      if (tool === undefined) throw new Error(`no tool ${name}`);
      return tool.call(args, { sessionId, signal });
    };
    return { memory, tools, call };
  }

  it('四个工具都在放行表里；标只读（只写 Host 自己的文件）', () => {
    const { tools } = setup();
    expect(tools.map((tool) => tool.name)).toEqual([...MEMORY_TOOLS]);
    for (const tool of tools) {
      expect(APP_TOOLS_NO_APPROVAL).toContain(tool.name);
      expect(tool.annotations.readOnlyHint).toBe(true);
    }
  });

  it('保存 → 列出 → 读 → 覆盖 → 删除', async () => {
    const { call } = setup();
    const saved = await call('wevir_memory_save', { scope: 'project', ...note() });
    expect(saved.structuredContent).toMatchObject({
      saved: 'avoid-rm-f',
      scope: 'project',
      created: true,
    });
    const list = await call('wevir_memory_list', {});
    expect(list.structuredContent).toMatchObject({
      notes: [{ scope: 'project', name: 'avoid-rm-f', type: 'feedback' }],
    });
    const read = await call('wevir_memory_read', { scope: 'project', name: 'avoid-rm-f' });
    expect(read.structuredContent).toMatchObject({
      content: expect.stringContaining('without -f'),
    });
    const again = await call('wevir_memory_save', { scope: 'project', ...note({ content: 'v2' }) });
    expect(again.structuredContent).toMatchObject({ created: false });
    const deleted = await call('wevir_memory_delete', { scope: 'project', name: 'avoid-rm-f' });
    expect(deleted.structuredContent).toEqual({ deleted: 'avoid-rm-f', scope: 'project' });
    expect((await call('wevir_memory_list', {})).structuredContent).toEqual({ notes: [] });
  });

  it('错误变成给模型看的 AppToolError', async () => {
    const { call } = setup();
    await expect(
      call('wevir_memory_read', { scope: 'global', name: 'missing' }),
    ).rejects.toBeInstanceOf(AppToolError);
    await expect(call('wevir_memory_read', { scope: 'nowhere', name: 'x' })).rejects.toThrow(
      /scope must be one of/,
    );
    await expect(
      call('wevir_memory_save', { scope: 'global', ...note({ name: 'Bad Name' }) }),
    ).rejects.toThrow(/lowercase letters/);
    await expect(
      call('wevir_memory_save', { scope: 'global', ...note({ content: '' }) }),
    ).rejects.toThrow(/content is required/);
  });

  it('会话不在了时拒绝', async () => {
    const { call } = setup(() => {
      throw new AppToolError('This Wevir session no longer exists.');
    });
    await expect(call('wevir_memory_list', {})).rejects.toThrow(/no longer exists/);
  });
});

describe('记忆经 MCP 端点', () => {
  let http: Server | undefined;
  let mcp: AppMcpServer | undefined;
  afterEach(async () => {
    mcp?.close();
    await new Promise<void>((resolve) => (http ? http.close(() => resolve()) : resolve()));
    http = undefined;
    mcp = undefined;
  });

  async function setup() {
    const root = tempDir();
    const storage = storages.open(join(root, 'data'));
    seedSession(storage, SES);
    seedSession(storage, SES2);
    storage.workspaces.insert({
      id: 'ws_2',
      rootPath: '/home/u/other',
      displayName: 'other',
      createdAt: '2026-10-13T00:00:00.000Z',
      updatedAt: '2026-10-13T00:00:00.000Z',
    });
    storage.sessions.insert({
      ...(storage.sessions.get(SES) as NonNullable<ReturnType<typeof storage.sessions.get>>),
      id: SES_OTHER,
      workspaceId: 'ws_2',
      engineSessionId: `engine-${SES_OTHER}`,
    });
    const memory = new MemoryStore({ dir: join(root, 'memory') });
    const tools = new AppTools({
      storage,
      events: new EventStore({ storage, deltaWindowMs: 5 }),
      sessions: {} as SessionManager,
      hostId: 'host_test' as HostId,
      sendWhileBusy: () => 'queue',
      memory,
    });
    const warnings: string[] = [];
    mcp = new AppMcpServer({
      tools: tools.tools,
      version: '0.0.0',
      instructions: instructionsWithMemory({
        base: APP_TOOLS_INSTRUCTIONS,
        memory,
        workspaceOf: (sessionId) => storage.sessions.get(sessionId)?.workspaceId,
        onWarning: (message) => warnings.push(message),
      }),
    });
    const server = createServer((req, res) => {
      if (!mcp?.handle(req, res)) res.writeHead(404).end();
    });
    http = server;
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    mcp.setPort((server.address() as AddressInfo).port);
    let id = 0;
    const rpc = async (sessionId: SessionId, method: string, params: unknown = {}) => {
      const endpoint = mcp?.grant(sessionId);
      const response = await fetch(endpoint?.url ?? '', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${endpoint?.token}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      });
      // biome-ignore lint/suspicious/noExplicitAny: 读任意形状的 JSON-RPC 回复。
      return ((await response.json()) as Record<string, any>).result;
    };
    return { storage, memory, rpc, warnings };
  }

  it('工具在列表里；保存后下一个会话的说明里有索引，只含全局和自己项目的', async () => {
    const { storage, rpc, warnings } = await setup();
    const listed = await rpc(SES, 'tools/list');
    expect(listed.tools.map((tool: { name: string }) => tool.name)).toEqual(
      expect.arrayContaining([...MEMORY_TOOLS]),
    );

    const before = await rpc(SES, 'initialize', { protocolVersion: '2025-06-18' });
    expect(before.instructions).toBe(APP_TOOLS_INSTRUCTIONS);
    expect(APP_TOOLS_INSTRUCTIONS).toContain('wevir_memory_');

    const call = (sessionId: SessionId, name: string, args: Record<string, unknown>) =>
      rpc(sessionId, 'tools/call', { name, arguments: args });
    expect(
      (await call(SES, 'wevir_memory_save', { scope: 'global', ...note() })).isError,
    ).toBeUndefined();
    await call(SES, 'wevir_memory_save', {
      scope: 'project',
      ...note({ name: 'dev-server', type: 'project', description: 'port 5173' }),
    });

    // 另一个会话（同一个项目）看到两条；别的项目的会话只看到全局的。
    const same = await rpc(SES2, 'initialize', { protocolVersion: '2025-06-18' });
    expect(same.instructions).toContain('[global] avoid-rm-f (feedback)');
    expect(same.instructions).toContain('[project] dev-server (project): port 5173');
    const other = await rpc(SES_OTHER, 'initialize', { protocolVersion: '2025-06-18' });
    expect(other.instructions).toContain('[global] avoid-rm-f');
    expect(other.instructions).not.toContain('dev-server');
    expect(warnings).toEqual([]);
    expect(storage.sessions.get(SES_OTHER)?.workspaceId).toBe('ws_2');
  });

  it('项目范围按调用会话所在的项目隔离；会话不在了时报错', async () => {
    const { storage, rpc } = await setup();
    const call = (sessionId: SessionId, name: string, args: Record<string, unknown>) =>
      rpc(sessionId, 'tools/call', { name, arguments: args });
    await call(SES, 'wevir_memory_save', { scope: 'project', ...note({ name: 'only-here' }) });
    const listed = await call(SES, 'wevir_memory_list', {});
    expect(listed.structuredContent.notes).toHaveLength(1);
    expect(storage.sessions.get(SES)?.workspaceId).toBe('ws_1');
    const gone = await call('ses_missing' as SessionId, 'wevir_memory_list', {});
    expect(gone.isError).toBe(true);
    expect(gone.content[0].text).toMatch(/no longer exists/);
  });
});

describe('新会话的记忆索引', () => {
  const managers: SessionManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  });

  it('引擎在会话写进存储之前取说明（Codex 起 thread 时连 MCP）也认得项目，带上项目的笔记', async () => {
    const root = tempDir();
    const storage = storages.open(join(root, 'data'));
    const project = join(root, 'project');
    mkdirSync(project);
    storage.workspaces.insert({
      id: 'ws_1',
      rootPath: realpathSync(project),
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
    const memory = new MemoryStore({ dir: join(root, 'memory') });
    await memory.save('project', 'ws_1', note({ name: 'dev-server', type: 'project' }));
    let manager: SessionManager | undefined;
    const instructions = instructionsWithMemory({
      base: APP_TOOLS_INSTRUCTIONS,
      memory,
      workspaceOf: (sessionId) => manager?.workspaceOf(sessionId),
    });
    let granted: SessionId | undefined;
    const seen: { stored: boolean; text: string }[] = [];
    class ConnectingEcho extends EchoAdapter {
      readonly appTools = true;
      override async createSession(config: SessionConfig): Promise<EngineSession> {
        // 同 Codex：建会话的过程中就连上应用级工具、取说明。
        if (granted !== undefined) {
          seen.push({
            stored: storage.sessions.get(granted) !== undefined,
            text: await instructions(granted),
          });
        }
        return super.createSession(config);
      }
    }
    manager = new SessionManager({
      storage,
      events: new EventStore({ storage, deltaWindowMs: 5 }),
      adapter: new ConnectingEcho({ stepDelayMs: 0 }),
      appTools: {
        grant: (sessionId) => {
          granted = sessionId;
          return { url: 'http://127.0.0.1:9/mcp', token: 'not-a-secret' };
        },
      },
    });
    managers.push(manager);
    const session = await manager.create({
      workspaceId: 'ws_1' as WorkspaceId,
      providerId: 'mock',
    });
    expect(seen).toEqual([
      { stored: false, text: expect.stringContaining('[project] dev-server (project)') },
    ]);
    expect(manager.workspaceOf(session.id)).toBe('ws_1');
    expect(manager.workspaceOf('ses_01JA2B3C4D5E6F7G8H9JKMNPQZ' as SessionId)).toBeUndefined();
  });
});
