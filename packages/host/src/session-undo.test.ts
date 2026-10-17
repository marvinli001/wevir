// 撤销与重做（0.51.0，domain-model §3.22）：session.undo 把目录还原到最后一个回合开始前、隐藏这个回合并告诉引擎，session.redo 再带回来。
// echo 引擎不改文件，回合里“agent 改的文件”由测试在 send 返回（“前”快照已经打好）之后直接写。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionId, TurnId, WevirEvent } from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { FileSecretStore } from '@wevir/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TurnCheckpoints } from './checkpoints.js';
import { EventStore } from './event-store.js';
import { createHostMethods } from './host-methods.js';
import { SessionManager, undoRedoNote } from './session-manager.js';
import { identity, useStorages, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const storages = useStorages();
const T0 = '2026-10-17T00:00:00.000Z';
const context = { client: identity, capabilities: {} };
const managers: SessionManager[] = [];
const services: TurnCheckpoints[] = [];
let harnesses = 0;
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  await Promise.all(services.splice(0).map((service) => service.dispose()));
});

function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
}

function setup(options: { adapter?: EchoAdapter; git?: boolean; checkpoints?: boolean } = {}) {
  harnesses += 1;
  const root = join(realpathSync(tempDir()), `h${harnesses}`);
  mkdirSync(root);
  const dataDir = join(root, 'data');
  const storage = storages.open(dataDir);
  const workspaceDir = join(root, 'ws');
  mkdirSync(workspaceDir);
  if (options.git !== false) {
    sh(workspaceDir, 'init', '-q', '-b', 'main');
    // Windows 上 git 默认 core.autocrlf=true，还原会把 LF 的文件写成 CRLF；这里测的是还原哪些文件，行尾由仓库自己定。
    sh(workspaceDir, 'config', 'core.autocrlf', 'false');
    writeFileSync(join(workspaceDir, 'a.txt'), 'base\n');
    sh(workspaceDir, 'add', '.');
    sh(workspaceDir, 'commit', '-q', '-m', 'init');
  }
  storage.workspaces.insert({
    id: 'ws_1',
    rootPath: workspaceDir,
    displayName: 'ws',
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
  const warnings: unknown[] = [];
  const events = new EventStore({ storage, deltaWindowMs: 5, onError: (e) => errors.push(e) });
  const checkpoints = new TurnCheckpoints({
    isOpen: (id) => storage.sessions.get(id)?.state !== 'closed',
  });
  services.push(checkpoints);
  const manager = new SessionManager({
    storage,
    events,
    adapter: options.adapter ?? new EchoAdapter({ stepDelayMs: 0 }),
    onError: (e) => errors.push(e),
    onWarning: (message) => warnings.push(message),
    ...(options.checkpoints !== false && { checkpoints }),
  });
  managers.push(manager);
  const methods = createHostMethods({
    storage,
    events,
    sessions: manager,
    secrets: new FileSecretStore(dataDir),
    checkpoints,
  });
  const create = async () =>
    (
      await manager.create({
        workspaceId: 'ws_1',
        providerId: 'mock',
        permissionMode: 'full_access',
      })
    ).id;
  /** 发一条消息，并在 send 返回（回合开始前的快照已打好）之后写 `edits`，像 agent 在回合里改了文件。 */
  const turn = async (sessionId: SessionId, text: string, edits: Record<string, string> = {}) => {
    const { turnId } = await manager.send(
      { sessionId, content: [{ type: 'text', text }] },
      identity,
    );
    for (const [file, content] of Object.entries(edits)) {
      writeFileSync(join(workspaceDir, file), content);
    }
    await settle(sessionId);
    return turnId as TurnId;
  };
  const state = (sessionId: SessionId) => events.snapshot(sessionId)?.session.state;
  const settle = (sessionId: SessionId) =>
    vi.waitFor(() => expect(state(sessionId)).toBe('idle'), { timeout: 5000 });
  const all = (sessionId: SessionId): WevirEvent[] => events.readSince(sessionId, 0);
  const answer = (sessionId: SessionId) => {
    const last = all(sessionId).findLast((e) => e.type === 'assistant.message');
    return last?.type === 'assistant.message' ? last.payload.text : undefined;
  };
  const read = (file: string) => readFileSync(join(workspaceDir, file), 'utf8');
  const has = (file: string) => existsSync(join(workspaceDir, file));
  const undo = (sessionId: SessionId, turnId?: TurnId) =>
    methods['session.undo']({ sessionId, ...(turnId && { turnId }) }, context);
  const redo = (sessionId: SessionId, turnId?: TurnId) =>
    methods['session.redo']({ sessionId, ...(turnId && { turnId }) }, context);
  return {
    manager,
    methods,
    errors,
    warnings,
    workspaceDir,
    create,
    turn,
    settle,
    all,
    answer,
    read,
    has,
    undo,
    redo,
  };
}

const eventsOf = (events: readonly WevirEvent[], type: string) =>
  events.filter((event) => event.type === type);

describe('session.undo / session.redo（0.51.0）', { timeout: 30_000 }, () => {
  it('撤销最后一个回合：文件回到回合开始前，写 turn.undone；连着撤销，再按相反的顺序重做；引擎历史不动，收到说明', async () => {
    const h = setup();
    const session = await h.create();
    const first = await h.turn(session, 'one', { 'a.txt': 'edit one\n' });
    const second = await h.turn(session, 'two', { 'a.txt': 'edit two\n', 'new.txt': 'n\n' });

    const undone = await h.undo(session);
    expect(undone).toMatchObject({
      turnId: second,
      files: { status: 'restored', fileCount: 2 },
    });
    expect(h.read('a.txt')).toBe('edit one\n');
    expect(h.has('new.txt')).toBe(false);
    expect(eventsOf(h.all(session), 'turn.undone').at(-1)).toMatchObject({
      seq: undone.seq,
      source: 'host',
      payload: { turnId: second, files: { status: 'restored', fileCount: 2 } },
    });

    expect(await h.undo(session, first)).toMatchObject({ turnId: first });
    expect(h.read('a.txt')).toBe('base\n');

    // 重做先回最近撤销的。
    expect(await h.redo(session)).toMatchObject({ turnId: first, files: { status: 'restored' } });
    expect(h.read('a.txt')).toBe('edit one\n');
    expect(await h.redo(session, second)).toMatchObject({ turnId: second });
    expect(h.read('a.txt')).toBe('edit two\n');
    expect(h.has('new.txt')).toBe(true);
    expect(eventsOf(h.all(session), 'turn.redone')).toHaveLength(2);

    // 引擎的历史没动（两个回合都还记得），四次撤销 / 重做各补了一条说明，下一次回复时“看到”。
    await h.turn(session, 'recall');
    const reply = h.answer(session) ?? '';
    expect(reply).toContain('History: one | two');
    expect(reply).toContain('Notes: The user undid your earlier turn for "two".');
    expect(reply).toContain('The user redid your earlier turn for "one", which they had undone');
    expect(h.errors).toEqual([]);
    expect(h.warnings).toEqual([]);
  });

  it('撤销之后会话开始新的回合：撤销的回合不能再重做，也不再出现', async () => {
    const h = setup();
    const session = await h.create();
    await h.turn(session, 'one', { 'a.txt': 'edit one\n' });
    const second = await h.turn(session, 'two', { 'a.txt': 'edit two\n' });
    await h.undo(session);
    await h.turn(session, 'three');
    await expect(h.redo(session)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    // 这个回合的事件还在，只是隐藏了；下一个撤销是新回合。
    expect(eventsOf(h.all(session), 'turn.undone').map((e) => e.payload)).toMatchObject([
      { turnId: second },
    ]);
    expect(await h.undo(session)).not.toMatchObject({ turnId: second });
  });

  it('turnId 对不上、没有可撤销的回合、没有可重做的回合：INVALID_STATE，什么都不写', async () => {
    const h = setup();
    const session = await h.create();
    await expect(h.undo(session)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(h.redo(session)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const first = await h.turn(session, 'one', { 'a.txt': 'edit one\n' });
    await h.turn(session, 'two');
    await expect(h.undo(session, first)).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(eventsOf(h.all(session), 'turn.undone')).toEqual([]);
    expect(h.read('a.txt')).toBe('edit one\n');
  });

  it('回合进行中回 SESSION_BUSY；子会话与不存在的会话照常报错', async () => {
    const h = setup({ adapter: new EchoAdapter({ stepDelayMs: 25 }) });
    const session = await h.create();
    await h.turn(session, 'one');
    await h.manager.send(
      { sessionId: session, content: [{ type: 'text', text: 'slow two' }] },
      identity,
    );
    await expect(h.undo(session)).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    await expect(h.redo(session)).rejects.toMatchObject({ code: 'SESSION_BUSY' });
    await h.settle(session);
    await expect(
      h.methods['session.undo'](
        { sessionId: 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR' as SessionId },
        context,
      ),
    ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
  });

  it('回合开始后 HEAD 动过：对话照样撤销，文件不动，files 说明原因', async () => {
    const h = setup();
    const session = await h.create();
    const first = await h.turn(session, 'one', { 'a.txt': 'agent commit\n' });
    sh(h.workspaceDir, 'commit', '-q', '-am', 'agent commit');
    const result = await h.undo(session);
    expect(result).toMatchObject({
      turnId: first,
      files: { status: 'unavailable', reason: 'head_moved' },
    });
    expect(h.read('a.txt')).toBe('agent commit\n');
    expect(eventsOf(h.all(session), 'turn.undone')).toHaveLength(1);
  });

  it('目录不在 git 仓库里、没有回合快照：对话照样撤销，说明文件没还原', async () => {
    const plain = setup({ git: false });
    const session = await plain.create();
    await plain.turn(session, 'one', { 'x.txt': 'x\n' });
    expect(await plain.undo(session)).toMatchObject({
      files: { status: 'unavailable', reason: 'not_git' },
    });

    const none = setup({ checkpoints: false });
    const other = await none.create();
    await none.turn(other, 'one', { 'a.txt': 'edit\n' });
    expect(await none.undo(other)).toMatchObject({
      files: { status: 'unavailable', reason: 'no_checkpoint' },
    });
    expect(none.read('a.txt')).toBe('edit\n');
    expect(await none.redo(other)).toMatchObject({
      files: { status: 'unavailable', reason: 'no_checkpoint' },
    });
  });

  it('撤销之后编辑重发（session.rewind）：引擎把被撤销的回合一并退掉，每个回合写一条 turn.rewound', async () => {
    const h = setup();
    const session = await h.create();
    await h.turn(session, 'one');
    const second = await h.turn(session, 'two');
    const third = await h.turn(session, 'three');
    await h.undo(session);
    await expect(
      h.methods['session.rewind']({ sessionId: session, turnId: third }, context),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await h.methods['session.rewind']({ sessionId: session, turnId: second }, context);
    expect(eventsOf(h.all(session), 'turn.rewound').map((e) => e.payload)).toEqual([
      { turnId: third },
      { turnId: second },
    ]);
    await h.turn(session, 'recall');
    expect(h.answer(session)).toContain('History: one');
    expect(h.answer(session)).not.toContain('History: one | two');
  });

  it('分支：从看得见的回合分，引擎只带到那个回合；被撤销的回合分不了', async () => {
    const h = setup();
    const session = await h.create();
    await h.turn(session, 'one');
    const second = await h.turn(session, 'two');
    const third = await h.turn(session, 'three');
    await h.undo(session);
    await expect(
      h.methods['session.fork']({ sessionId: session, turnId: third }, context),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    const { session: branch } = await h.methods['session.fork'](
      { sessionId: session, turnId: second },
      context,
    );
    await h.turn(branch.id, 'recall');
    expect(h.answer(branch.id)).toBe('Echo: recall\n\nHistory: one | two');
    // 省略 turnId：分到最后一个看得见的回合。
    const { session: latest } = await h.methods['session.fork']({ sessionId: session }, context);
    await h.turn(latest.id, 'recall');
    expect(h.answer(latest.id)).toBe('Echo: recall\n\nHistory: one | two');
  });

  it('引擎收不了补进上下文的说明：INVALID_STATE', async () => {
    const adapter = new EchoAdapter({ stepDelayMs: 0 });
    (adapter as { injectNote?: unknown }).injectNote = undefined;
    const h = setup({ adapter });
    const session = await h.create();
    await h.turn(session, 'one');
    await expect(h.undo(session)).rejects.toMatchObject({ code: 'INVALID_STATE' });
  });
});

describe('undoRedoNote', () => {
  it('写明回合与文件的状态；文件没还原时让模型自己核对', () => {
    expect(
      undoRedoNote('undo', 'fix the bug', { status: 'restored', fileCount: 1 }).split('\n\n'),
    ).toEqual([
      'The user undid your earlier turn for "fix the bug". Treat that turn as if it had not happened.',
      'Its file changes were reverted automatically (1 file); the working directory is back to how it was before that turn.',
    ]);
    expect(undoRedoNote('undo', undefined, { status: 'unavailable', reason: 'not_git' })).toContain(
      'could NOT be reverted',
    );
    expect(undoRedoNote('redo', 'x', { status: 'restored', fileCount: 2 })).toContain(
      'The user redid your earlier turn for "x"',
    );
    expect(undoRedoNote('redo', 'x', { status: 'unavailable' })).toContain('could NOT be restored');
  });
});
