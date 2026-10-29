import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  inAppLoginSupported,
  LOGIN_NODE_ENV,
  LOGIN_URL_ENV,
  runClaudeCommand,
  startClaudeLogin,
  writeWindowsLoginHook,
} from './login.js';

// 应用内登录的进程部分：用一个 shell 脚本冒充 `claude`，行为照实测的 `claude auth login`——把授权地址作为第一个参数交给
// `$BROWSER`，然后等到登录完成（这里是等一个文件出现）才退出。Windows 的分支（`platform: 'win32'`）也在这里用 shell 脚本走：
// 冒充的 claude 像 cmd 跑 `open-url.cmd` 那样，用 `$WEVIR_LOGIN_NODE` 运行旁边的 `open-url.cjs`；`.cmd` 本身在 Windows 上
// 单独测。

const posix = process.platform === 'win32' ? describe.skip : describe;

const root = mkdtempSync(join(tmpdir(), 'wevir-claude-login-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
function fakeClaude(body: string): { executable: string; dir: string; trigger: string } {
  counter += 1;
  const dir = join(root, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  const executable = join(dir, 'claude');
  const trigger = join(dir, 'approved');
  writeFileSync(executable, `#!/bin/sh\n${body.replaceAll('$TRIGGER', trigger)}\n`, {
    mode: 0o755,
  });
  return { executable, dir, trigger };
}

const AUTH_URL =
  'https://claude.com/cai/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%3A51274%2Fcallback&state=x';
const WAIT_FOR_APPROVAL = 'while [ ! -e "$TRIGGER" ]; do sleep 0.05; done';

posix('startClaudeLogin', () => {
  it('把授权地址从 BROWSER 的参数里取出来；用户同意（脚本退出 0）后 done 兑现 ok', async () => {
    const fake = fakeClaude(
      `[ "$1" = auth ] && [ "$2" = login ] && [ "$3" = --claudeai ] || exit 9\n"$BROWSER" "${AUTH_URL}"\n${WAIT_FOR_APPROVAL}\nexit 0`,
    );
    const flow = await startClaudeLogin({
      executablePath: fake.executable,
      env: { PATH: process.env.PATH },
      directory: join(fake.dir, 'login'),
    });
    expect(flow.authUrl).toBe(AUTH_URL);
    // 小脚本是可执行的 shell 脚本。
    expect(statSync(join(fake.dir, 'login', 'open-url.sh')).mode & 0o111).toBe(0o111);
    writeFileSync(fake.trigger, '');
    expect(await flow.done).toEqual({ ok: true });
  });

  it('取消：停掉进程，done 是 cancelled', async () => {
    const fake = fakeClaude(`"$BROWSER" "${AUTH_URL}"\n${WAIT_FOR_APPROVAL}`);
    const flow = await startClaudeLogin({
      executablePath: fake.executable,
      env: { PATH: process.env.PATH },
      directory: join(fake.dir, 'login'),
    });
    flow.cancel();
    expect(await flow.done).toMatchObject({ ok: false, cancelled: true });
  });

  it('拿到地址之后失败：done 带 claude 的最后几行输出', async () => {
    const fake = fakeClaude(
      `"$BROWSER" "${AUTH_URL}"\n${WAIT_FOR_APPROVAL}\necho 'Login failed: access_denied' >&2\nexit 1`,
    );
    const flow = await startClaudeLogin({
      executablePath: fake.executable,
      env: { PATH: process.env.PATH },
      directory: join(fake.dir, 'login'),
    });
    writeFileSync(fake.trigger, '');
    expect(await flow.done).toEqual({
      ok: false,
      cancelled: false,
      message: 'Login failed: access_denied',
    });
  });

  it('报出地址前就退出：抛错，信息是 claude 的输出', async () => {
    const fake = fakeClaude("echo 'error: not supported' >&2\nexit 2");
    await expect(
      startClaudeLogin({
        executablePath: fake.executable,
        env: { PATH: process.env.PATH },
        directory: join(fake.dir, 'login'),
      }),
    ).rejects.toThrow('error: not supported');
  });

  it('一直不报地址：超时抛错并停掉进程', async () => {
    const fake = fakeClaude('sleep 30');
    const started = Date.now();
    await expect(
      startClaudeLogin({
        executablePath: fake.executable,
        env: { PATH: process.env.PATH },
        directory: join(fake.dir, 'login'),
        urlWaitMs: 300,
      }),
    ).rejects.toThrow('did not report a sign-in address within 0.3 s');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('claude 起不来：抛错', async () => {
    await expect(
      startClaudeLogin({
        executablePath: join(root, 'does-not-exist'),
        env: { PATH: process.env.PATH },
        directory: join(root, 'login-missing'),
        urlWaitMs: 2000,
      }),
    ).rejects.toThrow(/Could not start claude|did not report/u);
  });

  it('超过时限仍没人同意：停掉进程，done 带说明', async () => {
    const fake = fakeClaude(`"$BROWSER" "${AUTH_URL}"\n${WAIT_FOR_APPROVAL}`);
    const flow = await startClaudeLogin({
      executablePath: fake.executable,
      env: { PATH: process.env.PATH },
      directory: join(fake.dir, 'login'),
      timeoutMs: 1500,
    });
    expect(await flow.done).toEqual({ ok: false, cancelled: false, message: 'Sign-in timed out.' });
  });

  it('地址文件的环境变量名', () => {
    expect(LOGIN_URL_ENV).toBe('WEVIR_LOGIN_URL_FILE');
  });
});

posix('runClaudeCommand', () => {
  it('成功返回输出；失败返回最后几行', async () => {
    const ok = fakeClaude('echo "args: $@"');
    expect(await runClaudeCommand(ok.executable, ['auth', 'logout'], {}, 5000)).toMatchObject({
      ok: true,
      stdout: 'args: auth logout\n',
    });
    const bad = fakeClaude("echo 'not logged in' >&2\nexit 1");
    expect(await runClaudeCommand(bad.executable, ['auth', 'logout'], {}, 5000)).toEqual({
      ok: false,
      message: 'not logged in',
    });
  });
});

// 冒充 claude.exe 调 `BROWSER`（open-url.cmd）：cmd 会用 `%WEVIR_LOGIN_NODE%` 运行旁边的 open-url.cjs，参数原样。
const RUN_WINDOWS_HOOK =
  'case "$BROWSER" in *open-url.cmd) ;; *) exit 7 ;; esac\nrun_hook() { "$WEVIR_LOGIN_NODE" "$(dirname "$BROWSER")/open-url.cjs" "$@"; }';
const MANUAL_URL_LINE =
  "echo 'If the browser did not open, visit: https://claude.com/cai/oauth/authorize?redirect_uri=https%3A%2F%2Fplatform.claude.com'";

posix('startClaudeLogin（Windows 分支）', () => {
  const launches = (dir: string) => {
    try {
      return readFileSync(join(dir, 'launches'), 'utf8').trim().split('\n');
    } catch {
      return [];
    }
  };
  const record = (dir: string) => `echo "browser=\${BROWSER:-none}" >> '${join(dir, 'launches')}'`;

  it('钩子收到地址：去掉两头的引号，取第一个 http(s) 参数', async () => {
    const fake = fakeClaude('');
    writeFileSync(
      fake.executable,
      `#!/bin/sh\n${RUN_WINDOWS_HOOK}\nrun_hook --new-window '"${AUTH_URL}"'\n${WAIT_FOR_APPROVAL.replaceAll('$TRIGGER', fake.trigger)}\nexit 0\n`,
    );
    const flow = await startClaudeLogin({
      executablePath: fake.executable,
      env: { PATH: process.env.PATH, BROWSER: 'firefox' },
      directory: join(fake.dir, 'login'),
      platform: 'win32',
      nodeExecutable: process.execPath,
    });
    expect(flow.authUrl).toBe(AUTH_URL);
    const hook = readFileSync(join(fake.dir, 'login', 'open-url.cmd'), 'utf8');
    expect(hook).toContain(`"%${LOGIN_NODE_ENV}%" "%~dp0open-url.cjs" %*`);
    expect(hook).toContain('ELECTRON_RUN_AS_NODE=1');
    writeFileSync(fake.trigger, '');
    expect(await flow.done).toEqual({ ok: true });
  });

  it('钩子在时限内没收到地址：停掉，不设 BROWSER 重新启动，流程没有地址', async () => {
    const fake = fakeClaude(
      `${record('$DIR')}\n[ -n "$BROWSER" ] && sleep 30\n${MANUAL_URL_LINE}\n${WAIT_FOR_APPROVAL}\nexit 0`.replaceAll(
        '$DIR',
        root,
      ),
    );
    writeFileSync(join(root, 'launches'), '');
    const flow = await startClaudeLogin({
      executablePath: fake.executable,
      env: { PATH: process.env.PATH, BROWSER: 'firefox' },
      directory: join(fake.dir, 'login'),
      platform: 'win32',
      nodeExecutable: process.execPath,
      // 新写的脚本第一次运行时 macOS 要先扫描，留足时间。
      hookWaitMs: 1500,
    });
    expect(flow.authUrl).toBeUndefined();
    const seen = launches(root);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatch(/open-url\.cmd$/u);
    expect(seen[1]).toBe('browser=none');
    writeFileSync(fake.trigger, '');
    expect(await flow.done).toEqual({ ok: true });
  });

  it('钩子核对不过（Node 起不来）：直接不设 BROWSER 启动；取消照常', async () => {
    const dir = join(root, 'preflight');
    mkdirSync(dir, { recursive: true });
    const fake = fakeClaude(`${record(dir)}\n${MANUAL_URL_LINE}\n${WAIT_FOR_APPROVAL}\nexit 0`);
    const flow = await startClaudeLogin({
      executablePath: fake.executable,
      env: { PATH: process.env.PATH, browser: 'firefox' },
      directory: join(fake.dir, 'login'),
      platform: 'win32',
      nodeExecutable: join(root, 'no-such-node'),
    });
    expect(flow.authUrl).toBeUndefined();
    expect(launches(dir)).toEqual(['browser=none']);
    flow.cancel();
    expect(await flow.done).toMatchObject({ ok: false, cancelled: true });
  });

  it('claude 在钩子阶段就出错退出：报它的输出，不再退回', async () => {
    const dir = join(root, 'early-exit');
    mkdirSync(dir, { recursive: true });
    const fake = fakeClaude(`${record(dir)}\necho 'error: unknown option --claudeai' >&2\nexit 1`);
    await expect(
      startClaudeLogin({
        executablePath: fake.executable,
        env: { PATH: process.env.PATH },
        directory: join(fake.dir, 'login'),
        platform: 'win32',
        nodeExecutable: process.execPath,
      }),
    ).rejects.toThrow('error: unknown option --claudeai');
    expect(launches(dir)).toHaveLength(1);
  });

  it('退回后 claude 没开浏览器就退出：报它的输出', async () => {
    const fake = fakeClaude(
      '[ -n "$BROWSER" ] && sleep 30\necho \'Login failed: offline\' >&2\nexit 1',
    );
    await expect(
      startClaudeLogin({
        executablePath: fake.executable,
        env: { PATH: process.env.PATH },
        directory: join(fake.dir, 'login'),
        platform: 'win32',
        nodeExecutable: process.execPath,
        hookWaitMs: 1500,
      }),
    ).rejects.toThrow('Login failed: offline');
  });
});

(process.platform === 'win32' ? describe : describe.skip)('open-url.cmd（Windows）', () => {
  it('cmd 运行钩子：带 & 的地址原样写进文件', () => {
    const dir = join(root, 'win hook 中文');
    const { hook } = writeWindowsLoginHook(dir);
    const file = join(dir, 'url.txt');
    const result = spawnSync(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', `""${hook}" "${AUTH_URL}""`],
      {
        env: { ...process.env, [LOGIN_NODE_ENV]: process.execPath, [LOGIN_URL_ENV]: file },
        windowsVerbatimArguments: true,
        encoding: 'utf8',
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(readFileSync(file, 'utf8')).toBe(`${AUTH_URL}\n`);
  });
});

describe('inAppLoginSupported', () => {
  it('macOS 与 Linux 用 shell 脚本，Windows 用 .cmd 钩子', () => {
    expect(inAppLoginSupported('darwin')).toBe(true);
    expect(inAppLoginSupported('linux')).toBe(true);
    expect(inAppLoginSupported('win32')).toBe(true);
    expect(inAppLoginSupported('freebsd')).toBe(false);
  });
});
