// Agent 分出自己（`SessionManager.agentFork`，`wevir_session_create` 的 `context: "fork"`）：对着 EchoAdapter 的会话与真实的 git
// 仓库。引擎能分支时原生分支，不能时新建会话、随第一条消息交接力材料；都记 `openedBy`，都可以开在新的 worktree 里。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionId, WevirEvent } from '@wevir/protocol';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { FileSecretStore } from '@wevir/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventStore } from './event-store.js';
import { createHostMethods } from './host-methods.js';
import { SessionManager } from './session-manager.js';
import { identity, useStorages, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const storages = useStorages();
const context = { client: identity, capabilities: {} };

function git(cwd: string, ...args: string[]): string {
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

const managers: SessionManager[] = [];
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
});

async function setup(options: { branches?: boolean } = {}) {
  const adapter = new EchoAdapter({ stepDelayMs: 0 });
  // 不能分支的引擎（Claude、OpenCode、ACP 系）：适配器不声明 `branches`。
  if (options.branches === false) Object.defineProperty(adapter, 'branches', { value: false });
  const root = realpathSync(tempDir());
  const dataDir = join(root, 'data');
  mkdirSync(dataDir);
  const storage = storages.open(dataDir);
  const events = new EventStore({ storage, deltaWindowMs: 5 });
  const worktreesDir = join(dataDir, 'worktrees');
  const sessions = new SessionManager({
    storage,
    events,
    adapter,
    worktreesDir,
    historyDir: join(dataDir, 'history'),
  });
  managers.push(sessions);
  const methods = createHostMethods({
    storage,
    events,
    sessions,
    secrets: new FileSecretStore(dataDir),
  });
  storage.providers.insert({
    id: 'mock',
    kind: 'openai-compatible',
    displayName: 'Mock',
    api: 'openai-completions',
    baseURL: 'http://127.0.0.1:9/v1',
    models: [{ id: 'm' }],
    defaultModelId: 'm',
    createdAt: '2026-10-30T00:00:00.000Z',
    updatedAt: '2026-10-30T00:00:00.000Z',
  });
  const dir = join(root, 'app');
  mkdirSync(dir);
  writeFileSync(join(dir, 'a.txt'), 'a\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  const { workspace } = await methods['workspace.add']({ rootPath: dir }, context);
  const { session } = await methods['session.create'](
    { workspaceId: workspace.id, providerId: 'mock', permissionMode: 'full_access' },
    context,
  );
  const sourceId = session.id as SessionId;
  const idle = (sessionId: SessionId) =>
    vi.waitFor(() => expect(events.snapshot(sessionId)?.session.state).toBe('idle'), {
      timeout: 20_000,
    });
  const send = async (sessionId: SessionId, text: string, wait = true) => {
    await sessions.send({ sessionId, content: [{ type: 'text', text }] }, identity);
    if (wait) await idle(sessionId);
  };
  const all = (sessionId: SessionId): WevirEvent[] => events.readSince(sessionId, 0);
  const answer = (sessionId: SessionId) => {
    const last = all(sessionId).findLast((e) => e.type === 'assistant.message');
    return last?.type === 'assistant.message' ? last.payload.text : '';
  };
  return {
    storage,
    events,
    sessions,
    worktreesDir,
    dataDir,
    dir,
    sourceId,
    idle,
    send,
    all,
    answer,
  };
}

describe('Agent 分出自己', () => {
  it('引擎能分支：原生分支到最近一个完成的回合，带 openedBy 与 forkedFrom、抄来消息记录，目录同被分的会话', async () => {
    const h = await setup();
    await h.send(h.sourceId, 'first ALPHA');
    const { session, via } = await h.sessions.agentFork(h.sourceId);
    expect(via).toBe('native');
    expect(session.openedBy).toEqual({ sessionId: h.sourceId });
    expect(session.forkedFrom).toMatchObject({ sessionId: h.sourceId });
    expect(session.permissionMode).toBe('full_access');
    expect(h.storage.sessions.get(session.id)?.cwd).toBe(h.storage.sessions.get(h.sourceId)?.cwd);
    expect(h.storage.sessions.get(session.id)?.origin).toEqual({
      kind: 'agent',
      sessionId: h.sourceId,
    });
    const copied = h.all(session.id).filter((e) => e.type === 'user.message');
    expect(copied).toHaveLength(1);
    await h.send(session.id, 'recall BRAVO');
    expect(h.answer(session.id)).toMatch(/History: .*ALPHA/);
    expect(h.answer(session.id)).not.toContain('Context handoff');
  });

  it('回合进行中：只分到最近一个完成的回合；没有完成的回合时拒绝', async () => {
    const h = await setup();
    await expect(h.sessions.agentFork(h.sourceId)).rejects.toThrow(/no finished turn/);
    await h.send(h.sourceId, 'first ALPHA');
    await h.send(h.sourceId, 'slow GAMMA', false);
    const { session, via } = await h.sessions.agentFork(h.sourceId);
    expect(via).toBe('native');
    await h.send(session.id, 'recall DELTA');
    expect(h.answer(session.id)).toMatch(/History: .*ALPHA/);
    expect(h.answer(session.id)).not.toContain('GAMMA');
    await h.idle(h.sourceId);
  });

  it('worktree：在新开的 worktree 里分支，记进会话的 worktrees；权限模式可以收窄', async () => {
    const h = await setup();
    await h.send(h.sourceId, 'first ALPHA');
    const { session } = await h.sessions.agentFork(h.sourceId, {
      worktree: true,
      permissionMode: 'auto_review',
    });
    const record = h.storage.sessions.get(session.id);
    expect(record?.cwd).not.toBe(h.dir);
    expect(record?.cwd.startsWith(join(h.worktreesDir, session.id))).toBe(true);
    expect(existsSync(join(record?.cwd ?? '', 'a.txt'))).toBe(true);
    expect(record?.worktrees).toEqual([
      expect.objectContaining({ branch: `wevir/${session.id.slice(-8).toLowerCase()}` }),
    ]);
    expect(session.permissionMode).toBe('auto_review');
    expect(session.openedBy).toEqual({ sessionId: h.sourceId });
    await h.send(session.id, 'recall BRAVO');
    expect(h.answer(session.id)).toMatch(/History: .*ALPHA/);
  });

  it('引擎不能分支：新建同一来源与目录的会话，到最近一个完成的回合的历史作为接力材料随第一条消息交出，消息记录里只有简报', async () => {
    const h = await setup({ branches: false });
    await h.send(h.sourceId, 'first ALPHA');
    await h.send(h.sourceId, 'slow GAMMA', false);
    const { session, via } = await h.sessions.agentFork(h.sourceId);
    expect(via).toBe('handoff');
    expect(session.forkedFrom).toBeUndefined();
    expect(session.openedBy).toEqual({ sessionId: h.sourceId });
    expect(session.permissionMode).toBe('full_access');
    expect(h.storage.sessions.get(session.id)?.cwd).toBe(h.storage.sessions.get(h.sourceId)?.cwd);
    expect(h.storage.sessions.get(session.id)?.worktrees).toBeUndefined();
    await h.send(session.id, 'brief ECHO');
    const answer = h.answer(session.id);
    expect(answer).toContain('Context handoff (fork_summary)');
    expect(answer).toContain(`You are a fork of Wevir session ${h.sourceId}`);
    expect(answer).toContain('first ALPHA');
    expect(answer).not.toContain('GAMMA');
    expect(answer).toContain('brief ECHO');
    const messages = h.all(session.id).filter((e) => e.type === 'user.message');
    expect(messages).toHaveLength(1);
    expect(JSON.stringify(messages[0]?.payload)).not.toContain('Context handoff');
    // 材料只交一次。
    await h.send(session.id, 'again FOXTROT');
    expect(h.answer(session.id)).not.toContain('Context handoff');
    await h.idle(h.sourceId);
  });

  it('引擎不能分支时也可以开在新的 worktree 里', async () => {
    const h = await setup({ branches: false });
    await h.send(h.sourceId, 'first ALPHA');
    const { session, via } = await h.sessions.agentFork(h.sourceId, { worktree: true });
    expect(via).toBe('handoff');
    const record = h.storage.sessions.get(session.id);
    expect(record?.cwd.startsWith(join(h.worktreesDir, session.id))).toBe(true);
    expect(record?.worktrees).toHaveLength(1);
    await h.send(session.id, 'brief ECHO');
    expect(h.answer(session.id)).toContain('Context handoff (fork_summary)');
  });
});
