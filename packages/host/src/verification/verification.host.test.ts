// 回合后验证与有限自动修复（0.65.0，Host 功能 `verification`）：startHost 组装出的真实 Host，echo 引擎换成会改文件的子类，会话目录是
// 一个 git 仓库，检查是真的 `node --test`。经 WebSocket 配检查、发消息，从事件流里看记录、验收状态与修复链。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionId, WevirEvent } from '@wevir/protocol';
import type { AgentInput, EngineSession, SessionConfig } from '@wevir/runtime-adapter';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it } from 'vitest';
import { startHost } from '../host-process.js';
import { createLogger } from '../logger.js';
import { TestRpcClient, useTempDir } from '../test-utils.js';

const WAIT_MS = 20_000;
const tempDir = useTempDir();
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** 回合里“改代码”的 echo：`onTurn` 拿到会话目录与输入，可以写文件、换掉交给 echo 的文字（修复材料里有 echo 的关键词）。 */
class FileEcho extends EchoAdapter {
  readonly inputs: string[] = [];
  onTurn: (cwd: string, text: string) => string | undefined = () => undefined;
  readonly #cwds = new Map<string, string>();

  override async createSession(config: SessionConfig): Promise<EngineSession> {
    const session = await super.createSession(config);
    this.#cwds.set(session.engineSessionId, config.cwd);
    return session;
  }

  override async send(engineSessionId: string, input: AgentInput): Promise<void> {
    const text = input.content.map((part) => (part.type === 'text' ? part.text : '')).join('');
    this.inputs.push(text);
    const replaced = this.onTurn(this.#cwds.get(engineSessionId) ?? '', text);
    await super.send(
      engineSessionId,
      replaced === undefined ? input : { ...input, content: [{ type: 'text', text: replaced }] },
    );
  }
}

const CONV_TEST = [
  "import { test } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { toF } from './src/conv.mjs';",
  "test('converts', () => { assert.equal(toF(0), 32); });",
  '',
].join('\n');

/** `toF` 加上 `offset`：32 才对。 */
function writeConv(cwd: string, offset: number, note = ''): void {
  writeFileSync(
    join(cwd, 'src', 'conv.mjs'),
    `${note}export function toF(c) { return (c * 9) / 5 + ${offset}; }\n`,
  );
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function makeRepo(root: string, files: Record<string, string> = {}): string {
  const repo = join(root, 'project');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'conv.test.mjs'), CONV_TEST);
  writeConv(repo, 0);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '-A');
  git(repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return repo;
}

const CONV_CHECK = {
  name: 'test',
  command: 'node --test conv.test.mjs',
  kind: 'test',
  trigger: 'after_turn',
  paths: ['src/'],
} as const;

async function boot(home: string, repo: string, adapter = new FileEcho({ stepDelayMs: 1 })) {
  const host = await startHost({
    adapter,
    engine: 'echo',
    logger: createLogger({ level: 'error', mirror: () => {} }),
    home,
  });
  let stopped = false;
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    await host.shutdown();
  };
  cleanups.push(shutdown);
  const token = (
    JSON.parse(readFileSync(join(home, 'run', 'host.json'), 'utf8')) as { token: string }
  ).token;
  const client = await TestRpcClient.connect(host.url);
  cleanups.push(() => client.ws.close());
  const hello = await client.hello(token);
  expect(hello.error).toBeUndefined();
  expect(hello.result.features.verification).toBe(true);
  const workspaces = (await client.request('workspace.list')).workspaces as Array<{ id: string }>;
  const workspaceId =
    workspaces[0]?.id ??
    ((await client.request('workspace.add', { rootPath: repo })).workspace.id as string);
  await client.request('provider.upsert', {
    id: 'deepseek-official',
    kind: 'deepseek-official',
    displayName: 'DeepSeek',
    models: [],
    defaultModelId: 'deepseek-chat',
  });

  const subscriptions = new Map<SessionId, string>();
  const subscribe = async (sessionId: SessionId) => {
    const { subscriptionId } = await client.request('events.subscribe', {
      sessionId,
      sinceSeq: 0,
    });
    subscriptions.set(sessionId, subscriptionId);
  };
  const create = async () => {
    const { session } = await client.request('session.create', {
      workspaceId,
      providerId: 'deepseek-official',
    });
    await subscribe(session.id);
    return session.id as SessionId;
  };
  const events = (sessionId: SessionId): WevirEvent[] =>
    client.events(subscriptions.get(sessionId) as string);
  const waitFor = <T>(
    sessionId: SessionId,
    pick: (events: WevirEvent[]) => T | undefined,
    label: string,
  ) => client.until(() => pick(events(sessionId)), label, WAIT_MS);
  const of = <K extends WevirEvent['type']>(sessionId: SessionId, type: K) =>
    events(sessionId).filter((event): event is Extract<WevirEvent, { type: K }> => {
      return event.type === type;
    });
  const runs = (sessionId: SessionId) =>
    of(sessionId, 'verification.updated').map((event) => event.payload.run);
  const finalRuns = (sessionId: SessionId) => {
    const byId = new Map(runs(sessionId).map((run) => [run.id, run]));
    return [...byId.values()];
  };
  const repairs = (sessionId: SessionId) =>
    of(sessionId, 'repair.updated').map((event) => event.payload.repair);
  const acceptance = (sessionId: SessionId) =>
    of(sessionId, 'acceptance.changed').at(-1)?.payload.acceptance;
  const repairMessages = (sessionId: SessionId) =>
    of(sessionId, 'user.message').filter((event) => event.payload.from?.repair !== undefined);
  /** 等修复链停下或通过。 */
  const chainEnded = (sessionId: SessionId) =>
    waitFor(
      sessionId,
      () => repairs(sessionId).find((repair) => repair.status !== 'running'),
      'repair chain ended',
    );
  const idle = (sessionId: SessionId) =>
    waitFor(
      sessionId,
      (list) => {
        const last = list.filter((event) => event.type === 'session.state_changed').at(-1);
        return last?.type === 'session.state_changed' && last.payload.to === 'idle'
          ? true
          : undefined;
      },
      'session idle',
    );
  const send = (sessionId: SessionId, text: string, extra: Record<string, unknown> = {}) =>
    client.request('session.send', {
      sessionId,
      content: [{ type: 'text', text }],
      ...extra,
    });
  const save = async (check: Record<string, unknown>) =>
    (await client.request('checks.save', { workspaceId, check })).check as {
      id: string;
      source: { kind: string; scriptHash?: string };
    };
  const setRepair = (repair: Record<string, unknown>) =>
    client.request('checks.setRepair', { workspaceId, repair });
  return {
    adapter,
    client,
    workspaceId,
    create,
    subscribe,
    events,
    waitFor,
    of,
    runs,
    finalRuns,
    repairs,
    acceptance,
    repairMessages,
    chainEnded,
    idle,
    send,
    save,
    setRepair,
    shutdown,
  };
}

function dirs(files?: Record<string, string>) {
  const root = realpathSync(tempDir());
  return { home: join(root, 'home'), repo: makeRepo(root, files) };
}

const isMaterial = (text: string) => text.includes('<check-output');

describe('检查与手动运行', () => {
  it('检查期间文件变了：记录是 stale，验收不算通过', async () => {
    const { home, repo } = dirs();
    const h = await boot(home, repo);
    const check = await h.save({
      name: 'slow build',
      command: `node -e "setTimeout(() => {}, 1500)"`,
      kind: 'build',
      trigger: 'manual',
    });
    const sessionId = await h.create();
    await h.client.request('verification.run', { sessionId, checkIds: [check.id] });
    await h.waitFor(
      sessionId,
      () => h.runs(sessionId).find((run) => run.startedAt !== undefined),
      'check started',
    );
    writeFileSync(join(repo, 'src', 'extra.mjs'), 'export const x = 1;\n');
    const run = await h.waitFor(
      sessionId,
      () => h.finalRuns(sessionId).find((item) => item.finishedAt !== undefined),
      'check finished',
    );
    expect(run).toMatchObject({ status: 'stale', reason: 'code_changed', exitCode: 0 });
    await h.waitFor(
      sessionId,
      () => (h.acceptance(sessionId)?.status !== 'verifying' ? true : undefined),
      'acceptance settled',
    );
    expect(h.acceptance(sessionId)).toMatchObject({ status: 'unverified', reason: 'code_changed' });
  }, 60_000);

  it('缺依赖、命令不存在：环境不可用', async () => {
    const { home, repo } = dirs({
      'web/package.json': JSON.stringify({ dependencies: { 'left-pad': '1.3.0' } }),
    });
    const h = await boot(home, repo);
    await h.save({ ...CONV_CHECK, trigger: 'manual', name: 'web test', cwd: 'web' });
    await h.save({
      name: 'lint',
      command: 'wevir-no-such-command-xyz --check',
      kind: 'lint',
      trigger: 'manual',
    });
    const sessionId = await h.create();
    await h.client.request('verification.run', { sessionId });
    await h.waitFor(
      sessionId,
      () => (h.acceptance(sessionId)?.status === 'environment_unavailable' ? true : undefined),
      'environment unavailable',
    );
    expect(h.finalRuns(sessionId).map((run) => [run.name, run.status, run.reason])).toEqual([
      ['web test', 'environment_unavailable', 'dependencies_missing'],
      ['lint', 'environment_unavailable', 'command_not_found'],
    ]);
  }, 60_000);

  it('仓库里声明的命令：打开仓库、列候选都不执行；认可后才跑，脚本变了要重新认可', async () => {
    const marker = `node -e "require('fs').writeFileSync('ran.txt', 'x')"`;
    const { home, repo } = dirs({
      'package.json': JSON.stringify({ name: 'p', scripts: { test: marker } }),
      // 检查写出的文件被忽略（像 dist/）：不算改了代码。
      '.gitignore': 'ran.txt\n',
    });
    const h = await boot(home, repo);
    h.adapter.onTurn = (cwd) => {
      writeConv(cwd, 0, '// touched\n');
      return undefined;
    };
    const sessionId = await h.create();
    await h.send(sessionId, 'edit the converter');
    await h.idle(sessionId);
    const listed = await h.client.request('checks.list', { workspaceId: h.workspaceId });
    expect(listed.checks).toEqual([]);
    const { candidates } = await h.client.request('checks.candidates', {
      workspaceId: h.workspaceId,
    });
    const candidate = candidates.find(
      (item: { source: { kind: string; script?: string } }) => item.source.script === 'test',
    );
    expect(candidate).toMatchObject({ command: 'npm run test', source: { body: marker } });
    expect(existsSync(join(repo, 'ran.txt'))).toBe(false);
    expect(h.runs(sessionId)).toEqual([]);

    // 认可（保存）：记下正文的散列。之后脚本被改了：不跑，等重新认可。
    const saved = await h.save({
      name: candidate.name,
      command: candidate.command,
      kind: 'other',
      trigger: 'manual',
      source: { kind: 'package_script', file: 'package.json', script: 'test' },
    });
    expect(saved.source.scriptHash).toMatch(/^sha256:/);
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ name: 'p', scripts: { test: `${marker} && echo changed` } }),
    );
    await h.client.request('verification.run', { sessionId });
    const notRun = await h.waitFor(
      sessionId,
      () => h.finalRuns(sessionId).find((run) => run.finishedAt !== undefined),
      'not run',
    );
    expect(notRun).toMatchObject({ status: 'not_run', reason: 'approval_required' });
    expect(existsSync(join(repo, 'ran.txt'))).toBe(false);

    // 重新认可后照常运行。
    await h.save({
      id: saved.id,
      name: candidate.name,
      command: candidate.command,
      kind: 'other',
      trigger: 'manual',
      source: { kind: 'package_script', file: 'package.json', script: 'test' },
    });
    await h.waitFor(
      sessionId,
      () => (h.acceptance(sessionId)?.status !== 'verifying' ? true : undefined),
      'first round settled',
    );
    await h.client.request('verification.run', { sessionId });
    const second = await h.waitFor(
      sessionId,
      () => h.finalRuns(sessionId).filter((run) => run.finishedAt !== undefined)[1],
      'second round',
    );
    expect(second).toMatchObject({ status: 'passed' });
    expect(existsSync(join(repo, 'ran.txt'))).toBe(true);
  }, 60_000);
});

describe('回合后自动运行', () => {
  it('回合改到的文件命中适用路径才跑；没改文件不跑；之后的回合改了代码，验收回到未验证', async () => {
    const { home, repo } = dirs();
    const h = await boot(home, repo);
    h.adapter.onTurn = (cwd, text) => {
      if (text === 'fix it') writeConv(cwd, 32);
      if (text === 'write docs') writeFileSync(join(cwd, 'README.md'), 'docs\n');
      return undefined;
    };
    await h.save(CONV_CHECK);
    await h.save({
      name: 'docs',
      command: 'node -e "console.log(1)"',
      kind: 'other',
      trigger: 'after_turn',
      paths: ['docs/'],
    });
    await h.save({
      name: 'manual only',
      command: 'node -e "process.exit(1)"',
      kind: 'other',
      trigger: 'manual',
    });
    const sessionId = await h.create();
    const turnFinished = (turnId: string) =>
      h.waitFor(
        sessionId,
        () => h.of(sessionId, 'turn.finished').find((event) => event.payload.turnId === turnId),
        'turn finished',
      );
    const settle = () => new Promise((resolve) => setTimeout(resolve, 800));

    const first = await h.send(sessionId, 'fix it');
    await h.waitFor(
      sessionId,
      () => (h.acceptance(sessionId)?.status === 'accepted' ? true : undefined),
      'accepted',
    );
    expect(
      h.finalRuns(sessionId).map((run) => [run.name, run.trigger, run.status, run.turnId]),
    ).toEqual([['test', 'after_turn', 'passed', first.turnId]]);

    // 没改文件的回合：不开新的一轮，验收不变。
    const quiet = await h.send(sessionId, 'hello');
    await turnFinished(quiet.turnId);
    await settle();
    expect(h.finalRuns(sessionId)).toHaveLength(1);
    expect(h.acceptance(sessionId)?.status).toBe('accepted');

    // 改了别处（不命中适用路径）：不跑检查，但之前的验收不再算数。
    const docs = await h.send(sessionId, 'write docs');
    await h.waitFor(
      sessionId,
      () => (h.acceptance(sessionId)?.status === 'unverified' ? true : undefined),
      'unverified',
    );
    expect(h.acceptance(sessionId)).toMatchObject({ reason: 'code_changed' });
    await turnFinished(docs.turnId);
    await settle();
    expect(h.finalRuns(sessionId)).toHaveLength(1);
  }, 60_000);
});

describe('有限自动修复', () => {
  it('测试失败 → 修复一次 → 复验通过；修复回合带来源，不再触发回合后检查', async () => {
    const { home, repo } = dirs();
    const h = await boot(home, repo);
    h.adapter.onTurn = (cwd, text) => {
      if (isMaterial(text)) {
        writeConv(cwd, 32);
        return 'repaired';
      }
      writeConv(cwd, 0, '// touched\n');
      return undefined;
    };
    await h.save(CONV_CHECK);
    await h.setRepair({ enabled: true });
    const sessionId = await h.create();
    const { turnId } = await h.send(sessionId, 'edit the converter');

    const ended = await h.chainEnded(sessionId);
    expect(ended).toMatchObject({ status: 'passed', attempt: 1, maxAttempts: 2 });
    expect(ended.originTurnId).toBe(turnId);
    await h.waitFor(
      sessionId,
      () => (h.acceptance(sessionId)?.status === 'accepted' ? true : undefined),
      'accepted',
    );

    const final = h.finalRuns(sessionId);
    expect(final.map((run) => [run.trigger, run.status, run.reason])).toEqual([
      ['after_turn', 'failed', 'exit_code'],
      ['repair', 'passed', undefined],
    ]);
    expect(final[0]).toMatchObject({ turnId, tests: { failed: 1 }, codeState: { kind: 'git' } });
    expect(final[0]?.fingerprint).toMatch(/^sha256:/);
    expect(final[1]).toMatchObject({ repairId: ended.id, attempt: 1, tests: { passed: 1 } });

    // 修复回合：带来源的 `report`，材料是数据块，原样交给了引擎。
    const [message] = h.repairMessages(sessionId);
    expect(message?.payload.from).toMatchObject({
      sessionId,
      kind: 'report',
      repair: {
        repairId: ended.id,
        attempt: 1,
        maxAttempts: 2,
        roundId: final[0]?.roundId,
        originTurnId: turnId,
      },
    });
    const material = h.adapter.inputs.find(isMaterial) ?? '';
    expect(material).toContain('check="test"');
    expect(material).toContain(`original_turn="${turnId}"`);
    expect(material).toMatch(/0 !== 32|Expected values to be strictly equal/);

    // 修复回合结束后只有复验那一轮：没有再开回合后检查，也没有第二条链。
    expect(new Set(h.runs(sessionId).map((run) => run.roundId)).size).toBe(2);
    expect(new Set(h.repairs(sessionId).map((repair) => repair.id)).size).toBe(1);

    const output = await h.client.request('verification.output', {
      sessionId,
      runId: final[0]?.id,
    });
    expect(output.text).toContain('0 !== 32');
    const status = await h.client.request('verification.status', { sessionId });
    expect(status.verification.acceptance).toMatchObject({ status: 'accepted' });
    expect(status.verification.repair).toMatchObject({ status: 'passed' });
    expect(status.codeState).toEqual(final[1]?.codeState);
  }, 60_000);

  it('一直修不好：到次数停下，留着失败记录与输出', async () => {
    const { home, repo } = dirs();
    const h = await boot(home, repo);
    let attempt = 0;
    h.adapter.onTurn = (cwd, text) => {
      if (isMaterial(text)) {
        attempt++;
        writeConv(cwd, attempt); // 每次错得不一样：错误指纹不同，不算原地打转。
        return 'repaired';
      }
      writeConv(cwd, 0, '// touched\n');
      return undefined;
    };
    await h.save(CONV_CHECK);
    await h.setRepair({ enabled: true, maxAttempts: 2 });
    const sessionId = await h.create();
    await h.send(sessionId, 'edit the converter');

    const ended = await h.chainEnded(sessionId);
    expect(ended).toMatchObject({ status: 'stopped', stopReason: 'limit', attempt: 2 });
    expect(ended.turnIds).toHaveLength(2);
    await h.idle(sessionId);
    const final = h.finalRuns(sessionId);
    expect(final.map((run) => [run.trigger, run.status, run.attempt])).toEqual([
      ['after_turn', 'failed', undefined],
      ['repair', 'failed', 1],
      ['repair', 'failed', 2],
    ]);
    expect(new Set(final.map((run) => run.fingerprint)).size).toBe(3);
    expect(h.acceptance(sessionId)).toMatchObject({ status: 'failed' });
    const output = await h.client.request('verification.output', {
      sessionId,
      runId: final[2]?.id,
    });
    expect(output.text).toContain('2 !== 32');
  }, 60_000);

  it('同一个错误再次出现时停下（repeated_failure）', async () => {
    const { home, repo } = dirs();
    const h = await boot(home, repo);
    h.adapter.onTurn = (cwd, text) => {
      writeConv(cwd, 0, isMaterial(text) ? '// tried\n' : '// touched\n');
      return isMaterial(text) ? 'repaired' : undefined;
    };
    await h.save(CONV_CHECK);
    await h.setRepair({ enabled: true, maxAttempts: 5 });
    const sessionId = await h.create();
    await h.send(sessionId, 'edit the converter');
    expect(await h.chainEnded(sessionId)).toMatchObject({
      status: 'stopped',
      stopReason: 'repeated_failure',
      attempt: 1,
    });
  }, 60_000);

  it('修复中用户停止：链停下，不复验，留着失败', async () => {
    const { home, repo } = dirs();
    const h = await boot(home, repo);
    h.adapter.onTurn = (cwd, text) => {
      if (isMaterial(text)) return 'slow repair';
      writeConv(cwd, 0, '// touched\n');
      return undefined;
    };
    await h.save(CONV_CHECK);
    await h.setRepair({ enabled: true });
    const sessionId = await h.create();
    await h.send(sessionId, 'edit the converter');
    await h.waitFor(sessionId, () => h.repairMessages(sessionId)[0], 'repair turn');
    await h.client.request('session.cancel', { sessionId });

    expect(await h.chainEnded(sessionId)).toMatchObject({
      status: 'stopped',
      stopReason: 'user_cancelled',
      attempt: 1,
    });
    await h.idle(sessionId);
    expect(h.finalRuns(sessionId).map((run) => run.trigger)).toEqual(['after_turn']);
    expect(h.acceptance(sessionId)).toMatchObject({ status: 'failed' });
  }, 60_000);

  it('修复中用户发来消息：停下修复回合，用户的消息随后发出', async () => {
    const { home, repo } = dirs();
    const h = await boot(home, repo);
    h.adapter.onTurn = (cwd, text) => {
      if (isMaterial(text)) return 'slow repair';
      if (text === 'edit the converter') writeConv(cwd, 0, '// touched\n');
      return undefined;
    };
    await h.save(CONV_CHECK);
    await h.setRepair({ enabled: true });
    const sessionId = await h.create();
    await h.send(sessionId, 'edit the converter');
    await h.waitFor(sessionId, () => h.repairMessages(sessionId)[0], 'repair turn');
    // 插话被拒（修复回合不能插话）：消息排队，Host 停下修复回合后发出。
    await h.send(sessionId, 'hello there', { delivery: 'steer' });

    expect(await h.chainEnded(sessionId)).toMatchObject({
      status: 'stopped',
      stopReason: 'user_message',
    });
    const mine = await h.waitFor(
      sessionId,
      () =>
        h
          .of(sessionId, 'user.message')
          .find((event) =>
            event.payload.content.some(
              (part) => part.type === 'text' && part.text === 'hello there',
            ),
          ),
      'user message sent',
    );
    expect(mine.payload.from).toBeUndefined();
    await h.waitFor(
      sessionId,
      () =>
        h
          .of(sessionId, 'turn.finished')
          .find((event) => event.payload.turnId === mine.payload.turnId),
      'user turn finished',
    );
    expect(h.adapter.inputs).toContain('hello there');
    const repairTurn = h.repairMessages(sessionId)[0]?.payload.turnId;
    expect(
      h.of(sessionId, 'turn.finished').find((event) => event.payload.turnId === repairTurn)?.payload
        .outcome,
    ).toBe('cancelled');
    // 用户的回合没改文件：之后没有新的一轮，也没有新的链。
    expect(h.repairMessages(sessionId)).toHaveLength(1);
  }, 60_000);

  it('回合后检查环境不可用：不开修复', async () => {
    const { home, repo } = dirs({
      'web/package.json': JSON.stringify({ dependencies: { 'left-pad': '1.3.0' } }),
    });
    const h = await boot(home, repo);
    h.adapter.onTurn = (cwd) => {
      writeConv(cwd, 0, '// touched\n');
      return undefined;
    };
    await h.save({ ...CONV_CHECK, name: 'web test', cwd: 'web' });
    await h.save({
      name: 'lint',
      command: 'wevir-no-such-command-xyz --check',
      kind: 'lint',
      trigger: 'after_turn',
    });
    await h.setRepair({ enabled: true });
    const sessionId = await h.create();
    await h.send(sessionId, 'edit the converter');
    await h.waitFor(
      sessionId,
      () => (h.acceptance(sessionId)?.status === 'environment_unavailable' ? true : undefined),
      'environment unavailable',
    );
    expect(h.finalRuns(sessionId).map((run) => [run.name, run.status, run.reason])).toEqual([
      ['web test', 'environment_unavailable', 'dependencies_missing'],
      ['lint', 'environment_unavailable', 'command_not_found'],
    ]);
    await h.idle(sessionId);
    expect(h.repairs(sessionId)).toEqual([]);
    expect(h.repairMessages(sessionId)).toEqual([]);
  }, 60_000);

  it('Host 重启：进行中的修复链停下，不会再开同一次修复', async () => {
    const { home, repo } = dirs();
    const first = await boot(home, repo);
    first.adapter.onTurn = (cwd, text) => {
      if (isMaterial(text)) return 'slow slow repair';
      writeConv(cwd, 0, '// touched\n');
      return undefined;
    };
    await first.save(CONV_CHECK);
    await first.setRepair({ enabled: true });
    const sessionId = await first.create();
    await first.send(sessionId, 'edit the converter');
    await first.waitFor(sessionId, () => first.repairMessages(sessionId)[0], 'repair turn');
    await first.shutdown();

    const second = await boot(home, repo);
    await second.subscribe(sessionId);
    const stopped = await second.waitFor(
      sessionId,
      () => second.repairs(sessionId).find((repair) => repair.status !== 'running'),
      'chain stopped',
    );
    expect(stopped).toMatchObject({ status: 'stopped', stopReason: 'host_restarted', attempt: 1 });
    // 等一会儿：新 Host 不开修复回合，也不重跑检查。
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(second.repairMessages(sessionId)).toHaveLength(1);
    expect(second.adapter.inputs.filter(isMaterial)).toEqual([]);
    expect(second.finalRuns(sessionId).some((run) => run.status === 'running')).toBe(false);
    const status = await second.client.request('verification.status', { sessionId });
    expect(status.verification.repair).toMatchObject({ stopReason: 'host_restarted' });
  }, 60_000);
});
