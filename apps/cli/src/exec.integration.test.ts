import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createLogger, type RunningHost, startHost } from '@wevir/host';
import { type SessionSnapshot, WevirEventSchema } from '@wevir/protocol';
import type { AgentEvent } from '@wevir/runtime-adapter';
import { EchoAdapter, type EchoAdapterOptions } from '@wevir/runtime-adapter/echo';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as hostCommands from './commands/host.js';
import { type FakeRun, run, runFake, ShellEchoAdapter, useTempDir } from './test-utils.js';

const tempDir = useTempDir();
let host: RunningHost | undefined;
const running: FakeRun[] = [];
const detachedHomes: string[] = [];
afterEach(async () => {
  for (const fake of running.splice(0)) {
    fake.interrupt();
    fake.stdin.end();
    await fake.exit;
  }
  await host?.shutdown();
  host = undefined;
  for (const home of detachedHomes.splice(0)) await run(['host', 'stop'], { home });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

class JsonEchoAdapter extends EchoAdapter {
  override subscribe(engineSessionId: string): AsyncIterable<AgentEvent> {
    const source = super.subscribe(engineSessionId);
    return {
      async *[Symbol.asyncIterator]() {
        for await (const event of source) {
          if (event.type === 'assistant.message') {
            yield { ...event, messageId: `${event.messageId}-draft`, text: 'intermediate' };
            yield { ...event, text: event.text.replace(/^Echo: /, '') };
          } else yield event;
        }
      },
    };
  }
}

async function setup(Adapter = EchoAdapter, echo: EchoAdapterOptions = {}) {
  const home = join(tempDir(), 'home');
  const workspace = join(tempDir(), 'project');
  const userHome = join(tempDir(), 'user');
  mkdirSync(workspace);
  mkdirSync(userHome);
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(userHome, '.claude'));
  vi.stubEnv('CODEX_HOME', join(userHome, '.codex'));
  host = await startHost({
    home,
    adapter: new Adapter({ stepDelayMs: 1, ...echo }),
    engine: 'echo',
    pluginUserHome: userHome,
    userHome,
    importEnv: {},
    logger: createLogger({ level: 'error', mirror: () => {} }),
  });
  const added = await run(
    [
      'provider',
      'add',
      '--kind',
      'openai-compatible',
      '--id',
      'echo-test',
      '--base-url',
      'http://127.0.0.1:9/v1',
      '--model',
      'echo-model',
      '--no-key',
    ],
    { home },
  );
  expect(added.code, added.err).toBe(0);
  return { home, workspace, userHome };
}

function events(out: string) {
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => WevirEventSchema.parse(JSON.parse(line)));
}

function fakeExec(home: string, workspace: string, prompt: string) {
  const fake = runFake(['exec', '--json', prompt], { home, cwd: workspace });
  running.push(fake);
  return fake;
}

function schema(workspace: string, value: unknown): string {
  writeFileSync(join(workspace, 'schema.json'), JSON.stringify(value));
  return 'schema.json';
}

async function snapshot(home: string, out: string): Promise<SessionSnapshot> {
  const id = events(out)[0]?.sessionId;
  expect(id).toBeDefined();
  const shown = await run(['session', 'show', id as string, '--json'], { home });
  expect(shown.code, shown.err).toBe(0);
  return JSON.parse(shown.out) as SessionSnapshot;
}

describe('wevir exec', () => {
  it('使用当前目录，只输出最终回答，保留会话', async () => {
    const { home, workspace } = await setup();
    const result = await run(['exec', 'hello'], { home, cwd: workspace });
    expect(result).toEqual({ code: 0, out: 'Echo: hello\n', err: '' });
    const listed = await run(['session', 'list', '--json'], { home });
    expect(listed.out).toContain('hello');
    const workspaces = await run(['workspace', 'list', '--json'], { home });
    expect(JSON.parse(workspaces.out)).toMatchObject([
      { rootPath: realpathSync.native(workspace) },
    ]);
  });

  it('stdin 提示、显式目录与配置，JSON Lines 使用原协议事件', async () => {
    const { home, workspace } = await setup();
    const result = await run(
      [
        'exec',
        '--cwd',
        workspace,
        '--provider',
        'echo-test',
        '--model',
        'echo-model',
        '--permission-mode',
        'full_access',
        '--json',
        '-',
      ],
      { home, input: 'hello\nworld\n' },
    );
    expect(result.code, result.err).toBe(0);
    expect(result.err).toBe('');
    const stream = events(result.out);
    expect(stream[0]?.type).toBe('session.created');
    expect(stream.map((e) => e.seq)).toEqual(stream.map((_, i) => i + 1));
    expect(stream.at(-1)).toMatchObject({
      type: 'turn.finished',
      payload: { outcome: 'completed' },
    });
    expect(stream.find((e) => e.type === 'assistant.message')?.payload).toMatchObject({
      text: 'Echo: hello\nworld',
    });
    const saved = await snapshot(home, result.out);
    expect(saved.session).toMatchObject({
      cwd: realpathSync.native(workspace),
      providerId: 'echo-test',
      modelId: 'echo-model',
      permissionMode: 'full_access',
      state: 'idle',
    });
  });

  it('引擎失败返回 1，不被输出校验覆盖', async () => {
    const { home, workspace } = await setup();
    const file = schema(workspace, { type: 'object' });
    const result = await run(['exec', '--json', '--output-schema', file, 'fail'], {
      home,
      cwd: workspace,
    });
    expect(result.code).toBe(1);
    expect(result.err).toContain('echo');
    expect(events(result.out).at(-1)).toMatchObject({
      type: 'turn.finished',
      payload: { outcome: 'failed' },
    });
  });

  it('SIGINT 取消回合，事件流以取消结果结束并返回 130', async () => {
    const { home, workspace } = await setup(EchoAdapter, { stepDelayMs: 10 });
    const fake = fakeExec(home, workspace, 'slow hello');
    await fake.waitFor('"type":"turn.started"');
    fake.interrupt();
    expect(await fake.exit, fake.err()).toBe(130);
    expect(events(fake.out()).at(-1)).toMatchObject({
      type: 'turn.finished',
      payload: { outcome: 'cancelled' },
    });
    expect((await snapshot(home, fake.out())).session.state).toBe('idle');
  });

  it('其他客户端取消回合也返回 130', async () => {
    const { home, workspace } = await setup(EchoAdapter, { stepDelayMs: 10 });
    const fake = fakeExec(home, workspace, 'slow hello');
    await fake.waitFor('"type":"turn.started"');
    const id = events(fake.out())[0]?.sessionId as string;
    expect((await run(['session', 'cancel', id], { home })).code).toBe(0);
    expect(await fake.exit).toBe(130);
  });

  it('无人处理审批时取消回合并返回 2，不等 stdin 结束', async () => {
    const { home, workspace } = await setup();
    const fake = fakeExec(home, workspace, 'approve');
    expect(await fake.exit).toBe(2);
    expect(fake.err()).toContain('需要人工审批');
    const saved = await snapshot(home, fake.out());
    expect(saved.pendingApprovals).toEqual([]);
    expect(saved.session.state).toBe('idle');
    expect(events(fake.out()).at(-1)).toMatchObject({
      type: 'turn.finished',
      payload: { outcome: 'cancelled' },
    });
  });

  it.each(['auto_review', 'full_access'])('%s 的审批按引擎权限模式处理', async (mode) => {
    const { home, workspace } = await setup();
    const result = await run(['exec', '--permission-mode', mode, 'approve'], {
      home,
      cwd: workspace,
    });
    expect(result.code, result.err).toBe(0);
    expect(result.out).toBe('Echo: approve\n');
  });

  it('阻塞提问返回 2，非阻塞提问继续完成', async () => {
    const { home, workspace } = await setup();
    const blocked = fakeExec(home, workspace, 'ask');
    expect(await blocked.exit).toBe(2);
    expect(blocked.err()).toContain('需要回答提问');
    expect((await snapshot(home, blocked.out())).pendingQuestions ?? []).toEqual([]);
    const result = await run(['exec', '--json', 'askasync'], { home, cwd: workspace });
    expect(result.code, result.err).toBe(0);
    expect(
      events(result.out).some((e) => e.type === 'question.requested' && e.payload.question.async),
    ).toBe(true);
  });

  it('Host 已按审批规则处理时继续运行', async () => {
    const { home, workspace } = await setup(ShellEchoAdapter);
    expect((await run(['rule', 'add', 'git', 'status'], { home })).code).toBe(0);
    const result = await run(['exec', 'approve: git status'], { home, cwd: workspace });
    expect(result.code, result.err).toBe(0);
    expect(result.out).toBe('Echo: approve: git status\n');
  });

  it.each([
    undefined,
    'https://json-schema.org/draft/2019-09/schema',
    'https://json-schema.org/draft/2020-12/schema',
  ])('校验最后一条已提交回答（%s）', async ($schema) => {
    const { home, workspace } = await setup(JsonEchoAdapter, { incrementalStream: false });
    const file = schema(workspace, {
      ...($schema !== undefined && { $schema }),
      type: 'object',
      properties: { ok: { const: true } },
      required: ['ok'],
      additionalProperties: false,
    });
    const good = await run(['exec', '--output-schema', file, '{"ok":true}'], {
      home,
      cwd: workspace,
    });
    expect(good).toEqual({ code: 0, out: '{"ok":true}\n', err: '' });
    const bad = await run(['exec', '--json', '--output-schema', file, '{"ok":false}'], {
      home,
      cwd: workspace,
    });
    expect(bad.code).toBe(3);
    expect(bad.err).toContain('不满足 JSON Schema');
    expect(events(bad.out).at(-1)).toMatchObject({
      type: 'turn.finished',
      payload: { outcome: 'completed' },
    });
  });

  it('非 JSON 回答返回 3', async () => {
    const { home, workspace } = await setup();
    const file = schema(workspace, { type: 'object' });
    const result = await run(['exec', '--output-schema', file, 'hello'], { home, cwd: workspace });
    expect(result.code).toBe(3);
    expect(result.err).toContain('最后一条回答不是 JSON');
  });

  it('无效参数与 schema 在启动 Host 前返回 2', async () => {
    const home = join(tempDir(), 'home');
    const file = schema(tempDir(), { type: 'invalid' });
    for (const args of [
      [],
      ['-'],
      ['--permission-mode', 'invalid', 'hello'],
      ['--output-schema', file, 'hello'],
    ]) {
      const result = await run(['exec', ...args], { home, cwd: tempDir() });
      expect(result.code, result.err).toBe(2);
      expect(result.out).toBe('');
    }
    expect(existsSync(join(home, 'run', 'host.json'))).toBe(false);
  });

  it('Host 断开时返回 1，说明结果未知', async () => {
    const { home, workspace } = await setup(EchoAdapter, { stepDelayMs: 10 });
    let socket: WebSocket | undefined;
    const NativeWebSocket = globalThis.WebSocket;
    vi.stubGlobal(
      'WebSocket',
      class extends NativeWebSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          socket = this;
        }
      },
    );
    const fake = fakeExec(home, workspace, 'slow hello');
    await fake.waitFor('"type":"turn.started"');
    socket?.close();
    expect(await fake.exit).toBe(1);
    expect(fake.err()).toContain('回合结果未知');
  });

  it('Host 未运行时复用分离启动路径，启动消息不会混入 JSON 流', async () => {
    const { home, workspace, userHome } = await setup();
    await host?.shutdown();
    host = undefined;
    detachedHomes.push(home);
    const start = hostCommands.hostStart;
    const spy = vi
      .spyOn(hostCommands, 'hostStart')
      .mockImplementationOnce((ctx, options) => start(ctx, { ...options, adapter: 'echo' }));
    const result = await run(['exec', '--json', 'hello'], {
      home,
      cwd: workspace,
      env: { ...process.env, HOME: userHome, USERPROFILE: userHome },
    });
    expect(result.code, result.err).toBe(0);
    expect(spy).toHaveBeenCalledOnce();
    expect(result.err).toContain('Host 已启动');
    expect(events(result.out).at(-1)).toMatchObject({
      type: 'turn.finished',
      payload: { outcome: 'completed' },
    });
    expect((await run(['host', 'status'], { home })).code).toBe(0);
  }, 30_000);

  it(
    '可执行入口输出 JSON 并返回真实进程退出码',
    async () => {
      const { home, workspace, userHome } = await setup(EchoAdapter, { stepDelayMs: 5 });
      const entry = fileURLToPath(new URL('../dist/main.js', import.meta.url));
      const options = {
        cwd: workspace,
        env: { ...process.env, HOME: userHome, USERPROFILE: userHome },
      };
      const invoke = promisify(execFile);
      const completed = await invoke(
        process.execPath,
        [entry, '--home', home, 'exec', '--json', 'hello'],
        options,
      );
      expect(completed.stderr).toBe('');
      expect(events(completed.stdout).at(-1)).toMatchObject({
        type: 'turn.finished',
        payload: { outcome: 'completed' },
      });
      for (const [prompt, code] of [
        ['fail', 1],
        ['approve', 2],
      ] as const) {
        await expect(
          invoke(process.execPath, [entry, '--home', home, 'exec', '--json', prompt], options),
        ).rejects.toMatchObject({ code });
      }
      const file = schema(workspace, { type: 'object' });
      await expect(
        invoke(
          process.execPath,
          [entry, '--home', home, 'exec', '--output-schema', file, 'hello'],
          options,
        ),
      ).rejects.toMatchObject({ code: 3 });
    },
    process.platform === 'win32' ? 30_000 : 15_000,
  );

  it.skipIf(process.platform === 'win32')(
    'POSIX SIGINT 等取消事件写完后以 130 退出',
    async () => {
      const { home, workspace, userHome } = await setup(EchoAdapter, { stepDelayMs: 5 });
      const entry = fileURLToPath(new URL('../dist/main.js', import.meta.url));
      const options = {
        cwd: workspace,
        env: { ...process.env, HOME: userHome, USERPROFILE: userHome },
      };
      const child = spawn(
        process.execPath,
        [entry, '--home', home, 'exec', '--json', 'slow hello'],
        {
          ...options,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const closed = once(child, 'close');
      let out = '';
      let err = '';
      let interrupted = false;
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        out += chunk;
        if (!interrupted && out.includes('"type":"turn.started"')) {
          interrupted = true;
          child.kill('SIGINT');
        }
      });
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        err += chunk;
      });
      try {
        expect(await closed, err).toEqual([130, null]);
        expect(events(out).at(-1)).toMatchObject({
          type: 'turn.finished',
          payload: { outcome: 'cancelled' },
        });
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL');
        await closed;
      }
    },
    15_000,
  );
});
