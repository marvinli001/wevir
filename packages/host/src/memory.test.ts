// 跨会话记忆（memory.ts）与它的应用级工具（memory-tools.ts）。

import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { HostId, SessionId, TurnId, WorkspaceId } from '@wevir/protocol';
import { MethodSchemas } from '@wevir/protocol';
import {
  APP_TOOLS_NO_APPROVAL,
  type EngineSession,
  type SessionConfig,
} from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { FileSecretStore } from '@wevir/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { AppMcpServer, AppToolError } from './app-mcp.js';
import { APP_TOOLS_INSTRUCTIONS, AppTools } from './app-tools.js';
import { EventStore } from './event-store.js';
import { createHostMethods } from './host-methods.js';
import {
  MEMORY_CONTENT_MAX_BYTES,
  MEMORY_INDEX_MAX_BYTES,
  MEMORY_MAX_PER_SCOPE,
  MemoryError,
  MemoryStore,
} from './memory.js';
import {
  instructionsWithMemory,
  MEMORY_OFF_MESSAGE,
  MEMORY_TOOLS,
  memoryTools,
} from './memory-tools.js';
import { SessionManager } from './session-manager.js';
import { ev, SES, SES2, seedSession, T0, useStorages, useTempDir } from './test-utils.js';

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

describe('MemoryStore 的管理（0.57.0）', () => {
  it('停用：Agent 列不出、读不到、删不到，索引里没有；同名保存被拒，不会悄悄恢复；用户能看到并重新启用', async () => {
    const dir = join(tempDir(), 'memory');
    const store = new MemoryStore({ dir, now: () => new Date('2026-10-17T00:00:00.000Z') });
    await store.save('project', 'ws_1', note());
    const off = await store.setEnabled('project', 'ws_1', 'avoid-rm-f', false);
    expect(off.enabled).toBe(false);
    expect(off.updatedAt).toBe('2026-10-17T00:00:00.000Z');
    expect(readFileSync(join(dir, 'projects', 'ws_1', 'avoid-rm-f.md'), 'utf8')).toContain(
      '\ndisabled: true\n',
    );
    expect(await store.list('ws_1')).toEqual([]);
    expect(await store.indexText('ws_1')).toBeUndefined();
    await expect(store.read('project', 'ws_1', 'avoid-rm-f')).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(store.delete('project', 'ws_1', 'avoid-rm-f')).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      store.save('project', 'ws_1', note({ content: 'sneaky rewrite' })),
    ).rejects.toMatchObject({ code: 'disabled' });
    const still = await store.read('project', 'ws_1', 'avoid-rm-f', { includeDisabled: true });
    expect(still).toMatchObject({ enabled: false, content: expect.stringContaining('without -f') });
    expect((await store.listAll('ws_1')).notes).toEqual([
      expect.objectContaining({ name: 'avoid-rm-f', enabled: false }),
    ]);

    await store.setEnabled('project', 'ws_1', 'avoid-rm-f', true);
    expect((await store.list('ws_1')).map((entry) => entry.name)).toEqual(['avoid-rm-f']);
    expect(readFileSync(join(dir, 'projects', 'ws_1', 'avoid-rm-f.md'), 'utf8')).not.toContain(
      'disabled',
    );
  });

  it('用户修改带版本：期间被 Agent 改过就不写、返回现在的版本；没有改动不写；规则同 Agent 保存', async () => {
    let tick = 0;
    const store = new MemoryStore({
      dir: join(tempDir(), 'memory'),
      now: () => new Date(Date.UTC(2026, 9, 17, 0, 0, tick++)),
    });
    const { note: first } = await store.save('global', undefined, note());
    // Agent 在用户编辑期间又存了一次。
    const { note: agent } = await store.save('global', undefined, note({ content: 'agent v2' }));
    expect(agent.revision).not.toBe(first.revision);
    const stale = await store.update('global', undefined, 'avoid-rm-f', first.revision, {
      content: 'user edit',
    });
    expect(stale).toEqual({ note: agent, conflict: true });
    expect((await store.read('global', undefined, 'avoid-rm-f')).content).toBe('agent v2');

    const saved = await store.update('global', undefined, 'avoid-rm-f', agent.revision, {
      content: 'user edit',
      type: 'project',
    });
    expect(saved.conflict).toBeUndefined();
    expect(saved.note).toMatchObject({ content: 'user edit', type: 'project', enabled: true });
    expect(saved.note.updatedAt > agent.updatedAt).toBe(true);
    expect(saved.note.revision).not.toBe(agent.revision);
    expect(await store.read('global', undefined, 'avoid-rm-f')).toEqual(saved.note);

    const same = await store.update('global', undefined, 'avoid-rm-f', saved.note.revision, {
      content: 'user edit',
    });
    expect(same).toEqual({ note: saved.note });
    await expect(
      store.update('global', undefined, 'avoid-rm-f', saved.note.revision, {
        content: 'token sk-abcdefghijklmnopqrstuvwxyz0123',
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      store.update('global', undefined, 'missing', saved.note.revision, { content: 'x' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('删除可带版本；读不出来的文件列在 unreadable 里，改不了但能按名字删', async () => {
    const dir = join(tempDir(), 'memory');
    const store = new MemoryStore({ dir });
    const { note: saved } = await store.save('global', undefined, note());
    await store.save('global', undefined, note({ content: 'newer' }));
    expect(
      await store.delete('global', undefined, 'avoid-rm-f', {
        includeDisabled: true,
        revision: saved.revision,
      }),
    ).toEqual({ conflict: expect.objectContaining({ content: 'newer' }) });
    writeFileSync(join(dir, 'global', 'broken.md'), 'no frontmatter here');
    expect((await store.listAll()).unreadable).toEqual([{ scope: 'global', name: 'broken' }]);
    await expect(
      store.update('global', undefined, 'broken', 'r', { content: 'x' }),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(await store.delete('global', undefined, 'broken', { includeDisabled: true })).toEqual(
      {},
    );
    expect((await store.listAll()).unreadable).toEqual([]);
    expect((await store.listAll()).notes).toHaveLength(1);
  });

  it('旧格式（没有 updated）照样读；认不出的 frontmatter 字段改写时留着', async () => {
    const dir = join(tempDir(), 'memory');
    mkdirSync(join(dir, 'global'), { recursive: true });
    writeFileSync(
      join(dir, 'global', 'old-note.md'),
      '---\nname: old-note\ndescription: Written by hand\ntype: reference\nsource: future-field\n---\n\nDocs live in the wiki.\n',
    );
    const store = new MemoryStore({ dir });
    const old = await store.read('global', undefined, 'old-note');
    expect(old).toMatchObject({ updatedAt: '', enabled: true, content: 'Docs live in the wiki.' });
    await store.setEnabled('global', undefined, 'old-note', false);
    const text = readFileSync(join(dir, 'global', 'old-note.md'), 'utf8');
    expect(text).toContain('source: future-field');
    expect(text).toContain('disabled: true');
  });

  it('改动通知：存、改、启停、删各一次；冲突与没有改动的不通知', async () => {
    const store = new MemoryStore({ dir: join(tempDir(), 'memory') });
    const changes: unknown[] = [];
    const stop = store.watch((change) => changes.push(change));
    const { note: saved } = await store.save('project', 'ws_1', note());
    await store.update('project', 'ws_1', 'avoid-rm-f', 'stale', { content: 'x' });
    await store.update('project', 'ws_1', 'avoid-rm-f', saved.revision, {});
    const { note: edited } = await store.update('project', 'ws_1', 'avoid-rm-f', saved.revision, {
      content: 'edited',
    });
    await store.setEnabled('project', 'ws_1', 'avoid-rm-f', false);
    await store.setEnabled('project', 'ws_1', 'avoid-rm-f', false);
    await store.delete('project', 'ws_1', 'avoid-rm-f', { includeDisabled: true });
    await store.save('global', undefined, note());
    stop();
    await store.save('global', undefined, note({ content: 'after stop' }));
    const change = { scope: 'project', workspaceId: 'ws_1', name: 'avoid-rm-f' };
    expect(changes).toEqual([
      change,
      change,
      change,
      change,
      { scope: 'global', name: 'avoid-rm-f' },
    ]);
    expect(edited.content).toBe('edited');
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

  it('给 Agent 的结果里没有启用状态与来源；读与保存带版本', async () => {
    const { call } = setup();
    const saved = await call('wevir_memory_save', { scope: 'project', ...note() });
    expect(saved.structuredContent).toMatchObject({ revision: expect.any(String) });
    const listed = (await call('wevir_memory_list', {})).structuredContent as {
      notes: Record<string, unknown>[];
    };
    expect(Object.keys(listed.notes[0] ?? {}).sort()).toEqual([
      'description',
      'name',
      'scope',
      'type',
      'updatedAt',
    ]);
    const read = (await call('wevir_memory_read', { scope: 'project', name: 'avoid-rm-f' }))
      .structuredContent as Record<string, unknown>;
    expect(read.revision).toBe((saved.structuredContent as { revision: string }).revision);
    expect(read).not.toHaveProperty('enabled');
    expect(read).not.toHaveProperty('origin');
    expect(read).not.toHaveProperty('lastEdit');
    expect(read).not.toHaveProperty('editedByUser');
  });

  it('自动记忆关着时每个工具都拒绝，不碰文件', async () => {
    const memory = new MemoryStore({ dir: join(tempDir(), 'memory') });
    let enabled = false;
    const tools = memoryTools({ memory, workspaceOf: () => 'ws_1', enabled: () => enabled });
    const call = (name: string, args: Record<string, unknown>) =>
      (tools.find((tool) => tool.name === name) as (typeof tools)[number]).call(args, {
        sessionId,
        signal,
      });
    await expect(call('wevir_memory_save', { scope: 'project', ...note() })).rejects.toThrow(
      MEMORY_OFF_MESSAGE,
    );
    await expect(call('wevir_memory_list', {})).rejects.toThrow(MEMORY_OFF_MESSAGE);
    expect(await memory.list('ws_1')).toEqual([]);
    enabled = true;
    await expect(call('wevir_memory_list', {})).resolves.toBeDefined();
  });
});

describe('来源与版本（0.58.0）', () => {
  const managers: SessionManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  });
  const A = { sessionId: SES, turnId: 'trn_A1' as TurnId, seq: 7 };
  const B = { sessionId: SES2 };
  const signal = new AbortController().signal;

  function clockedStore(dir = join(tempDir(), 'memory')) {
    let tick = 0;
    return new MemoryStore({ dir, now: () => new Date(Date.UTC(2026, 9, 19, 0, 0, tick++)) });
  }

  it('Agent 保存记下会话、回合与事件；改写保留首次来源；用户修改记成用户；启停不改来源；旧笔记不补造', async () => {
    const dir = join(tempDir(), 'memory');
    const store = clockedStore(dir);
    const { note: first } = await store.save('project', 'ws_1', note(), { writer: A });
    const source = { by: 'agent', at: '2026-10-19T00:00:00.000Z', ...A };
    expect(first).toMatchObject({ origin: source, lastEdit: source });
    const file = join(dir, 'projects', 'ws_1', 'avoid-rm-f.md');
    expect(readFileSync(file, 'utf8')).toContain(
      [
        'type: feedback',
        'created: 2026-10-19T00:00:00.000Z',
        'created-by: agent',
        `created-session: ${SES}`,
        'created-turn: trn_A1',
        'created-seq: 7',
        'updated: 2026-10-19T00:00:00.000Z',
        'updated-by: agent',
        `updated-session: ${SES}`,
      ].join('\n'),
    );

    const { note: again } = await store.save('project', 'ws_1', note({ content: 'v2' }), {
      writer: { sessionId: SES, seq: 9 },
    });
    expect(again.origin).toEqual(source);
    expect(again.lastEdit).toEqual({
      by: 'agent',
      at: '2026-10-19T00:00:01.000Z',
      sessionId: SES,
      seq: 9,
    });

    const { note: edited } = await store.update('project', 'ws_1', 'avoid-rm-f', again.revision, {
      content: 'user v3',
    });
    expect(edited.origin).toEqual(source);
    expect(edited.lastEdit).toEqual({ by: 'user', at: '2026-10-19T00:00:02.000Z' });
    const off = await store.setEnabled('project', 'ws_1', 'avoid-rm-f', false);
    expect(off).toMatchObject({ origin: source, lastEdit: edited.lastEdit });
    expect((await store.listAll('ws_1')).notes[0]).toMatchObject({
      origin: source,
      lastEdit: edited.lastEdit,
    });

    // 旧笔记：没有来源，用户改了也只记最近修改，不补造首次来源；Agent 改写同样。
    writeFileSync(
      join(dir, 'projects', 'ws_1', 'old-note.md'),
      '---\nname: old-note\ndescription: From before sources\ntype: project\n---\n\nOld body.\n',
    );
    const old = await store.read('project', 'ws_1', 'old-note');
    expect(old.origin).toBeUndefined();
    expect(old.lastEdit).toBeUndefined();
    const { note: rewritten } = await store.save(
      'project',
      'ws_1',
      note({ name: 'old-note', content: 'Agent rewrite.' }),
      { writer: B },
    );
    expect(rewritten.origin).toBeUndefined();
    expect(rewritten.lastEdit).toMatchObject({ by: 'agent', sessionId: SES2 });
  });

  it('只改文件的修改时间：版本与来源都不变', async () => {
    const dir = join(tempDir(), 'memory');
    const store = clockedStore(dir);
    const { note: saved } = await store.save('global', undefined, note(), { writer: A });
    const file = join(dir, 'global', 'avoid-rm-f.md');
    utimesSync(file, new Date('2030-01-01T00:00:00Z'), new Date('2030-01-01T00:00:00Z'));
    const read = await store.read('global', undefined, 'avoid-rm-f');
    expect(read).toEqual(saved);
    expect(read.updatedAt).toBe('2026-10-19T00:00:00.000Z');
  });

  it('手改坏的来源字段只丢掉那一项；认不出的作者当作没有记录', async () => {
    const dir = join(tempDir(), 'memory');
    mkdirSync(join(dir, 'global'), { recursive: true });
    writeFileSync(
      join(dir, 'global', 'hand.md'),
      '---\nname: hand\ndescription: Hand edited\ntype: user\ncreated: 2026-10-01T00:00:00.000Z\ncreated-by: agent\ncreated-session: ../../etc\ncreated-turn: trn_ok\ncreated-seq: 0\nupdated-by: robot\n---\n\nBody.\n',
    );
    const read = await new MemoryStore({ dir }).read('global', undefined, 'hand');
    expect(read.origin).toEqual({ by: 'agent', at: '2026-10-01T00:00:00.000Z', turnId: 'trn_ok' });
    expect(read.lastEdit).toBeUndefined();
  });

  it('Agent 改写：带版本时被改过就冲突；不带版本时别人写的冲突，旧笔记与自己写的可以直接覆盖；停用先挡', async () => {
    const dir = join(tempDir(), 'memory');
    const store = clockedStore(dir);
    const { note: base } = await store.save('global', undefined, note(), { writer: A });
    const { note: user } = await store.update('global', undefined, 'avoid-rm-f', base.revision, {
      content: 'user edit',
    });

    // 读过旧版本的会话：冲突，内容不动，错误里有现在的版本。
    const stale = await store
      .save('global', undefined, note({ content: 'agent' }), {
        writer: A,
        revision: base.revision,
      })
      .catch((error: unknown) => error);
    expect(stale).toBeInstanceOf(MemoryError);
    expect(stale).toMatchObject({ code: 'conflict', current: user });
    expect((stale as Error).message).toMatch(/the user in Wevir settings/);
    // 没读过也不带版本：用户最近改过，同样冲突。
    await expect(
      store.save('global', undefined, note({ content: 'blind' }), { writer: A }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect((await store.read('global', undefined, 'avoid-rm-f')).content).toBe('user edit');
    // 带着现在的版本：写进去。
    const { note: merged } = await store.save(
      'global',
      undefined,
      note({ content: 'user edit + agent' }),
      { writer: A, revision: user.revision },
    );
    expect(merged.lastEdit).toMatchObject({ by: 'agent', sessionId: SES });
    // 自己最近写的：不带版本可以再覆盖；别的会话写的不行。
    await store.save('global', undefined, note({ content: 'again' }), { writer: A });
    await expect(
      store.save('global', undefined, note({ content: 'other session' }), { writer: B }),
    ).rejects.toMatchObject({ code: 'conflict', message: /another session/ });
    // 读过之后被删掉：带版本的保存是冲突（没有现在的版本），不带版本就是新建。
    const { note: gone } = await store.save('global', undefined, note({ name: 'gone' }), {
      writer: B,
    });
    await store.delete('global', undefined, 'gone', { includeDisabled: true });
    await expect(
      store.save('global', undefined, note({ name: 'gone' }), {
        writer: B,
        revision: gone.revision,
      }),
    ).rejects.toMatchObject({ code: 'conflict', current: undefined });
    // 旧笔记（没有来源）：不带版本照旧覆盖。
    writeFileSync(
      join(dir, 'global', 'legacy.md'),
      '---\nname: legacy\ndescription: Old\ntype: user\n---\n\nOld.\n',
    );
    await expect(
      store.save('global', undefined, note({ name: 'legacy' }), { writer: B }),
    ).resolves.toMatchObject({ created: false });
    // 停用：带着正确的版本也不能存回去。
    const current = await store.read('global', undefined, 'legacy');
    await store.setEnabled('global', undefined, 'legacy', false);
    const disabled = await store.read('global', undefined, 'legacy', { includeDisabled: true });
    await expect(
      store.save('global', undefined, note({ name: 'legacy' }), {
        writer: B,
        revision: disabled.revision,
      }),
    ).rejects.toMatchObject({ code: 'disabled' });
    expect(current.revision).not.toBe(disabled.revision);
  });

  it('Agent 删除：别人写的要带版本，被改过就不删；停用的删不到', async () => {
    const store = clockedStore();
    const { note: saved } = await store.save('global', undefined, note(), { writer: A });
    expect(await store.delete('global', undefined, 'avoid-rm-f', { writer: B })).toEqual({
      conflict: expect.objectContaining({ revision: saved.revision }),
    });
    const { note: user } = await store.update('global', undefined, 'avoid-rm-f', saved.revision, {
      content: 'user',
    });
    expect(
      await store.delete('global', undefined, 'avoid-rm-f', {
        writer: A,
        revision: saved.revision,
      }),
    ).toEqual({ conflict: user });
    await store.setEnabled('global', undefined, 'avoid-rm-f', false);
    await expect(
      store.delete('global', undefined, 'avoid-rm-f', { writer: A, revision: user.revision }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await store.setEnabled('global', undefined, 'avoid-rm-f', true);
    const enabled = await store.read('global', undefined, 'avoid-rm-f');
    expect(
      await store.delete('global', undefined, 'avoid-rm-f', {
        writer: B,
        revision: enabled.revision,
      }),
    ).toEqual({});
  });

  it('同时编辑：两个会话拿着同一个版本同时保存，恰好一个写进去，另一个冲突；用户与 Agent 同时改也一样', async () => {
    const store = clockedStore();
    const { note: base } = await store.save('project', 'ws_1', note(), { writer: A });
    for (let round = 0; round < 5; round += 1) {
      const current = await store.read('project', 'ws_1', 'avoid-rm-f');
      const results = await Promise.allSettled([
        store.save('project', 'ws_1', note({ content: `a${round}` }), {
          writer: A,
          revision: current.revision,
        }),
        store.save('project', 'ws_1', note({ content: `b${round}` }), {
          writer: B,
          revision: current.revision,
        }),
        store.update('project', 'ws_1', 'avoid-rm-f', current.revision, {
          content: `user${round}`,
        }),
      ]);
      const written = results.filter(
        (result) =>
          result.status === 'fulfilled' && !('conflict' in result.value && result.value.conflict),
      );
      expect(written).toHaveLength(1);
      expect(
        results.filter(
          (result) =>
            (result.status === 'rejected' && result.reason.code === 'conflict') ||
            (result.status === 'fulfilled' && 'conflict' in result.value && result.value.conflict),
        ),
      ).toHaveLength(2);
    }
    expect(base.revision).toBeDefined();
  });

  it('工具：来源由 Host 按调用会话填写，模型给的来源字段不认；读过才能改别人写的；读过之后被改了就冲突', async () => {
    const memory = new MemoryStore({ dir: join(tempDir(), 'memory') });
    const tools = memoryTools({
      memory,
      workspaceOf: () => 'ws_1',
      anchorOf: (sessionId) =>
        sessionId === SES ? { turnId: 'trn_A1' as TurnId, seq: 12 } : { seq: 0 },
    });
    const call = (sessionId: SessionId, name: string, args: Record<string, unknown>) =>
      (tools.find((tool) => tool.name === name) as (typeof tools)[number]).call(args, {
        sessionId,
        signal,
      });
    await call(SES, 'wevir_memory_save', {
      scope: 'project',
      ...note(),
      origin: { by: 'user', sessionId: SES2 },
      sessionId: SES2,
    });
    const stored = await memory.read('project', 'ws_1', 'avoid-rm-f');
    expect(stored.origin).toMatchObject({ by: 'agent', sessionId: SES, turnId: 'trn_A1', seq: 12 });

    // 另一个会话没读过就改：冲突；读了以后（不带版本也行）可以改，来源的序号为 0 时不记。
    await expect(
      call(SES2, 'wevir_memory_save', { scope: 'project', ...note({ content: 'b' }) }),
    ).rejects.toThrow(/another session.*wevir_memory_read/);
    const read = await call(SES2, 'wevir_memory_read', { scope: 'project', name: 'avoid-rm-f' });
    expect(read.structuredContent).toMatchObject({ revision: stored.revision });
    await call(SES2, 'wevir_memory_save', { scope: 'project', ...note({ content: 'b' }) });
    const afterB = await memory.read('project', 'ws_1', 'avoid-rm-f');
    expect(afterB.lastEdit).toEqual({ by: 'agent', at: expect.any(String), sessionId: SES2 });
    expect(afterB.origin).toEqual(stored.origin);

    // 第一个会话读过、用户随后在设置里改了：不带版本（用读到的那一版）也冲突；重读后能存，结果里看得到用户改过。
    await call(SES, 'wevir_memory_read', { scope: 'project', name: 'avoid-rm-f' });
    await memory.update('project', 'ws_1', 'avoid-rm-f', afterB.revision, { content: 'user' });
    await expect(
      call(SES, 'wevir_memory_save', { scope: 'project', ...note({ content: 'a2' }) }),
    ).rejects.toThrow(/changed after this session read it.*the user in Wevir settings/);
    await expect(
      call(SES, 'wevir_memory_save', {
        scope: 'project',
        ...note({ content: 'a2' }),
        revision: afterB.revision,
      }),
    ).rejects.toThrow(/changed after this session read it/);
    expect((await memory.read('project', 'ws_1', 'avoid-rm-f')).content).toBe('user');
    const reread = await call(SES, 'wevir_memory_read', { scope: 'project', name: 'avoid-rm-f' });
    expect(reread.structuredContent).toMatchObject({ content: 'user', editedByUser: true });
    const merged = await call(SES, 'wevir_memory_save', {
      scope: 'project',
      ...note({ content: 'user + a2' }),
    });
    expect(merged.structuredContent).toMatchObject({ created: false });

    // 删除：另一个会话拿着旧版本删不掉；读过之后能删。
    await expect(
      call(SES2, 'wevir_memory_delete', { scope: 'project', name: 'avoid-rm-f' }),
    ).rejects.toThrow(/changed after this session read it/);
    await call(SES2, 'wevir_memory_read', { scope: 'project', name: 'avoid-rm-f' });
    await call(SES2, 'wevir_memory_delete', { scope: 'project', name: 'avoid-rm-f' });
    await expect(memory.read('project', 'ws_1', 'avoid-rm-f')).rejects.toMatchObject({
      code: 'not_found',
    });
    // 被删之后再存：第一个会话记着的旧版本让它冲突一次，之后就是新建。
    await expect(call(SES, 'wevir_memory_save', { scope: 'project', ...note() })).rejects.toThrow(
      /was deleted/,
    );
    await expect(
      call(SES, 'wevir_memory_save', { scope: 'project', ...note() }),
    ).resolves.toMatchObject({ structuredContent: { created: true } });
  });

  it('memory.read 给出来源会话的状态：还在、回合撤回或撤销（重做后恢复）、会话已删除；用户编辑没有状态', async () => {
    const root = tempDir();
    const storage = storages.open(join(root, 'data'));
    seedSession(storage, SES);
    seedSession(storage, SES2);
    const events = new EventStore({ storage, deltaWindowMs: 5 });
    const store = new MemoryStore({ dir: join(root, 'memory') });
    const manager = new SessionManager({ storage, events, adapter: new EchoAdapter() });
    managers.push(manager);
    const methods = createHostMethods({
      storage,
      events,
      sessions: manager,
      secrets: new FileSecretStore(join(root, 'data')),
      memory: store,
    });
    const T1 = 'trn_T1' as TurnId;
    const T2 = 'trn_T2' as TurnId;
    events.append(SES, ev.created());
    for (const turnId of [T1, T2]) {
      events.append(SES, { type: 'turn.started', source: 'engine', payload: { turnId } });
      events.append(SES, {
        type: 'turn.finished',
        source: 'engine',
        payload: { turnId, outcome: 'completed', durationMs: 1 },
      });
    }
    await store.save('global', undefined, note({ name: 'from-t1' }), {
      writer: { sessionId: SES, turnId: T1, seq: 3 },
    });
    await store.save('global', undefined, note({ name: 'from-t2' }), {
      writer: { sessionId: SES, turnId: T2 },
    });
    const { note: other } = await store.save('global', undefined, note({ name: 'from-ses2' }), {
      writer: { sessionId: SES2 },
    });
    await store.update('global', undefined, 'from-ses2', other.revision, { content: 'by user' });
    const read = async (name: string) =>
      (
        await methods['memory.read'](
          { scope: 'global', name },
          {
            client: { deviceId: 'd', clientId: 'c', clientKind: 'cli' },
            capabilities: {},
          },
        )
      ).note;

    expect((await read('from-t1')).origin).toMatchObject({ turnId: T1, status: 'available' });
    events.append(SES, { type: 'turn.undone', source: 'host', payload: { turnId: T2 } });
    expect((await read('from-t2')).origin?.status).toBe('withdrawn');
    expect((await read('from-t1')).origin?.status).toBe('available');
    events.append(SES, { type: 'turn.redone', source: 'host', payload: { turnId: T2 } });
    expect((await read('from-t2')).origin?.status).toBe('available');
    events.append(SES, { type: 'turn.rewound', source: 'host', payload: { turnId: T2 } });
    expect((await read('from-t2')).lastEdit?.status).toBe('withdrawn');
    const fromUser = await read('from-ses2');
    expect(fromUser.origin).toMatchObject({ sessionId: SES2, status: 'available' });
    expect(fromUser.lastEdit).toEqual({ by: 'user', at: expect.any(String) });
    expect(MethodSchemas['memory.read'].result.safeParse({ note: fromUser }).success).toBe(true);

    storage.sessions.remove([SES2]);
    expect((await read('from-ses2')).origin?.status).toBe('deleted');
    // 列表不算状态（详情才算）。
    const listed = await methods['memory.list'](
      {},
      {
        client: { deviceId: 'd', clientId: 'c', clientKind: 'cli' },
        capabilities: {},
      },
    );
    expect(listed.notes.find((entry) => entry.name === 'from-ses2')?.origin).not.toHaveProperty(
      'status',
    );
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

  async function setup(memoryEnabled: () => boolean = () => true) {
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
      sessions: { toolPresetOf: () => undefined } as unknown as SessionManager,
      hostId: 'host_test' as HostId,
      sendWhileBusy: () => 'queue',
      memory,
      memoryEnabled,
    });
    const warnings: string[] = [];
    mcp = new AppMcpServer({
      tools: tools.tools,
      filterTools: (sessionId, list) => tools.filterTools(sessionId, list),
      version: '0.0.0',
      instructions: instructionsWithMemory({
        base: APP_TOOLS_INSTRUCTIONS,
        memory,
        workspaceOf: (sessionId) => storage.sessions.get(sessionId)?.workspaceId,
        enabled: memoryEnabled,
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

  it('自动记忆关着：新连接的说明里没有索引，工具不列出、调用被拒；停用的笔记也不进索引', async () => {
    let enabled = true;
    const { memory, rpc } = await setup(() => enabled);
    await memory.save('global', undefined, note());
    await memory.save('global', undefined, note({ name: 'turned-off', description: 'hidden' }));
    await memory.setEnabled('global', undefined, 'turned-off', false);
    const on = await rpc(SES, 'initialize', { protocolVersion: '2025-06-18' });
    expect(on.instructions).toContain('[global] avoid-rm-f');
    expect(on.instructions).not.toContain('turned-off');

    enabled = false;
    const off = await rpc(SES2, 'initialize', { protocolVersion: '2025-06-18' });
    expect(off.instructions).not.toContain('wevir_memory_');
    expect(off.instructions).not.toContain('avoid-rm-f');
    expect(off.instructions).toContain('wevir_session_');
    const listed = await rpc(SES2, 'tools/list');
    const names = listed.tools.map((tool: { name: string }) => tool.name);
    expect(names).not.toEqual(expect.arrayContaining(['wevir_memory_list']));
    for (const name of MEMORY_TOOLS) expect(names).not.toContain(name);
    expect(names).toContain('wevir_session_list');
    const refused = await rpc(SES2, 'tools/call', {
      name: 'wevir_memory_save',
      arguments: { scope: 'global', ...note({ name: 'while-off' }) },
    });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toMatch(/not available/);
    expect((await memory.listAll()).notes.map((entry) => entry.name).sort()).toEqual([
      'avoid-rm-f',
      'turned-off',
    ]);
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

describe('按会话生成的工具说明', () => {
  it('base 给函数时按调用方生成，记忆索引照旧接在后面；自动记忆关着时同样去掉讲记忆的那一行', async () => {
    const memory = new MemoryStore({ dir: join(tempDir(), 'memory') });
    await memory.save('global', undefined, note());
    let enabled = true;
    const calls: Array<SessionId | undefined> = [];
    const instructions = instructionsWithMemory({
      base: (sessionId) => {
        calls.push(sessionId);
        return sessionId === SES ? 'trimmed\n- wevir_memory_*: notes' : APP_TOOLS_INSTRUCTIONS;
      },
      memory,
      workspaceOf: () => undefined,
      enabled: () => enabled,
    });
    expect(await instructions(SES)).toMatch(/^trimmed\n- wevir_memory_\*: notes\n\nSaved memory/);
    expect(await instructions(undefined)).toMatch(
      /^You are running inside Wevir[\s\S]*Saved memory/,
    );
    enabled = false;
    expect(await instructions(SES)).toBe('trimmed');
    expect(calls).toEqual([SES, undefined, SES]);
  });
});
