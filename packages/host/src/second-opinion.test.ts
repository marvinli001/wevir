// 第二意见（0.75.0，domain-model §3.30）：对着真实的 git 打快照、开意见会话、记下意见、引用，以及拒绝的情形与启动对账。echo 引擎
// 把收到的消息原样答回来，意见就是发给意见会话的那段材料。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OpinionId, SecondOpinion, SessionId, WevirEvent } from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { FileSecretStore } from '@wevir/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppToolError } from './app-mcp.js';
import { AppTools } from './app-tools.js';
import { EventStore } from './event-store.js';
import { createHostMethods } from './host-methods.js';
import { RoleStore } from './roles.js';
import { SecondOpinionService } from './second-opinion.js';
import { SessionManager } from './session-manager.js';
import { identity, useStorages, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const storages = useStorages();
const T0 = '2026-10-20T00:00:00.000Z';
const context = { client: identity, capabilities: {} };
const managers: SessionManager[] = [];
let harnesses = 0;
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
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

/** 一个仓库：main 上一个提交，分支 fix-login 上又一个提交，再加没提交的修改与一个未跟踪文件。 */
function repo(dir: string): void {
  sh(dir, 'init', '-q', '-b', 'main');
  // Host 自己跑的 git 读系统配置；Windows 的 core.autocrlf=true 会让快照 worktree 里的文件变成 CRLF。
  sh(dir, 'config', 'core.autocrlf', 'false');
  sh(dir, 'config', 'user.name', 't');
  sh(dir, 'config', 'user.email', 't@example.com');
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'init');
  sh(dir, 'switch', '-q', '-c', 'fix-login');
  writeFileSync(join(dir, 'login.ts'), 'export const retry = 1;\n');
  sh(dir, 'add', '.');
  sh(dir, 'commit', '-q', '-m', 'login');
  writeFileSync(join(dir, 'a.txt'), 'one\ntwo\n');
  writeFileSync(join(dir, 'new.txt'), 'untracked\n');
}

function setup(options: { git?: boolean; wire?: boolean } = {}) {
  harnesses += 1;
  const root = join(realpathSync(tempDir()), `h${harnesses}`);
  mkdirSync(root);
  const dataDir = join(root, 'data');
  const storage = storages.open(dataDir);
  const workspaceDir = join(root, 'ws');
  mkdirSync(workspaceDir);
  if (options.git !== false) repo(workspaceDir);
  storage.workspaces.insert({
    id: 'ws_1',
    rootPath: workspaceDir,
    displayName: 'ws',
    createdAt: T0,
    updatedAt: T0,
  });
  for (const id of ['mock', 'other']) {
    storage.providers.insert({
      id,
      kind: 'openai-compatible',
      displayName: id,
      api: 'openai-completions',
      baseURL: 'http://127.0.0.1:9/v1',
      models: [{ id: 'm' }],
      defaultModelId: 'm',
      createdAt: T0,
      updatedAt: T0,
    });
  }
  const errors: unknown[] = [];
  const events = new EventStore({ storage, deltaWindowMs: 5, onError: (e) => errors.push(e) });
  let opinions: SecondOpinionService | undefined;
  const manager = new SessionManager({
    storage,
    events,
    adapter: new EchoAdapter({ stepDelayMs: 0 }),
    worktreesDir: join(dataDir, 'worktrees'),
    onTurnFinished: (info) => {
      if (options.wire !== false) opinions?.onTurnFinished(info);
    },
    onError: (e) => errors.push(e),
  });
  managers.push(manager);
  opinions = new SecondOpinionService({
    storage,
    events,
    sessions: manager,
    hostId: 'hst_1',
  });
  const service = opinions;
  const methods = createHostMethods({
    storage,
    events,
    sessions: manager,
    secrets: new FileSecretStore(dataDir),
    opinions: service,
  });
  const create = async () => (await manager.create({ workspaceId: 'ws_1', providerId: 'mock' })).id;
  const send = (sessionId: SessionId, text: string) =>
    manager.send({ sessionId, content: [{ type: 'text', text }] }, identity);
  const state = (sessionId: SessionId) => events.snapshot(sessionId)?.session.state;
  const settle = (sessionId: SessionId) =>
    vi.waitFor(() => expect(state(sessionId)).toBe('idle'), {
      timeout: process.platform === 'win32' ? 60_000 : 15_000,
    });
  const all = (sessionId: SessionId): WevirEvent[] => events.readSince(sessionId, 0);
  const opinionsOf = (sessionId: SessionId): SecondOpinion[] =>
    events.snapshot(sessionId)?.opinions ?? [];
  /** 一个会话：问过一个问题、答完了。 */
  const origin = async () => {
    const id = await create();
    await send(id, '修一下登录失败后的重试');
    await settle(id);
    return id;
  };
  return {
    root,
    workspaceDir,
    storage,
    events,
    manager,
    methods,
    service,
    errors,
    create,
    send,
    settle,
    all,
    opinionsOf,
    origin,
  };
}

function firstMessage(events: readonly WevirEvent[]): string {
  const message = events.find((event) => event.type === 'user.message');
  if (message?.type !== 'user.message') throw new Error('no user message');
  const part = message.payload.content[0];
  return part?.type === 'text' ? part.text : '';
}

describe('session.secondOpinion', () => {
  it('在快照 worktree 里开意见会话，回合结束后记成原会话里的意见，不进原会话的回合', async () => {
    const h = setup();
    const originId = await h.origin();
    const before = h.all(originId).length;
    const { opinion, session } = await h.methods['session.secondOpinion'](
      { sessionId: originId, providerId: 'other', focus: '  重试会不会重复提交  ' },
      context,
    );
    expect(opinion).toMatchObject({
      status: 'running',
      sessionId: session.id,
      providerId: 'other',
      requestedBy: 'user',
      focus: '重试会不会重复提交',
      basis: { branch: 'fix-login', head: sh(h.workspaceDir, 'rev-parse', 'HEAD').trim() },
    });
    expect(opinion.basis.base).toBe(sh(h.workspaceDir, 'rev-parse', 'main').trim());
    expect(session.opinionOf).toEqual({ sessionId: originId, opinionId: opinion.id });
    expect(session.worktrees?.[0]?.branch).toMatch(/^wevir\/opinion-/);
    // 快照：同样的文件，没提交的改动还是没提交的、新文件是未跟踪的；原目录没动。
    expect(readFileSync(join(session.cwd, 'a.txt'), 'utf8')).toBe('one\ntwo\n');
    expect(readFileSync(join(session.cwd, 'new.txt'), 'utf8')).toBe('untracked\n');
    expect(sh(session.cwd, 'status', '--porcelain').split('\n').filter(Boolean).sort()).toEqual([
      ' M a.txt',
      '?? new.txt',
    ]);
    expect(sh(h.workspaceDir, 'status', '--porcelain').split('\n').filter(Boolean).sort()).toEqual([
      ' M a.txt',
      '?? new.txt',
    ]);
    // 材料：角色说明、原会话、改动的看法、用户的话、侧重点、改动的文件。
    const brief = firstMessage(h.all(session.id));
    expect(brief).toContain('"reviewer" role');
    expect(brief).toContain(originId);
    expect(brief).toContain(`git diff ${opinion.basis.base}`);
    expect(brief).toContain('> 修一下登录失败后的重试');
    expect(brief).toContain('> 重试会不会重复提交');
    expect(brief).toMatch(/- modified a\.txt/);
    expect(brief).toMatch(/- \w+ login\.ts/);
    expect(brief).not.toContain('{{');

    await h.settle(session.id);
    await vi.waitFor(() => expect(h.opinionsOf(originId)[0]?.status).toBe('ready'));
    const ready = h.opinionsOf(originId)[0];
    expect(ready).toMatchObject({ outcome: 'completed', id: opinion.id });
    expect(ready?.text).toContain('重试会不会重复提交');
    // 原会话只多了意见的事件，没有开回合。
    const added = h.all(originId).slice(before);
    expect(added.map((event) => event.type)).toEqual(['opinion.updated', 'opinion.updated']);
    expect(h.events.snapshot(originId)?.session.state).toBe('idle');
    expect(h.errors).toEqual([]);
  });

  it('引用：拼成一条带来源的消息发给原会话，只引用一次', async () => {
    const h = setup();
    const originId = await h.origin();
    const { opinion, session } = await h.methods['session.secondOpinion'](
      { sessionId: originId, providerId: 'other' },
      context,
    );
    await h.settle(session.id);
    await vi.waitFor(() => expect(h.opinionsOf(originId)[0]?.status).toBe('ready'));
    const quoted = await h.methods['session.quoteOpinion'](
      { sessionId: originId, opinionId: opinion.id, note: ' 先改第一条 ' },
      context,
    );
    expect(quoted.turnId).toBeDefined();
    expect(quoted.opinion.quoted?.turnId).toBe(quoted.turnId);
    const message = h
      .all(originId)
      .findLast((event) => event.type === 'user.message' && event.payload.turnId === quoted.turnId);
    if (message?.type !== 'user.message') throw new Error('no quote message');
    expect(message.payload.from).toEqual({
      sessionId: session.id,
      kind: 'report',
      opinion: { opinionId: opinion.id, note: '先改第一条' },
    });
    const text = message.payload.content[0]?.type === 'text' ? message.payload.content[0].text : '';
    expect(text).toContain('<second-opinion>');
    expect(text).toContain("The user's note:\n\n先改第一条");
    expect(h.opinionsOf(originId)[0]?.quoted).toEqual(quoted.opinion.quoted);
    await expect(
      h.methods['session.quoteOpinion']({ sessionId: originId, opinionId: opinion.id }, context),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await h.settle(originId);
  });

  it('还没好的意见不能引用；不认识的意见是 INVALID_PARAMS', async () => {
    const h = setup({ wire: false });
    const originId = await h.origin();
    const { opinion, session } = await h.methods['session.secondOpinion'](
      { sessionId: originId, providerId: 'other' },
      context,
    );
    await expect(
      h.methods['session.quoteOpinion']({ sessionId: originId, opinionId: opinion.id }, context),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await expect(
      h.methods['session.quoteOpinion'](
        { sessionId: originId, opinionId: 'opn_missing' as OpinionId },
        context,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    await h.settle(session.id);
  });

  it('agent 请的意见好了自动引用给它', async () => {
    const h = setup();
    const originId = await h.origin();
    const { opinion, session } = await h.service.request(
      originId,
      { providerId: 'other', requestedBy: 'agent' },
      undefined,
    );
    await h.settle(session.id);
    await vi.waitFor(() => expect(h.opinionsOf(originId)[0]?.quoted).toBeDefined());
    const message = h
      .all(originId)
      .findLast((event) => event.type === 'user.message' && event.payload.from !== undefined);
    if (message?.type !== 'user.message') throw new Error('no quote message');
    expect(message.payload.from?.opinion?.opinionId).toBe(opinion.id);
    const text = message.payload.content[0]?.type === 'text' ? message.payload.content[0].text : '';
    expect(text).toContain('Here is the second opinion you asked');
    await h.settle(originId);
  });

  it('agent 工具 wevir_second_opinion：开意见、归在 sessions 组，意见会话里没有它', async () => {
    const h = setup();
    const originId = await h.origin();
    const tools = new AppTools({
      storage: h.storage,
      events: h.events,
      sessions: h.manager,
      hostId: 'hst_1',
      sendWhileBusy: () => 'queue',
      opinions: h.service,
      roles: new RoleStore({ dir: join(h.root, 'roles') }),
    });
    const tool = tools.tools.find((item) => item.name === 'wevir_second_opinion');
    if (tool === undefined) throw new Error('no wevir_second_opinion');
    expect(tool.annotations.readOnlyHint).toBe(false);
    const result = await tool.call(
      { providerId: 'other', focus: '看重试' },
      { sessionId: originId, signal: new AbortController().signal },
    );
    const value = result.structuredContent as { opinionId: OpinionId; sessionId: SessionId };
    expect(h.opinionsOf(originId)[0]).toMatchObject({
      id: value.opinionId,
      requestedBy: 'agent',
      focus: '看重试',
    });
    await expect(
      tool.call(
        { providerId: 'mock' },
        { sessionId: value.sessionId, signal: new AbortController().signal },
      ),
    ).rejects.toBeInstanceOf(AppToolError);
    // 意见会话用 reviewer 角色：只读的应用级工具，没有 wevir_second_opinion。
    const allowed = await tools.filterTools(value.sessionId, tools.tools);
    expect(allowed.map((item) => item.name)).not.toContain('wevir_second_opinion');
    expect(allowed.map((item) => item.name)).toContain('wevir_session_read');
    await h.settle(value.sessionId);
    await vi.waitFor(() => expect(h.opinionsOf(originId)[0]?.quoted).toBeDefined());
    await h.settle(originId);
  });

  it('拒绝：不在 git 仓库、意见会话再要意见、同时进行中的太多', { timeout: 90_000 }, async () => {
    const plain = setup({ git: false });
    const plainId = await plain.origin();
    await expect(
      plain.methods['session.secondOpinion']({ sessionId: plainId, providerId: 'other' }, context),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });

    const h = setup({ wire: false });
    const originId = await h.origin();
    const sessions: SessionId[] = [];
    for (let i = 0; i < 3; i += 1) {
      const { session } = await h.methods['session.secondOpinion'](
        { sessionId: originId, providerId: 'other' },
        context,
      );
      sessions.push(session.id);
    }
    await expect(
      h.methods['session.secondOpinion']({ sessionId: originId, providerId: 'other' }, context),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    const [first] = sessions;
    if (first === undefined) throw new Error('no opinion session');
    await expect(
      h.methods['session.secondOpinion']({ sessionId: first, providerId: 'mock' }, context),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await Promise.all(sessions.map((id) => h.settle(id)));
  });

  it('开不成会话时什么都不留', async () => {
    const h = setup();
    const originId = await h.origin();
    await expect(
      h.methods['session.secondOpinion']({ sessionId: originId, providerId: 'missing' }, context),
    ).rejects.toMatchObject({ code: 'PROVIDER_NOT_FOUND' });
    expect(h.opinionsOf(originId)).toEqual([]);
    expect(sh(h.workspaceDir, 'worktree', 'list').trim().split('\n')).toHaveLength(1);
  });

  it('启动对账：没记下的意见按意见会话第一个结束的回合补上', async () => {
    const h = setup({ wire: false });
    const originId = await h.origin();
    const { session } = await h.methods['session.secondOpinion'](
      { sessionId: originId, providerId: 'other' },
      context,
    );
    await h.settle(session.id);
    expect(h.opinionsOf(originId)[0]?.status).toBe('running');
    expect(h.service.recover()).toBe(1);
    expect(h.opinionsOf(originId)[0]).toMatchObject({ status: 'ready', outcome: 'completed' });
    expect(h.service.recover()).toBe(0);
  });

  it('删除意见会话时一并删掉它的 worktree', async () => {
    const h = setup();
    const originId = await h.origin();
    const { session } = await h.methods['session.secondOpinion'](
      { sessionId: originId, providerId: 'other' },
      context,
    );
    await h.settle(session.id);
    const root = session.worktrees?.[0]?.path;
    expect(root !== undefined && existsSync(root)).toBe(true);
    await h.methods['session.archive']({ sessionId: session.id, archived: true }, context);
    await h.methods['session.delete']({ sessionId: session.id, force: true }, context);
    expect(root !== undefined && existsSync(root)).toBe(false);
  });
});
