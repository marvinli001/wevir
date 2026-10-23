// 用户的交互终端（0.69.0，Host 功能 `user_terminal`）：startHost 组装出的真实 Host，客户端经 WebSocket 用 `terminal.*` 开 PTY、输入、
// 改尺寸、断线后补上、关闭。客户端一侧用 @xterm/headless 还原屏幕，比较一直连着的客户端与重连后拿快照的客户端看到的是否一样。
// 覆盖 Ctrl-C 只打断前台程序、shell 自己退出、全屏程序（vi 的备用屏）、大输出、非 UTF-8、超长行、关闭时结束后台作业、Host 重启。
// 第一个用例各平台都跑（Windows 上是 ConPTY + PowerShell），其余在 POSIX 上跑，shell 用 /bin/sh。

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { EchoAdapter } from '@wevir/runtime-adapter/echo';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startHost } from './host-process.js';
import { createLogger } from './logger.js';
import { loadTerminalModules } from './terminals.js';
import { TestRpcClient, useTempDir } from './test-utils.js';

const require = createRequire(import.meta.url);
const { Terminal: Emulator } = require('@xterm/headless') as {
  Terminal: new (options: {
    cols: number;
    rows: number;
    scrollback: number;
    allowProposedApi: boolean;
  }) => {
    write(data: string, callback?: () => void): void;
    resize(cols: number, rows: number): void;
    readonly buffer: {
      readonly active: {
        readonly type: string;
        readonly length: number;
        getLine(y: number): { translateToString(trim: boolean): string } | undefined;
      };
    };
    dispose(): void;
  };
};

const posix = process.platform !== 'win32';
/** /bin/sh 在 macOS 上是 bash。 */
const SHELLS = /^(sh|bash|dash|zsh)$/;
const tempDir = useTempDir();
const cleanups: Array<() => Promise<void> | void> = [];
const savedEnv = { SHELL: process.env.SHELL, PS1: process.env.PS1, ENV: process.env.ENV };
beforeEach(() => {
  if (!posix) return;
  // 不读用户的 rc：/bin/sh、固定的提示符。
  process.env.SHELL = '/bin/sh';
  process.env.PS1 = '$ ';
  delete process.env.ENV;
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function dirs() {
  const root = realpathSync(tempDir());
  const workspaceDir = join(root, 'project');
  mkdirSync(workspaceDir, { recursive: true });
  return { home: join(root, 'home'), workspaceDir };
}

async function connect(url: string, home: string) {
  const token = (
    JSON.parse(readFileSync(join(home, 'run', 'host.json'), 'utf8')) as { token: string }
  ).token;
  const client = await TestRpcClient.connect(url);
  cleanups.push(() => client.ws.close());
  const hello = await client.hello(token);
  expect(hello.error).toBeUndefined();
  return { client, features: hello.result.features as Record<string, boolean> };
}

async function boot(home: string, workspaceDir: string) {
  const host = await startHost({
    adapter: new EchoAdapter({ stepDelayMs: 1 }),
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
  const { client, features } = await connect(host.url, home);
  const workspaces = (await client.request('workspace.list')).workspaces as Array<{ id: string }>;
  const workspaceId =
    workspaces[0]?.id ??
    ((await client.request('workspace.add', { rootPath: workspaceDir })).workspace.id as string);
  return { host, client, features, workspaceId, shutdown };
}

/** 一个客户端看一个终端：attach 的结果加上之后的 `terminal.output`，按位置接起来（不连续就报错）。 */
function view(client: TestRpcClient, terminalId: string, attach: { data: string; next: number }) {
  let text = attach.data;
  let next = attach.next;
  let seen = 0;
  const pull = () => {
    const outputs = client
      .notifications('terminal.output')
      .filter((output) => output.terminalId === terminalId);
    for (const output of outputs.slice(seen)) {
      if (output.offset + output.data.length <= next) continue;
      if (output.offset > next) throw new Error(`gap: ${output.offset} > ${next}`);
      text += output.data.slice(next - output.offset);
      next = output.offset + output.data.length;
    }
    seen = outputs.length;
  };
  return {
    get text() {
      pull();
      return text;
    },
    get next() {
      pull();
      return next;
    },
    until: (check: (text: string) => boolean, label: string, timeoutMs?: number) =>
      client.until(
        () => {
          pull();
          return check(text) ? text : undefined;
        },
        label,
        timeoutMs,
      ),
  };
}

/** 把输出写进一个模拟器，返回屏幕上（含滚动缓冲）每一行的文字与当前是哪个缓冲。 */
async function render(data: string, cols: number, rows: number) {
  const emulator = new Emulator({ cols, rows, scrollback: 5000, allowProposedApi: true });
  await new Promise<void>((resolve) => emulator.write(data, resolve));
  const buffer = emulator.buffer.active;
  const lines: string[] = [];
  for (let y = 0; y < buffer.length; y++)
    lines.push(buffer.getLine(y)?.translateToString(true) ?? '');
  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  emulator.dispose();
  return { lines, type: buffer.type };
}

async function changedUntil(
  client: TestRpcClient,
  terminalId: string,
  // biome-ignore lint/suspicious/noExplicitAny: 测试读通知的字段。
  check: (terminal: any) => boolean,
  label: string,
) {
  return client.until(
    () =>
      client
        .notifications('terminal.changed')
        .map((change) => change.terminal)
        .find((terminal) => terminal?.id === terminalId && check(terminal)),
    label,
  );
}

// node-pty 加载得了才跑：macOS、Windows 用包里的预编译，Linux 要先 bash scripts/build-node-pty.sh（CI 会编）。
describe.runIf((await loadTerminalModules(() => {})) !== undefined)('用户终端经 Host API', () => {
  it('开终端、输入、输出、关闭（各平台）', async () => {
    const { home, workspaceDir } = dirs();
    const h = await boot(home, workspaceDir);
    expect(h.features.user_terminal).toBe(true);
    const { terminal } = await h.client.request('terminal.create', {
      workspaceId: h.workspaceId,
      cols: 100,
      rows: 30,
    });
    expect(terminal).toMatchObject({ status: 'running', cwd: workspaceDir, cols: 100, rows: 30 });
    const attach = await h.client.request('terminal.attach', { terminalId: terminal.id });
    expect(attach.reset).toBe(true);
    const screen = view(h.client, terminal.id, attach);
    await h.client.request('terminal.input', {
      terminalId: terminal.id,
      // 输出里的结果由 shell 算出，回显的命令里没有它。
      data: posix ? 'echo wevir-$((40+2))-ok\r' : 'echo ("wevir-" + (40+2) + "-ok")\r',
    });
    await screen.until((text) => text.includes('wevir-42-ok'), 'echo 的输出', 20_000);
    const listed = (await h.client.request('terminal.list', { workspaceId: h.workspaceId }))
      .terminals;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: terminal.id, clients: 1 });
    await h.client.request('terminal.close', { terminalId: terminal.id });
    await h.client.until(
      () =>
        h.client
          .notifications('terminal.changed')
          .find((change) => change.removed?.id === terminal.id),
      'removed',
      10_000,
    );
    expect((await h.client.request('terminal.list')).terminals).toEqual([]);
  }, 40_000);

  describe.runIf(posix)('POSIX', () => {
    it('Ctrl-C 只打断前台程序；前台进程名、标题、尺寸；shell 自己退出后留着，关闭后忘掉', async () => {
      const { home, workspaceDir } = dirs();
      const h = await boot(home, workspaceDir);
      const { terminal } = await h.client.request('terminal.create', {
        workspaceId: h.workspaceId,
        cols: 80,
        rows: 24,
      });
      const attach = await h.client.request('terminal.attach', { terminalId: terminal.id });
      const screen = view(h.client, terminal.id, attach);
      const input = (data: string) =>
        h.client.request('terminal.input', { terminalId: terminal.id, data });

      await input('sleep 30\r');
      await changedUntil(h.client, terminal.id, (t) => t.foreground === 'sleep', '前台是 sleep');
      await input('\u0003');
      await changedUntil(h.client, terminal.id, (t) => SHELLS.test(t.foreground), '回到 shell');
      expect((await h.client.request('terminal.list')).terminals[0].status).toBe('running');

      await input("printf '\\033]0;wevir title\\007'\r");
      await changedUntil(h.client, terminal.id, (t) => t.title === 'wevir title', '标题');

      await h.client.request('terminal.resize', { terminalId: terminal.id, cols: 120, rows: 40 });
      await changedUntil(h.client, terminal.id, (t) => t.cols === 120 && t.rows === 40, '尺寸');
      await input('stty size\r');
      await screen.until((text) => text.includes('40 120'), 'stty 看到新尺寸');

      await input('exit 3\r');
      const exited = await changedUntil(
        h.client,
        terminal.id,
        (t) => t.status === 'exited',
        '退出',
      );
      expect(exited).toMatchObject({ exitCode: 3, signal: null });
      // 退出后还能看（attach 拿快照），不再收输入。
      const again = await h.client.request('terminal.attach', { terminalId: terminal.id });
      expect(again.terminal.status).toBe('exited');
      expect((await render(again.data, 120, 40)).lines.join('\n')).toContain('40 120');
      await input('echo ignored\r');
      await h.client.request('terminal.close', { terminalId: terminal.id });
      await h.client.until(
        () =>
          h.client
            .notifications('terminal.changed')
            .find((change) => change.removed?.id === terminal.id),
        'removed',
      );
      await expect(
        h.client.request('terminal.attach', { terminalId: terminal.id }),
      ).rejects.toMatchObject({ message: 'not found' });
    }, 40_000);

    it('断线重连：补上中间的输出、补不上时给快照，屏幕与一直连着的客户端一致；大输出、非 UTF-8、超长行', async () => {
      const { home, workspaceDir } = dirs();
      const h = await boot(home, workspaceDir);
      const { terminal } = await h.client.request('terminal.create', {
        workspaceId: h.workspaceId,
        cols: 80,
        rows: 24,
      });
      // 一直连着的客户端。
      const always = view(
        h.client,
        terminal.id,
        await h.client.request('terminal.attach', { terminalId: terminal.id }),
      );
      const input = (data: string) =>
        h.client.request('terminal.input', { terminalId: terminal.id, data });

      // 第二个客户端看一会儿就断开。
      const token = (
        JSON.parse(readFileSync(join(home, 'run', 'host.json'), 'utf8')) as { token: string }
      ).token;
      const second = await connect(h.host.url, home);
      const first = await second.client.request('terminal.attach', { terminalId: terminal.id });
      const before = view(second.client, terminal.id, first);
      await input("printf 'A%.0s' $(seq 1 50); echo; echo part-$((1))-one\r");
      await before.until((text) => text.includes('part-1-one'), '断开前的输出');
      const resumeAt = before.next;
      second.client.ws.close();
      await second.client.closed;

      // 断开期间：非 UTF-8、超长行、带颜色的输出。
      await input(
        "printf 'bad\\377\\376end\\n'; printf '%0300000d\\n' 7; printf '\\033[31mred\\033[0m 中文\\n'; echo part-$((2))-two\r",
      );
      await always.until((text) => text.includes('part-2-two'), '断开期间的输出', 20_000);

      const back = await TestRpcClient.connect(h.host.url);
      cleanups.push(() => back.ws.close());
      expect((await back.hello(token)).error).toBeUndefined();
      const resumed = await back.request('terminal.attach', {
        terminalId: terminal.id,
        since: resumeAt,
      });
      expect(resumed.reset).toBe(false);
      const after = view(back, terminal.id, resumed);
      expect(before.text.slice(0, resumeAt) + after.text).toBe(always.text.slice(0, resumed.next));
      expect(after.text).toContain('bad��end');
      expect(after.text).toContain('\u001b[31mred\u001b[0m 中文');
      expect(after.text).toMatch(/0{299999}7/);

      // 大输出：约 5 MB，超过环形缓冲（1M 字符），按序全部到达，连接不断。
      await input(
        'head -c 5000000 /dev/zero | tr "\\000" "y" | fold -w 100; echo; echo big-$((3))-done\r',
      );
      await always.until((text) => text.includes('big-3-done'), '大输出结束', 60_000);
      await after.until((text) => text.includes('big-3-done'), '第二个客户端也收全', 60_000);
      expect(back.ws.readyState).toBe(back.ws.OPEN);
      const ys = (text: string) => text.match(/y/g)?.length ?? 0;
      expect(ys(always.text) - ys(always.text.slice(0, resumeAt))).toBeGreaterThanOrEqual(
        5_000_000,
      );

      // 位置已经不在环形缓冲里：给快照，屏幕与一直连着的客户端一样。
      const fresh = await back.request('terminal.attach', { terminalId: terminal.id, since: 10 });
      expect(fresh.reset).toBe(true);
      const snapshotScreen = await render(fresh.data, 80, 24);
      const fullScreen = await render(always.text.slice(0, fresh.next), 80, 24);
      expect(snapshotScreen.lines.slice(-24)).toEqual(fullScreen.lines.slice(-24));
    }, 120_000);

    it('流控：有一个客户端不读时暂停读 PTY（程序跟着停），不因发送积压断开；它再读时接着发完', async () => {
      const { home, workspaceDir } = dirs();
      const h = await boot(home, workspaceDir);
      const { terminal } = await h.client.request('terminal.create', {
        workspaceId: h.workspaceId,
        cols: 80,
        rows: 24,
      });
      const live = view(
        h.client,
        terminal.id,
        await h.client.request('terminal.attach', { terminalId: terminal.id }),
      );
      const slow = await connect(h.host.url, home);
      const slowView = view(
        slow.client,
        terminal.id,
        await slow.client.request('terminal.attach', { terminalId: terminal.id }),
      );
      // 不再从套接字读：Host 那边的发送缓冲越积越多。
      // biome-ignore lint/suspicious/noExplicitAny: ws 的底层套接字。
      const socket = (slow.client.ws as any)._socket as { pause(): void; resume(): void };
      socket.pause();
      await h.client.request('terminal.input', {
        terminalId: terminal.id,
        data: 'head -c 40000000 /dev/zero | tr "\\000" "y" | fold -w 100; echo flow-$((5))-done\r',
      });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const stalled = live.next;
      await new Promise((resolve) => setTimeout(resolve, 500));
      // 暂停住了：一直在读的客户端也不再收到新输出，远没到 40 MB。
      expect(live.next - stalled).toBeLessThan(1_000_000);
      expect(live.text).not.toContain('flow-5-done');
      socket.resume();
      await slowView.until((text) => text.includes('flow-5-done'), '慢的客户端收全', 90_000);
      await live.until((text) => text.includes('flow-5-done'), '快的客户端收全', 30_000);
      expect(slow.client.ws.readyState).toBe(slow.client.ws.OPEN);
      expect(slowView.text.match(/y/g)?.length ?? 0).toBeGreaterThanOrEqual(40_000_000);
    }, 150_000);

    it('全屏程序：vi 在备用屏，重新 attach 拿到的快照还原备用屏，退出后回到原来的屏幕', async () => {
      const { home, workspaceDir } = dirs();
      const h = await boot(home, workspaceDir);
      const { terminal } = await h.client.request('terminal.create', {
        workspaceId: h.workspaceId,
        cols: 80,
        rows: 24,
      });
      const live = view(
        h.client,
        terminal.id,
        await h.client.request('terminal.attach', { terminalId: terminal.id }),
      );
      const input = (data: string) =>
        h.client.request('terminal.input', { terminalId: terminal.id, data });
      await input('echo before-$((4))-vi\r');
      await live.until((text) => text.includes('before-4-vi'), 'vi 之前');
      await input('vi -u NONE -N notes.txt\r');
      await changedUntil(
        h.client,
        terminal.id,
        (t) => /^(vi|vim)$/.test(t.foreground),
        '前台是 vi',
      );
      await input('iwevir in vi');
      await live.until((text) => text.includes('wevir in vi'), 'vi 里的输入');
      await new Promise((resolve) => setTimeout(resolve, 300));
      const snapshot = await h.client.request('terminal.attach', { terminalId: terminal.id });
      expect(snapshot.reset).toBe(true);
      const screen = await render(snapshot.data, 80, 24);
      expect(screen.type).toBe('alternate');
      expect(screen.lines.join('\n')).toContain('wevir in vi');
      const full = await render(live.text.slice(0, snapshot.next), 80, 24);
      expect(screen.lines).toEqual(full.lines);
      await input('\u001b:wq\r');
      await changedUntil(h.client, terminal.id, (t) => SHELLS.test(t.foreground), 'vi 退出');
      expect(readFileSync(join(workspaceDir, 'notes.txt'), 'utf8')).toBe('wevir in vi\n');
      const back = await h.client.request('terminal.attach', { terminalId: terminal.id });
      const normal = await render(back.data, 80, 24);
      expect(normal.type).toBe('normal');
      expect(normal.lines.join('\n')).toContain('before-4-vi');
    }, 40_000);

    it('关闭时结束后台作业；项目移除时结束不属于会话的终端；Host 重启后列表是空的', async () => {
      const { home, workspaceDir } = dirs();
      const h = await boot(home, workspaceDir);
      const { terminal } = await h.client.request('terminal.create', {
        workspaceId: h.workspaceId,
        cols: 80,
        rows: 24,
      });
      const screen = view(
        h.client,
        terminal.id,
        await h.client.request('terminal.attach', { terminalId: terminal.id }),
      );
      await h.client.request('terminal.input', {
        terminalId: terminal.id,
        data: 'sleep 1000 & echo job=$!\r',
      });
      const text = await screen.until((value) => /job=\d+/.test(value), '后台作业的 PID');
      const job = Number(/job=(\d+)/.exec(text)?.[1]);
      expect(alive(job)).toBe(true);
      await h.client.request('terminal.close', { terminalId: terminal.id });
      await h.client.until(
        () =>
          h.client
            .notifications('terminal.changed')
            .find((change) => change.removed?.id === terminal.id),
        'removed',
        10_000,
      );
      await h.client.until(() => (alive(job) ? undefined : true), '后台作业结束', 10_000);

      // 另一个项目里的终端随项目移除结束。
      const otherDir = join(workspaceDir, '..', 'other');
      mkdirSync(otherDir);
      const other = (await h.client.request('workspace.add', { rootPath: otherDir })).workspace
        .id as string;
      const { terminal: second } = await h.client.request('terminal.create', {
        workspaceId: other,
        cols: 80,
        rows: 24,
      });
      await h.client.request('workspace.remove', { workspaceId: other });
      await h.client.until(
        () =>
          h.client
            .notifications('terminal.changed')
            .find((change) => change.removed?.id === second.id),
        'removed with workspace',
        10_000,
      );
      expect(alive(second.pid)).toBe(false);

      // Host 重启：终端随 Host 结束，新 Host 的列表是空的。
      const { terminal: third } = await h.client.request('terminal.create', {
        workspaceId: h.workspaceId,
        cols: 80,
        rows: 24,
      });
      await h.shutdown();
      expect(alive(third.pid)).toBe(false);
      const restarted = await boot(home, workspaceDir);
      expect((await restarted.client.request('terminal.list')).terminals).toEqual([]);
      await expect(
        restarted.client.request('terminal.attach', { terminalId: third.id }),
      ).rejects.toMatchObject({ message: 'not found' });
    }, 60_000);
  });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  // 已退出但还没被回收的僵尸进程也算结束。
  try {
    return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).includes(
      'Z',
    );
  } catch {
    return false;
  }
}
