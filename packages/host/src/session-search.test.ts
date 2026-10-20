// 会话全文搜索（0.77.0）：派生索引的增量与重建、撤销 / 撤回 / 删除 / 归档的可见性、范围过滤、中英文与路径、短词回退、分页、
// 索引落后时的状态。事件直接写进库（不走状态机），索引只读库。

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionId, WorkspaceId } from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { FileSecretStore, type Storage } from '@wevir/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { markHighlights } from './app-tools.js';
import { HostError } from './errors.js';
import { EventStore } from './event-store.js';
import { createHostMethods } from './host-methods.js';
import { SessionManager } from './session-manager.js';
import { findMatches, parseQuery, SessionSearch, searchDoc, snippetOf } from './session-search.js';
import { identity, useStorages, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const storages = useStorages();

const WS1 = 'ws_1' as WorkspaceId;
const WS2 = 'ws_2' as WorkspaceId;
const S1 = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQ1' as SessionId;
const S2 = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQ2' as SessionId;
const S3 = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQ3' as SessionId;

let clock = Date.parse('2026-10-20T00:00:00.000Z');
const nextTs = () => {
  clock += 1000;
  return new Date(clock).toISOString();
};

function open(): Storage {
  const storage = storages.open(tempDir());
  for (const [id, root] of [
    [WS1, '/home/u/one'],
    [WS2, '/home/u/two'],
  ] as const) {
    storage.workspaces.insert({
      id,
      rootPath: root,
      displayName: root,
      createdAt: nextTs(),
      updatedAt: nextTs(),
    });
  }
  return storage;
}

/** 建会话并写 `session.created`。 */
function session(
  storage: Storage,
  id: SessionId,
  workspaceId: WorkspaceId,
  extra: { title?: string; parentSessionId?: string; providerId?: string; sideOf?: string } = {},
): void {
  storage.sessions.insert({
    id,
    workspaceId,
    cwd: '/home/u',
    engine: 'codex',
    engineSessionId: `engine-${id}`,
    providerId: extra.providerId ?? 'deepseek-official',
    modelId: 'm',
    title: extra.title ?? `title ${id.slice(-1)}`,
    titleSource: 'first_prompt',
    state: 'idle',
    lastSeq: 0,
    createdAt: nextTs(),
    updatedAt: nextTs(),
    ...(extra.parentSessionId !== undefined && { parentSessionId: extra.parentSessionId }),
    ...(extra.sideOf !== undefined && { side: true, forkedFrom: { sessionId: extra.sideOf } }),
  });
  put(storage, id, 'session.created', {
    workspaceId,
    cwd: '/home/u',
    providerId: extra.providerId ?? 'deepseek-official',
    modelId: 'm',
  });
}

/** 直接写一条事件（不走状态机），并更新会话的 `lastSeq`。 */
function put(storage: Storage, sessionId: SessionId, type: string, payload: unknown): number {
  const seq = storage.events.lastSeq(sessionId) + 1;
  const ts = nextTs();
  storage.transaction(() => {
    storage.events.insert({ sessionId, seq, ts, type, source: 'host', payload });
    storage.sessions.update(sessionId, { lastSeq: seq, updatedAt: ts });
  });
  return seq;
}

const user = (storage: Storage, id: SessionId, turnId: string, text: string) =>
  put(storage, id, 'user.message', {
    turnId,
    content: [{ type: 'text', text }],
    sentBy: identity,
  });
const answer = (storage: Storage, id: SessionId, turnId: string, text: string) =>
  put(storage, id, 'assistant.message', { turnId, messageId: `m-${turnId}`, text, replaces: [] });
const shell = (storage: Storage, id: SessionId, turnId: string, command: string) =>
  put(storage, id, 'tool.started', {
    turnId,
    toolCallId: `call-${command}`,
    toolName: 'bash',
    display: { kind: 'shell', command },
  });
const edit = (storage: Storage, id: SessionId, turnId: string, paths: string[]) =>
  put(storage, id, 'tool.started', {
    turnId,
    toolCallId: `edit-${paths[0]}`,
    toolName: 'apply_patch',
    display: { kind: 'edit', paths },
  });
const delta = (storage: Storage, id: SessionId, turnId: string, text: string) =>
  put(storage, id, 'assistant.delta', {
    turnId,
    streamId: 'stm_1',
    blockIndex: 0,
    kind: 'text',
    text,
  });

function search(storage: Storage, options: { scanLimit?: number; batchEvents?: number } = {}) {
  const service = new SessionSearch({ storage, onError: vi.fn(), ...options });
  service.catchUp(Number.MAX_SAFE_INTEGER);
  return service;
}

function seqs(result: { hits: { sessionId: string; seq: number }[] }) {
  return result.hits.map((hit) => `${hit.sessionId.slice(-1)}:${hit.seq}`);
}

describe('取文', () => {
  it('只取用户消息与插话的文字、最终回答、命令与改动的文件；不取增量、读文件与图片', () => {
    expect(
      searchDoc({
        type: 'user.message',
        payload: {
          turnId: 'trn_1',
          content: [
            { type: 'text', text: '看图' },
            { type: 'image', imageId: 'img_1', mimeType: 'image/png' },
          ],
        },
      }),
    ).toEqual({ kind: 'user_message', turnId: 'trn_1', text: '看图' });
    expect(
      searchDoc({ type: 'tool.started', payload: { display: { kind: 'read', paths: ['a.ts'] } } }),
    ).toBeUndefined();
    expect(searchDoc({ type: 'assistant.delta', payload: { text: 'x' } })).toBeUndefined();
    expect(searchDoc({ type: 'assistant.message', payload: { text: '   ' } })).toBeUndefined();
    expect(
      searchDoc({
        type: 'tool.started',
        payload: { toolName: 'w', display: { kind: 'write', paths: ['a.ts', 'b/c.md'] } },
      })?.text,
    ).toBe('a.ts\nb/c.md');
  });

  it('查询词：引号成词、按折叠去重、不足 3 个字符的标为不可索引', () => {
    expect(parseQuery('登录  "Event Store"  event store 登录')).toEqual([
      { text: '登录', folded: '登录', indexable: false },
      { text: 'Event Store', folded: 'event store', indexable: true },
      { text: 'event', folded: 'event', indexable: true },
      { text: 'store', folded: 'store', indexable: true },
    ]);
  });

  it('高亮按原文下标，不分大小写、去变音符号；片段截在命中附近', () => {
    expect(findMatches('Café CAFE', parseQuery('cafe'))).toEqual([
      { start: 0, end: 4 },
      { start: 5, end: 9 },
    ]);
    const long = `${'前文'.repeat(100)}这里修了登录审批的问题${'后文'.repeat(100)}`;
    const { snippet, highlights } = snippetOf(long, parseQuery('登录审批'));
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    const [range] = highlights;
    expect(range && snippet.slice(range.start, range.end)).toBe('登录审批');
    expect(markHighlights('a bc d', [{ start: 2, end: 4 }])).toBe('a **bc** d');
  });
});

describe('索引与查询', () => {
  it('中文长词、短词回退、英文、路径、文件名、驼峰与下划线', () => {
    const storage = open();
    session(storage, S1, WS1);
    user(storage, S1, 'trn_1', '请修复登录审批流程里的 getUserName 报错');
    answer(storage, S1, 'trn_1', '已改 packages/host/src/event-store.ts 的 snake_case_id 处理。');
    shell(storage, S1, 'trn_1', 'pnpm vitest run --project host');
    edit(storage, S1, 'trn_1', ['apps/desktop/src/main/host-lifecycle.ts']);
    const service = search(storage);
    const q = (query: string) => service.query({ query });

    expect(q('登录审批').mode).toBe('index');
    expect(seqs(q('登录审批'))).toEqual(['1:2']);
    // 不足 3 个字符：回退扫描，标明是回退。
    const short = q('登录');
    expect(short.mode).toBe('scan');
    expect(short.reason).toBe('short_query');
    expect(short.scan).toEqual({ examined: 4, limit: 20_000, complete: true });
    expect(seqs(short)).toEqual(['1:2']);
    expect(seqs(q('审批'))).toEqual(['1:2']);
    expect(seqs(q('getusername'))).toEqual(['1:2']);
    expect(seqs(q('event-store.ts'))).toEqual(['1:3']);
    expect(seqs(q('src/event'))).toEqual(['1:3']);
    expect(seqs(q('snake_case'))).toEqual(['1:3']);
    expect(q('snake_case').hits[0]?.kind).toBe('assistant_message');
    expect(seqs(q('vitest run'))).toEqual(['1:4']);
    expect(q('"--project host"').hits[0]?.kind).toBe('command');
    expect(seqs(q('host-lifecycle'))).toEqual(['1:5']);
    expect(q('host-lifecycle').hits[0]?.kind).toBe('file_change');
    // 长词走索引、短词逐条核对。
    const mixed = q('vitest 无词');
    expect(mixed.mode).toBe('mixed');
    expect(mixed.hits).toEqual([]);
    expect(seqs(q('event-store.ts 改'))).toEqual(['1:3']);
    expect(q('无此长词').hits).toEqual([]);

    const [hit] = q('getUserName').hits;
    expect(hit).toMatchObject({
      sessionId: S1,
      workspaceId: WS1,
      seq: 2,
      itemId: 'e2',
      turnId: 'trn_1',
      kind: 'user_message',
      providerId: 'deepseek-official',
    });
    expect(hit?.highlights.map(({ start, end }) => hit.snippet.slice(start, end))).toEqual([
      'getUserName',
    ]);
  });

  it('分页：相关度与时间排序都能翻页，nextOffset 到底为 null', () => {
    const storage = open();
    session(storage, S1, WS1);
    for (let i = 0; i < 7; i += 1) answer(storage, S1, `trn_${i}`, `第 ${i} 次部署 deploy-target`);
    const service = search(storage);
    const all: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = service.query({ query: 'deploy-target', sort: 'recent', limit: 3, offset });
      all.push(...seqs(page));
      offset = page.nextOffset;
    }
    expect(all).toEqual(['1:8', '1:7', '1:6', '1:5', '1:4', '1:3', '1:2']);
    // 短词的回退也能翻页。
    const first = service.query({ query: '部署', limit: 4 });
    expect(first.nextOffset).toBe(4);
    const second = service.query({ query: '部署', limit: 4, offset: 4 });
    expect(second.nextOffset).toBeNull();
    expect([...seqs(first), ...seqs(second)]).toHaveLength(7);
  });

  it('增量更新只看新事件，不索引增量；水位推进到最后一条', () => {
    const storage = open();
    session(storage, S1, WS1);
    user(storage, S1, 'trn_1', 'first-message');
    const service = search(storage);
    expect(seqs(service.query({ query: 'first-message' }))).toEqual(['1:2']);
    delta(storage, S1, 'trn_1', 'streaming-only-text');
    answer(storage, S1, 'trn_1', 'final-answer text');
    expect(service.status()).toMatchObject({ state: 'ready', pendingEvents: 0 });
    expect(service.query({ query: 'streaming-only' }).hits).toEqual([]);
    expect(seqs(service.query({ query: 'final-answer' }))).toEqual(['1:4']);
    expect(storage.search.docCount()).toBe(2);
  });

  it('后台增量：新事件写入后按 notify 追上', async () => {
    vi.useFakeTimers();
    try {
      const storage = open();
      session(storage, S1, WS1);
      const service = new SessionSearch({ storage, liveDelayMs: 10 });
      service.start();
      await vi.advanceTimersByTimeAsync(1);
      user(storage, S1, 'trn_1', 'background-indexed');
      expect(storage.search.pending().sessions).toBe(1);
      service.notify();
      await vi.advanceTimersByTimeAsync(20);
      expect(storage.search.pending().sessions).toBe(0);
      expect(storage.search.docCount()).toBe(1);
      service.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('撤销隐藏、重做恢复、撤回删除，与会话里看到的一致', () => {
    const storage = open();
    session(storage, S1, WS1);
    user(storage, S1, 'trn_1', 'kept-turn question');
    user(storage, S1, 'trn_2', 'undone-turn question');
    answer(storage, S1, 'trn_2', 'undone-turn answer');
    const service = search(storage);
    expect(service.query({ query: 'undone-turn' }).hits).toHaveLength(2);

    put(storage, S1, 'turn.undone', { turnId: 'trn_2' });
    expect(service.query({ query: 'undone-turn' }).hits).toEqual([]);
    expect(service.query({ query: '-turn' }).hits).toHaveLength(1);
    put(storage, S1, 'turn.redone', { turnId: 'trn_2' });
    expect(service.query({ query: 'undone-turn' }).hits).toHaveLength(2);
    put(storage, S1, 'turn.rewound', { turnId: 'trn_2' });
    expect(service.query({ query: 'undone-turn' }).hits).toEqual([]);
    expect(storage.search.docCount()).toBe(1);
  });

  it('删除会话后索引一起删；归档的默认不出现，includeArchived 才出现；子会话看父会话', () => {
    const storage = open();
    session(storage, S1, WS1, { title: '父' });
    session(storage, S2, WS1, { title: '子', parentSessionId: S1 });
    session(storage, S3, WS1);
    user(storage, S1, 'trn_1', 'shared-word parent');
    user(storage, S2, 'trn_1', 'shared-word child');
    user(storage, S3, 'trn_1', 'shared-word other');
    const service = search(storage);
    expect(service.query({ query: 'shared-word' }).hits).toHaveLength(3);

    storage.sessions.setArchived(S1, nextTs());
    expect(service.query({ query: 'shared-word' }).hits.map((hit) => hit.sessionId)).toEqual([S3]);
    const archived = service.query({ query: 'shared-word', scope: { includeArchived: true } });
    expect(archived.hits).toHaveLength(3);
    expect(archived.hits.find((hit) => hit.sessionId === S2)).toMatchObject({
      archived: true,
      parentSessionId: S1,
    });

    storage.transaction(() => storage.sessions.remove([S3]));
    expect(
      service.query({ query: 'shared-word', scope: { includeArchived: true } }).hits,
    ).toHaveLength(2);
    expect(storage.search.docCount()).toBe(2);
    expect(service.query({ query: '-word', scope: { includeArchived: true } }).hits).toHaveLength(
      2,
    );
    // 删的是父会话一家时，子会话的也一起删。
    storage.transaction(() => storage.sessions.remove([S1, S2]));
    expect(storage.search.docCount()).toBe(0);
    expect(service.status()).toMatchObject({ state: 'ready', pendingSessions: 0 });
  });

  it('支线会话与会话列表一样不出现', () => {
    const storage = open();
    session(storage, S1, WS1);
    session(storage, S2, WS1, { sideOf: S1 });
    user(storage, S1, 'trn_1', 'side-word main');
    user(storage, S2, 'trn_1', 'side-word side');
    const service = search(storage);
    expect(seqs(service.query({ query: 'side-word', scope: { includeArchived: true } }))).toEqual([
      '1:2',
    ]);
  });

  it('范围先过滤再排名：项目、会话、种类、时间、来源；调用方的限制取交集', () => {
    const storage = open();
    session(storage, S1, WS1);
    session(storage, S2, WS2, { providerId: 'claude' });
    const before = new Date(clock + 500).toISOString();
    user(storage, S1, 'trn_1', 'scope-word one');
    answer(storage, S1, 'trn_1', 'scope-word answer');
    const middle = new Date(clock + 500).toISOString();
    user(storage, S2, 'trn_1', 'scope-word two');
    const service = search(storage);
    const q = (scope: object, limits?: { workspaceIds: WorkspaceId[] }) =>
      seqs(service.query({ query: 'scope-word', scope, sort: 'recent' }, limits));

    expect(q({})).toEqual(['2:2', '1:3', '1:2']);
    expect(q({ workspaceIds: [WS2] })).toEqual(['2:2']);
    expect(q({ sessionIds: [S1] })).toEqual(['1:3', '1:2']);
    expect(q({ kinds: ['assistant_message'] })).toEqual(['1:3']);
    expect(q({ since: before, until: middle })).toEqual(['1:3', '1:2']);
    expect(q({ providerIds: ['claude'] })).toEqual(['2:2']);
    // Agent 只能搜它的项目：要别的项目也搜不到。
    expect(q({}, { workspaceIds: [WS1] })).toEqual(['1:3', '1:2']);
    expect(q({ workspaceIds: [WS2] }, { workspaceIds: [WS1] })).toEqual([]);
    expect(seqs(service.query({ query: '-wo', sort: 'recent' }, { workspaceIds: [WS1] }))).toEqual([
      '1:3',
      '1:2',
    ]);
    expect(
      service.query({ query: '词', scope: { workspaceIds: [WS2] } }, { workspaceIds: [WS1] }).hits,
    ).toEqual([]);
    // 移除的工作区与会话列表一样不出现。
    storage.workspaces.markRemoved(WS2, nextTs());
    expect(q({})).toEqual(['1:3', '1:2']);
  });

  it('接力之后的条目记新的来源', () => {
    const storage = open();
    session(storage, S1, WS1);
    user(storage, S1, 'trn_1', 'before-handoff');
    put(storage, S1, 'session.handoff', {
      from: { providerId: 'deepseek-official', modelId: 'm' },
      to: { providerId: 'claude', modelId: 'opus' },
      engineSessionId: 'e2',
      strategy: 'full_thread_summary',
    });
    user(storage, S1, 'trn_2', 'after-handoff');
    const service = search(storage, { batchEvents: 1 });
    expect(service.query({ query: 'before-handoff' }).hits[0]?.providerId).toBe(
      'deepseek-official',
    );
    expect(service.query({ query: 'after-handoff' }).hits[0]?.providerId).toBe('claude');
  });

  it('索引落后时明确是 indexing；全量重建后结果与增量一致', () => {
    const storage = open();
    session(storage, S1, WS1);
    for (let i = 0; i < 30; i += 1) user(storage, S1, `trn_${i}`, `rebuild-word ${i}`);
    const service = new SessionSearch({ storage, batchEvents: 5, onError: vi.fn() });
    // 一次只追 10 个 seq：还没追完。
    expect(service.catchUp(10)).toBe(true);
    expect(storage.search.pending()).toEqual({ sessions: 1, events: 21 });
    // 查询自己会先同步追一小段（够追完这些）。
    const result = service.query({ query: 'rebuild-word', limit: 50 });
    expect(result.index.state).toBe('ready');
    expect(result.hits).toHaveLength(30);

    const status = service.rebuild();
    expect(status).toMatchObject({ state: 'indexing', pendingSessions: 1, pendingEvents: 31 });
    expect(storage.search.docCount()).toBe(0);
    service.close();
    const rebuilt = search(storage);
    expect(rebuilt.query({ query: 'rebuild-word', limit: 50 }).hits).toHaveLength(30);
  });

  it('索引追不完时查询结果标 indexing，不当作没有历史', () => {
    const storage = open();
    session(storage, S1, WS1);
    user(storage, S1, 'trn_1', 'lagging-word');
    for (let i = 0; i < 3000; i += 1) delta(storage, S1, 'trn_1', 'x');
    user(storage, S1, 'trn_2', 'lagging-word late');
    const service = new SessionSearch({ storage, onError: vi.fn() });
    const result = service.query({ query: 'lagging-word' });
    expect(result.index.state).toBe('indexing');
    expect(result.index.pendingEvents).toBeGreaterThan(0);
    expect(result.hits).toHaveLength(1);
    expect(service.query({ query: 'lagging-word' }).index.state).toBe('ready');
  });

  it('扫描有上限：只看范围内最新的若干条，complete 为 false', () => {
    const storage = open();
    session(storage, S1, WS1);
    user(storage, S1, 'trn_0', '旧的登录');
    for (let i = 1; i <= 5; i += 1) user(storage, S1, `trn_${i}`, `other ${i}`);
    const service = search(storage, { scanLimit: 3 });
    const result = service.query({ query: '登录' });
    expect(result.hits).toEqual([]);
    expect(result.scan).toEqual({ examined: 3, limit: 3, complete: false });
  });

  it('版本变了或索引坏了就重建，Host 照常打开库', () => {
    const storage = open();
    session(storage, S1, WS1);
    user(storage, S1, 'trn_1', 'version-word');
    search(storage).close();
    storage.db.exec("UPDATE search_meta SET value = '0' WHERE key = 'version'");
    storage.search.ensure();
    expect(storage.search.docCount()).toBe(0);
    expect(storage.search.pending().sessions).toBe(1);

    const onError = vi.fn();
    const service = new SessionSearch({ storage, onError });
    service.catchUp(Number.MAX_SAFE_INTEGER);
    const match = vi.spyOn(storage.search, 'match').mockImplementationOnce(() => {
      throw new Error('database disk image is malformed');
    });
    const result = service.query({ query: 'version-word' });
    expect(onError).toHaveBeenCalledOnce();
    expect(result.hits).toEqual([]);
    expect(result.index.state).toBe('indexing');
    match.mockRestore();
    expect(service.query({ query: 'version-word' }).hits).toHaveLength(1);
    service.close();
  });

  it('没有 FTS5 时全部走扫描，并说明原因', () => {
    const storage = open();
    session(storage, S1, WS1);
    user(storage, S1, 'trn_1', 'no-fts-word');
    const service = search(storage);
    vi.spyOn(storage.search, 'fts', 'get').mockReturnValue(false);
    const result = service.query({ query: 'no-fts-word' });
    expect(result).toMatchObject({ mode: 'scan', reason: 'fts_unavailable' });
    expect(result.hits).toHaveLength(1);
    expect(result.index.fts).toBe(false);
  });
});

describe('经 Host API（真实会话：撤销、重做、归档、删除）', () => {
  const managers: SessionManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  });

  it('search.query 与会话里看到的一致；空查询是 INVALID_PARAMS', async () => {
    const root = tempDir();
    const storage = storages.open(join(root, 'data'));
    const workspaceDir = join(root, 'ws');
    mkdirSync(workspaceDir);
    const T = '2026-10-21T00:00:00.000Z';
    storage.workspaces.insert({
      id: 'ws_1',
      rootPath: workspaceDir,
      displayName: 'ws',
      createdAt: T,
      updatedAt: T,
    });
    storage.providers.insert({
      id: 'mock',
      kind: 'openai-compatible',
      displayName: 'Mock',
      api: 'openai-completions',
      baseURL: 'http://127.0.0.1:9/v1',
      models: [{ id: 'm' }],
      defaultModelId: 'm',
      createdAt: T,
      updatedAt: T,
    });
    const events = new EventStore({ storage, deltaWindowMs: 5 });
    const manager = new SessionManager({
      storage,
      events,
      adapter: new EchoAdapter({ stepDelayMs: 0 }),
      onError: () => {},
    });
    managers.push(manager);
    const search = new SessionSearch({ storage, onError: vi.fn() });
    events.listenAll(() => search.notify());
    const methods = createHostMethods({
      storage,
      events,
      sessions: manager,
      secrets: new FileSecretStore(join(root, 'data')),
      search,
    });
    const context = { client: identity, capabilities: {} };
    const { id } = await manager.create({ workspaceId: 'ws_1', providerId: 'mock' });
    await manager.send(
      { sessionId: id, content: [{ type: 'text', text: '第一轮 alpha-word' }] },
      identity,
    );
    await vi.waitFor(() => expect(events.snapshot(id)?.session.state).toBe('idle'));
    await manager.send(
      { sessionId: id, content: [{ type: 'text', text: '第二轮 beta-word' }] },
      identity,
    );
    await vi.waitFor(() => expect(events.snapshot(id)?.session.state).toBe('idle'));
    const hits = async (query: string, includeArchived = false) =>
      (await methods['search.query']({ query, scope: { includeArchived } }, context)).hits.filter(
        (hit) => hit.kind === 'user_message',
      );

    expect(await hits('beta-word')).toHaveLength(1);
    await methods['session.undo']({ sessionId: id }, context);
    expect(await hits('beta-word')).toEqual([]);
    expect(await hits('alpha-word')).toHaveLength(1);
    await methods['session.redo']({ sessionId: id }, context);
    expect(await hits('beta-word')).toHaveLength(1);

    await methods['session.archive']({ sessionId: id, archived: true }, context);
    expect(await hits('alpha-word')).toEqual([]);
    expect((await hits('alpha-word', true))[0]?.archived).toBe(true);
    await methods['session.delete']({ sessionId: id }, context);
    expect(await hits('alpha-word', true)).toEqual([]);
    expect(storage.search.docCount()).toBe(0);

    await expect(
      (async () => methods['search.query']({ query: '"" ""' }, context))(),
    ).rejects.toSatisfy((error) => error instanceof HostError && error.code === 'INVALID_PARAMS');
    expect(await methods['search.status']({}, context)).toMatchObject({
      state: 'ready',
      fts: true,
    });
    search.close();
  });
});
