import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseDeviceLogin, startGrokLogin } from './login.js';

// 应用内登录的进程部分：输出照实测的 `grok login --device-auth`（grok 1.0.62，隔离的 GROK_HOME）。

const ESC = String.fromCharCode(27);
const URL_LINE = 'https://accounts.x.ai/oauth2/device?user_code=G868-SDDT';

/** 实测的输出（macOS，浏览器由 grok 自己打开）。 */
const OUTPUT_OPENED = [
  '',
  'To sign in, open this URL in your browser:',
  '',
  `  ${URL_LINE}`,
  '',
  'Confirm this code in your browser:',
  '',
  '  G868-SDDT',
  '',
  `${ESC}[90mOnly continue with a code you requested. Don't share it with anyone.${ESC}[0m`,
  '',
  'Waiting for authorization...',
  '',
].join('\n');

/** 实测的输出（Launch Services 不可用，grok 打不开浏览器）。 */
const OUTPUT_NOT_OPENED = [
  '',
  'To sign in, open this URL in your browser:',
  '',
  `  ${URL_LINE}`,
  '',
  '2026-10-18T05:39:25.661575Z ERROR failed to get default browser, falling back to Safari',
  '  (Could not open browser automatically — open the URL above manually.)',
  '',
  'Confirm this code in your browser:',
  '',
  '  G868-SDDT',
  '',
  'Waiting for authorization...',
  '',
].join('\n');

describe('parseDeviceLogin', () => {
  it('地址、码；grok 已打开浏览器', () => {
    expect(parseDeviceLogin(OUTPUT_OPENED)).toEqual({
      verificationUrl: URL_LINE,
      userCode: 'G868-SDDT',
      browserFailed: false,
      complete: true,
    });
  });

  it('grok 说打不开浏览器', () => {
    expect(parseDeviceLogin(OUTPUT_NOT_OPENED)).toMatchObject({
      verificationUrl: URL_LINE,
      userCode: 'G868-SDDT',
      browserFailed: true,
      complete: true,
    });
  });

  it('只印了一半：码取自地址的 user_code，还没完整', () => {
    expect(
      parseDeviceLogin(`\nTo sign in, open this URL in your browser:\n\n  ${URL_LINE}\n`),
    ).toEqual({
      verificationUrl: URL_LINE,
      userCode: 'G868-SDDT',
      browserFailed: false,
      complete: false,
    });
  });

  it('还没有地址 / 不是设备码的输出', () => {
    expect(parseDeviceLogin('')).toEqual({ browserFailed: false, complete: false });
    expect(parseDeviceLogin('Signing in with Grok...\n')).toEqual({
      browserFailed: false,
      complete: false,
    });
  });
});

const posix = process.platform === 'win32' ? describe.skip : describe;

const root = mkdtempSync(join(tmpdir(), 'wevir-grok-login-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
/** 冒充 `grok` 的 shell 脚本；`$TRIGGER` 是“用户同意了”的标志文件，`$PIDFILE` 里记它的 pid。 */
function fakeGrok(body: string): { executable: string; trigger: string; pidFile: string } {
  counter += 1;
  const dir = join(root, `case-${counter}`);
  mkdirSync(dir, { recursive: true });
  const executable = join(dir, 'grok');
  const trigger = join(dir, 'approved');
  const pidFile = join(dir, 'pid');
  const printed = join(dir, 'output.txt');
  writeFileSync(printed, OUTPUT_OPENED);
  writeFileSync(join(dir, 'not-opened.txt'), OUTPUT_NOT_OPENED);
  writeFileSync(
    executable,
    `#!/bin/sh\necho $$ > "${pidFile}"\n${body
      .replaceAll('$TRIGGER', trigger)
      .replaceAll('$OPENED', printed)
      .replaceAll('$NOT_OPENED', join(dir, 'not-opened.txt'))}\n`,
    { mode: 0o755 },
  );
  return { executable, trigger, pidFile };
}
const WAIT_FOR_APPROVAL = 'while [ ! -e "$TRIGGER" ]; do sleep 0.05; done';

function alive(pidFile: string): boolean {
  try {
    process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 0);
    return true;
  } catch {
    return false;
  }
}

posix('startGrokLogin', () => {
  it('login --device-auth：读出地址与码，grok 自己开了浏览器；用户同意（退出 0）后 done 兑现 ok', async () => {
    const fake = fakeGrok(
      `[ "$1" = login ] && [ "$2" = --device-auth ] && [ $# -eq 2 ] || exit 9\ncat "$OPENED"\n${WAIT_FOR_APPROVAL}\nexit 0`,
    );
    const flow = await startGrokLogin({ executablePath: fake.executable, env: process.env });
    expect(flow).toMatchObject({
      verificationUrl: URL_LINE,
      userCode: 'G868-SDDT',
      browserOpened: true,
    });
    writeFileSync(fake.trigger, '');
    expect(await flow.done).toEqual({ ok: true });
  });

  it('grok 打不开浏览器：browserOpened 为 false（由桌面端打开地址）', async () => {
    const fake = fakeGrok(`cat "$NOT_OPENED"\n${WAIT_FOR_APPROVAL}\nexit 0`);
    const flow = await startGrokLogin({ executablePath: fake.executable, env: process.env });
    expect(flow).toMatchObject({ verificationUrl: URL_LINE, browserOpened: false });
    flow.cancel();
    expect(await flow.done).toMatchObject({ ok: false, cancelled: true });
  });

  it('码一直没印出来：地址出现 settleMs 后照样返回（码取自地址）', async () => {
    const fake = fakeGrok(
      `printf 'To sign in, open this URL in your browser:\\n\\n  ${URL_LINE}\\n'\n${WAIT_FOR_APPROVAL}\nexit 0`,
    );
    const flow = await startGrokLogin({
      executablePath: fake.executable,
      env: process.env,
      settleMs: 200,
    });
    expect(flow).toMatchObject({ verificationUrl: URL_LINE, userCode: 'G868-SDDT' });
    flow.cancel();
    await flow.done;
  });

  it('取消：停掉进程，done 是 cancelled', async () => {
    const fake = fakeGrok(`cat "$OPENED"\n${WAIT_FOR_APPROVAL}\nexit 0`);
    const flow = await startGrokLogin({ executablePath: fake.executable, env: process.env });
    expect(alive(fake.pidFile)).toBe(true);
    flow.cancel();
    expect(await flow.done).toEqual({
      ok: false,
      cancelled: true,
      message: 'Sign-in was cancelled.',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(alive(fake.pidFile)).toBe(false);
  });

  it('取消连同 grok 起的子进程（npm 的启动脚本不转发信号）：整个进程组停掉', async () => {
    const fake = fakeGrok(
      `sh -c 'echo $$ > "${join(root, 'child.pid')}"; exec sleep 30' &\ncat "$OPENED"\nwait`,
    );
    const flow = await startGrokLogin({ executablePath: fake.executable, env: process.env });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const childPid = join(root, 'child.pid');
    expect(existsSync(childPid)).toBe(true);
    flow.cancel();
    await flow.done;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(alive(childPid)).toBe(false);
    rmSync(childPid, { force: true });
  });

  it('拿到地址之后失败：done 带 grok 的最后几行输出', async () => {
    const fake = fakeGrok(
      `cat "$OPENED"\necho 'Authorization was denied.' >&2\necho 'Sign-in failed.' >&2\nexit 1`,
    );
    const flow = await startGrokLogin({ executablePath: fake.executable, env: process.env });
    expect(await flow.done).toEqual({
      ok: false,
      cancelled: false,
      message: expect.stringContaining('Sign-in failed.'),
    });
  });

  it('报出地址前就退出：抛错，信息是 grok 的输出', async () => {
    const fake = fakeGrok(`echo 'Error: could not reach auth.x.ai' >&2\nexit 1`);
    await expect(
      startGrokLogin({ executablePath: fake.executable, env: process.env }),
    ).rejects.toThrow('Error: could not reach auth.x.ai');
  });

  it('一直不报地址：超时抛错并停掉进程', async () => {
    const fake = fakeGrok(`echo 'Signing in with Grok...'\nsleep 30`);
    await expect(
      startGrokLogin({ executablePath: fake.executable, env: process.env, urlWaitMs: 1500 }),
    ).rejects.toThrow(
      'grok did not report a sign-in address within 1.5 s: Signing in with Grok...',
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(alive(fake.pidFile)).toBe(false);
  });

  it('grok 起不来：抛错', async () => {
    await expect(
      startGrokLogin({ executablePath: join(root, 'nonexistent-grok'), env: process.env }),
    ).rejects.toThrow(/Could not start grok/u);
  });

  it('超过时限仍没人同意：停掉进程，done 带说明', async () => {
    const fake = fakeGrok(`cat "$OPENED"\n${WAIT_FOR_APPROVAL}\nexit 0`);
    const flow = await startGrokLogin({
      executablePath: fake.executable,
      env: process.env,
      timeoutMs: 1500,
    });
    expect(await flow.done).toEqual({
      ok: false,
      cancelled: false,
      message: 'Sign-in timed out.',
    });
    expect(alive(fake.pidFile)).toBe(false);
  });
});
