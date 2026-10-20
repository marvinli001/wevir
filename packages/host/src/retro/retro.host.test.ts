// 任务回顾（0.76.0）：startHost 组装出的真实 Host，echo 引擎换成会改文件的子类，会话目录是 git 仓库，检查是真的 `node --test`。走一遍
// “改代码 → 检查失败 → 自动修复 → 复验通过 → 提交”，确认回顾里每一行都能点回正确的事件、验证记录、回合 diff 与提交；再看投影的
// 增量、重建与模型摘要。

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ErrorCode,
  type RetroRef,
  type SessionId,
  type SessionRetro,
  type WevirEvent,
} from '@wevir/protocol';
import type {
  AgentInput,
  EngineSession,
  SessionConfig,
  TitleRequest,
} from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startHost } from '../host-process.js';
import { createLogger } from '../logger.js';
import { TestRpcClient, useTempDir } from '../test-utils.js';

const WAIT_MS = 20_000;
const tempDir = useTempDir();
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// 提交用测试自己的身份，不读本机的全局 Git 配置（签名、钩子）。
const savedEnv = { ...process.env };
beforeEach(() => {
  const config = join(realpathSync(tempDir()), 'gitconfig');
  writeFileSync(config, '[user]\n\tname = Test\n\temail = t@example.com\n');
  process.env.GIT_CONFIG_GLOBAL = config;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
});
afterEach(() => {
  for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM']) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** 回合里“改代码”的 echo；`generateTitle` 返回 `summary`（模型摘要用），记下收到的输入。 */
class FileEcho extends EchoAdapter {
  onTurn: (cwd: string, text: string) => string | undefined = () => undefined;
  summary = '';
  readonly titleInputs: TitleRequest[] = [];
  readonly #cwds = new Map<string, string>();

  override async createSession(config: SessionConfig): Promise<EngineSession> {
    const session = await super.createSession(config);
    this.#cwds.set(session.engineSessionId, config.cwd);
    return session;
  }

  override async send(engineSessionId: string, input: AgentInput): Promise<void> {
    const text = input.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
    const replaced = this.onTurn(this.#cwds.get(engineSessionId) ?? '', text);
    await super.send(
      engineSessionId,
      replaced === undefined ? input : { ...input, content: [{ type: 'text', text: replaced }] },
    );
  }

  async generateTitle(_engineSessionId: string, request: TitleRequest): Promise<string> {
    this.titleInputs.push(request);
    request.onUsage?.({ inputTokens: 900, outputTokens: 60 });
    return this.summary;
  }
}

const CONV_TEST = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { toF } from './src/conv.mjs';",
  "test('converts', () => { assert.equal(toF(0), 32); });",
  '',
].join('\n');

function writeConv(cwd: string, offset: number, note = ''): void {
  writeFileSync(
    join(cwd, 'src', 'conv.mjs'),
    `${note}export function toF(c) { return (c * 9) / 5 + ${offset}; }\n`,
  );
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function makeRepo(root: string): string {
  const repo = join(root, 'project');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'conv.test.mjs'), CONV_TEST);
  writeConv(repo, 32);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init');
  return repo;
}

async function boot() {
  const root = realpathSync(tempDir());
  const home = join(root, 'home');
  const repo = makeRepo(root);
  const adapter = new FileEcho({ stepDelayMs: 1 });
  const host = await startHost({
    adapter,
    engine: 'echo',
    logger: createLogger({ level: 'error', mirror: () => {} }),
    home,
  });
  cleanups.push(() => host.shutdown());
  const token = (
    JSON.parse(readFileSync(join(home, 'run', 'host.json'), 'utf8')) as { token: string }
  ).token;
  const client = await TestRpcClient.connect(host.url);
  cleanups.push(() => client.ws.close());
  const hello = await client.hello(token);
  expect(hello.result.features.session_retro).toBe(true);
  const { workspace } = await client.request('workspace.add', { rootPath: repo });
  const workspaceId = workspace.id as string;
  await client.request('provider.upsert', {
    id: 'deepseek-official',
    kind: 'deepseek-official',
    displayName: 'DeepSeek',
    models: [],
    defaultModelId: 'deepseek-chat',
  });
  const { session } = await client.request('session.create', {
    workspaceId,
    providerId: 'deepseek-official',
  });
  const sessionId = session.id as SessionId;
  const { subscriptionId } = await client.request('events.subscribe', { sessionId, sinceSeq: 0 });
  const events = (): WevirEvent[] => client.events(subscriptionId);
  const until = <T>(pick: () => T | undefined, label: string) => client.until(pick, label, WAIT_MS);
  const retro = async (redact = false): Promise<SessionRetro> =>
    (await client.request('retro.get', { sessionId, ...(redact && { redact: true }) })).retro;
  return { adapter, client, repo, home, workspaceId, sessionId, events, until, retro };
}

/** 一行的出处能不能找到，指向的是不是它说的东西。 */
function checkRef(ref: RetroRef, events: readonly WevirEvent[], repo: string): void {
  switch (ref.kind) {
    case 'event': {
      const event = events.find((item) => item.seq === ref.seq);
      expect(event, `event ${ref.seq}`).toBeDefined();
      if (ref.turnId !== undefined) {
        const payload = event?.payload as { turnId?: string; approval?: { turnId: string } };
        expect(payload.turnId ?? payload.approval?.turnId, `turn of event ${ref.seq}`).toBe(
          ref.turnId,
        );
      }
      break;
    }
    case 'verification': {
      const event = events.find((item) => item.seq === ref.seq);
      expect(event?.type).toBe('verification.updated');
      if (event?.type === 'verification.updated') expect(event.payload.run.id).toBe(ref.runId);
      break;
    }
    case 'commit':
      expect(git(repo, 'cat-file', '-t', ref.sha)).toBe('commit');
      break;
    default:
      break;
  }
}

function allRefs(retro: SessionRetro): RetroRef[] {
  const refs: RetroRef[] = [];
  const add = (items: readonly { ref?: RetroRef }[]) => {
    for (const item of items) if (item.ref !== undefined) refs.push(item.ref);
  };
  if (retro.goal.goal) add([retro.goal.goal]);
  if (retro.goal.request) add([retro.goal.request]);
  add(retro.done);
  add(retro.open);
  add(retro.verification.commands);
  add(retro.review.comments);
  add(retro.decisions);
  add(retro.next);
  for (const check of retro.verification.checks) {
    refs.push({ kind: 'verification', runId: check.runId, seq: check.seq });
    for (const earlier of check.earlier ?? []) {
      refs.push({ kind: 'verification', runId: earlier.runId, seq: earlier.seq });
    }
  }
  for (const turn of retro.turns) refs.push({ kind: 'event', seq: turn.seq, turnId: turn.turnId });
  for (const commit of retro.changes.commits) refs.push({ kind: 'commit', sha: commit.sha });
  return refs;
}

describe('任务回顾：真实 Host', () => {
  it('改代码 → 检查失败 → 修复 → 通过 → 提交：每一行都点得回去', async () => {
    const h = await boot();
    h.adapter.onTurn = (cwd, text) => {
      if (text.includes('<check-output')) {
        writeConv(cwd, 32, '// fixed\n');
        return 'repaired';
      }
      writeConv(cwd, 0);
      return undefined;
    };
    await h.client.request('checks.save', {
      workspaceId: h.workspaceId,
      check: {
        name: 'test',
        command: 'node --test conv.test.mjs',
        kind: 'test',
        trigger: 'after_turn',
        paths: ['src/'],
      },
    });
    await h.client.request('checks.setRepair', {
      workspaceId: h.workspaceId,
      repair: { enabled: true },
    });

    // 还没有回合：投影是空的，什么都“未记录”。
    const empty = await h.retro();
    expect(empty).toMatchObject({ build: 'full', goal: { recorded: false }, turns: [] });
    expect(empty.verification.recorded).toBe(false);

    const { turnId } = await h.client.request('session.send', {
      sessionId: h.sessionId,
      content: [{ type: 'text', text: 'edit the converter' }],
    });
    await h.until(
      () =>
        h
          .events()
          .some(
            (event) =>
              event.type === 'acceptance.changed' && event.payload.acceptance.status === 'accepted',
          ) || undefined,
      'accepted',
    );
    await h.until(() => {
      const last = h
        .events()
        .filter((event) => event.type === 'session.state_changed')
        .at(-1);
      return last?.type === 'session.state_changed' && last.payload.to === 'idle'
        ? true
        : undefined;
    }, 'idle');

    // 修好之后、提交之前：检查通过且对应当前代码，有未提交的改动。
    const before = await h.retro();
    expect(before.build).toBe('incremental');
    expect(before.verification.checks).toHaveLength(1);
    const [check] = before.verification.checks;
    expect(check).toMatchObject({ name: 'test', status: 'passed', evidence: 'current' });
    expect(check?.earlier?.map((run) => [run.status, run.reason])).toEqual([
      ['failed', 'exit_code'],
    ]);
    expect(before.delivery).toMatchObject({ checks: 'passed', commit: 'uncommitted' });
    expect(before.next.map((n) => n.kind)).toContain('commit');

    // 用户提交。
    const status = await h.client.request('git.status', {
      workspaceId: h.workspaceId,
      sessionId: h.sessionId,
    });
    const staged = await h.client.request('git.stage', {
      workspaceId: h.workspaceId,
      sessionId: h.sessionId,
      paths: ['src/conv.mjs'],
      expected: { head: status.head, index: status.index },
    });
    const committed = await h.client.request('git.commit', {
      workspaceId: h.workspaceId,
      sessionId: h.sessionId,
      message: 'Fix the converter',
      expected: { head: staged.status.head, index: staged.status.index },
    });
    expect(committed.outcome.kind).toBe('committed');

    const retro = await h.retro();
    const events = h.events();
    // 目标：起始请求指向那条用户消息。
    expect(retro.goal.request?.text).toBe('edit the converter');
    const requestRef = retro.goal.request?.ref as { seq: number } | undefined;
    const request = events.find((event) => event.seq === requestRef?.seq);
    expect(request?.type).toBe('user.message');
    // 回合：用户回合与修复回合，都有回合 diff，改到 src/conv.mjs。
    expect(retro.turns.map((turn) => [turn.turnId === turnId, turn.kind, turn.diff])).toEqual([
      [true, 'user', 'available'],
      [false, 'repair', 'available'],
    ]);
    for (const turn of retro.turns) {
      expect(turn.files).toEqual(['src/conv.mjs']);
      const diff = await h.client.request('workspace.diff', {
        workspaceId: h.workspaceId,
        sessionId: h.sessionId,
        source: { kind: 'turn', turnId: turn.turnId },
      });
      expect(diff.files.map((file: { path: string }) => file.path)).toEqual(['src/conv.mjs']);
    }
    expect(retro.changes.files).toEqual([
      expect.objectContaining({ path: 'src/conv.mjs', diff: 'available' }),
    ]);
    // 提交：会话期间的提交就是这一个；工作树干净，没有上游。
    const head = git(h.repo, 'rev-parse', 'HEAD');
    expect(retro.changes.commits.map((commit) => [commit.sha, commit.subject])).toEqual([
      [head, 'Fix the converter'],
    ]);
    expect(retro.delivery).toEqual({
      checks: 'passed',
      commit: 'committed',
      push: 'no_upstream',
      ci: 'unknown',
      deploy: 'unknown',
    });
    // 只提交了、内容没变：通过的仍是当前代码。
    expect(retro.verification.checks[0]?.evidence).toBe('current');
    expect(retro.next.map((n) => n.kind)).not.toContain('fix_check');
    // 每一行的出处都找得到、指向对的东西。
    const refs = allRefs(retro);
    expect(refs.length).toBeGreaterThan(5);
    for (const ref of refs) checkRef(ref, events, h.repo);

    // 之后又改了文件：通过的结果对应旧版本。
    writeConv(h.repo, 32, '// edited by hand\n');
    const changed = await h.retro();
    expect(changed.build).toBe('cached');
    expect(changed.verification.checks[0]?.evidence).toBe('outdated');
    expect(changed.delivery.checks).toBe('outdated');
  }, 60_000);

  it('投影：增量与全量一致，坏了从事件重建；模型摘要单独标注，失败不影响骨架', async () => {
    const h = await boot();
    for (const text of ['plan the first step', 'tool the second step']) {
      await h.client.request('session.send', {
        sessionId: h.sessionId,
        content: [{ type: 'text', text }],
      });
      await h.until(
        () =>
          h.events().filter((event) => event.type === 'turn.finished').length >=
            (text.startsWith('plan') ? 1 : 2) || undefined,
        text,
      );
      await h.retro(); // 每个回合后读一次：之后的读取是增量的
    }
    const incremental = await h.retro();
    // 把投影改坏：下一次读从头重放，结果与增量的一样。
    const { DatabaseSync } = await import('node:sqlite');
    const file = join(h.home, 'wevir.db');
    const raw = new DatabaseSync(file);
    raw
      .prepare('UPDATE session_retros SET state = ? WHERE session_id = ?')
      .run('{broken', h.sessionId);
    raw.close();
    const rebuilt = await h.retro();
    expect(rebuilt.build).toBe('full');
    const strip = (retro: SessionRetro) => ({ ...retro, builtAt: '', checkedAt: '', build: 'x' });
    expect(strip(rebuilt)).toEqual(strip(incremental));
    expect(incremental.done.length + incremental.open.length).toBeGreaterThan(0);

    // 模型摘要：解析不了时不保存，骨架照常。
    h.adapter.summary = 'not json';
    expect(await h.client.request('retro.summarize', { sessionId: h.sessionId })).toEqual({
      reason: 'unparsable',
    });
    expect((await h.retro()).summary).toBeUndefined();

    const requestId = rebuilt.goal.request?.id as string;
    h.adapter.summary = JSON.stringify({
      points: [
        { text: '在规划两步工作。', refs: [requestId] },
        { text: '大概都做完了。', refs: ['nope'] },
      ],
    });
    const { summary } = await h.client.request('retro.summarize', { sessionId: h.sessionId });
    expect(summary).toMatchObject({
      points: [
        { text: '在规划两步工作。', refs: [requestId] },
        { text: '大概都做完了。', refs: [], inferred: true },
      ],
      providerId: 'deepseek-official',
      usage: { inputTokens: 900, outputTokens: 60 },
    });
    expect(summary.inputBytes).toBeGreaterThan(0);
    const input = h.adapter.titleInputs.at(-1)?.input ?? '';
    expect(input).toContain(`[${requestId}] first request`);
    const withSummary = await h.retro();
    expect(withSummary.summary?.points).toHaveLength(2);
    expect(withSummary.summary?.outdated).toBeUndefined();
    expect(strip({ ...withSummary, summary: undefined })).toEqual(strip(incremental));

    // 之后又有了新回合：摘要标“基于较早的记录”，不被覆盖。
    await h.client.request('session.send', {
      sessionId: h.sessionId,
      content: [{ type: 'text', text: 'one more' }],
    });
    await h.until(
      () => h.events().filter((event) => event.type === 'turn.finished').length >= 3 || undefined,
      'third turn',
    );
    const later = await h.retro();
    expect(later.summary?.outdated).toBe(true);
    expect(later.summary?.points[0]?.text).toBe('在规划两步工作。');
  }, 60_000);

  it('脱敏读取：结果里没有密钥；删掉会话后回顾随之删除', async () => {
    const h = await boot();
    await h.client.request('session.send', {
      sessionId: h.sessionId,
      content: [{ type: 'text', text: `use key sk-${'z'.repeat(30)}` }],
    });
    await h.until(
      () => h.events().some((event) => event.type === 'turn.finished') || undefined,
      'turn',
    );
    // 标题也在回顾里，跟其余文本一起脱敏（导出与 Agent 看到的 Markdown 都用它）。
    await h.client.request('session.rename', {
      sessionId: h.sessionId,
      title: `key sk-${'y'.repeat(30)}`,
    });
    expect((await h.retro()).title).toBe(`key sk-${'y'.repeat(30)}`);
    const { retro, redactions } = await h.client.request('retro.get', {
      sessionId: h.sessionId,
      redact: true,
    });
    expect(redactions).toBe(3);
    expect(retro.title).toBe('key [REDACTED]');
    expect(JSON.stringify(retro)).not.toContain('zzzzzzzzzzzzzzzzzzzz');
    expect(JSON.stringify(retro)).not.toContain('yyyyyyyyyyyyyyyyyyyy');
    await h.client.request('session.archive', { sessionId: h.sessionId, archived: true });
    await h.client.request('session.delete', { sessionId: h.sessionId });
    await expect(h.client.request('retro.get', { sessionId: h.sessionId })).rejects.toMatchObject({
      code: ErrorCode.SESSION_NOT_FOUND,
    });
  }, 60_000);
});
