import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { inAppLoginSupported, LOGIN_URL_ENV, runClaudeCommand, startClaudeLogin } from './login.js';

// 应用内登录的进程部分：用一个 shell 脚本冒充 `claude`，行为照实测的 `claude auth login`——把授权地址作为第一个参数交给
// `$BROWSER`，然后等到登录完成（这里是等一个文件出现）才退出。

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

describe('inAppLoginSupported', () => {
  it('shell 脚本只有 macOS 与 Linux 跑得了', () => {
    expect(inAppLoginSupported('darwin')).toBe(true);
    expect(inAppLoginSupported('linux')).toBe(true);
    expect(inAppLoginSupported('win32')).toBe(false);
  });
});
