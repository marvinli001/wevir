import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyInstallFailure, Redactor, startInstall } from './install.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Redactor', () => {
  it('遮住已知的值与常见的凭据写法', () => {
    const redactor = new Redactor(['s3cr3t-value', 'abc']);
    expect(redactor.redact('token is s3cr3t-value here')).toBe('token is *** here');
    // 太短的值不遮（会误伤正常输出）。
    expect(redactor.redact('abc')).toBe('abc');
    expect(redactor.redact('//npm.example/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123')).toBe(
      '//npm.example/:_authToken=***',
    );
    expect(redactor.redact('Authorization: Bearer eyJhbGciOi.x.y')).toBe(
      'Authorization: Bearer ***',
    );
    expect(redactor.redact('GET https://user:pa55@registry.example/pkg')).toBe(
      'GET https://***@registry.example/pkg',
    );
    expect(redactor.redact('using ghp_0123456789abcdefghijABCDEFGHIJ')).toBe('using ***');
  });
});

describe('classifyInstallFailure', () => {
  it.each([
    [
      'npm error code ENOTFOUND\nnpm error network request to https://registry.npmjs.org/zod failed',
      'network',
    ],
    [
      ' ERR_PNPM_META_FETCH_FAIL  GET https://registry.npmjs.org/zod: request to … failed, reason: getaddrinfo EAI_AGAIN',
      'network',
    ],
    [
      'npm error code E401\nnpm error 401 Unauthorized - GET http://127.0.0.1/left',
      'registry_auth',
    ],
    [' ERR_PNPM_FETCH_403  GET https://npm.corp/x: Forbidden - 403', 'registry_auth'],
    ['npm error code EACCES\nnpm error syscall mkdir', 'permission'],
    [
      ' ERR_PNPM_OUTDATED_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date',
      'lockfile_mismatch',
    ],
    [
      'npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.',
      'lockfile_mismatch',
    ],
    [
      'error: The lockfile at `uv.lock` needs to be updated, but `--locked` was provided.',
      'lockfile_mismatch',
    ],
    [
      ' ERR_PNPM_UNSUPPORTED_ENGINE  Unsupported environment (bad pnpm and/or Node.js version)',
      'incompatible',
    ],
    ['sh: pnpm: command not found', 'not_found'],
    ['something else broke', 'exit_code'],
  ])('%s → %s', (output, expected) => {
    expect(classifyInstallFailure(1, output)).toBe(expected);
  });
});

describe.skipIf(process.platform === 'win32')('startInstall', () => {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, SHELL: '/bin/sh' };
  const logDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'wevir-install-'));
    dirs.push(dir);
    return dir;
  };

  it('输出遮住凭据后才写进日志，凭据作为环境变量交给进程', async () => {
    const dir = logDir();
    const process = startInstall({
      command: 'printf "token=$REG_TOKEN\\nplain line\\n"; printf "no newline at end $REG_TOKEN"',
      cwd: dir,
      env,
      extraEnv: { REG_TOKEN: 'super-secret-token' },
      platform: 'darwin',
      logPath: join(dir, 'install.log'),
      timeoutMs: 10_000,
      redactor: new Redactor(['super-secret-token']),
    });
    const result = await process.result;
    expect(result).toMatchObject({ kind: 'exited', exitCode: 0 });
    const log = readFileSync(join(dir, 'install.log'), 'utf8');
    expect(log).toBe('token=***\nplain line\nno newline at end ***');
    expect(result.tail).not.toContain('super-secret-token');
    expect(result.bytes).toBe(Buffer.byteLength(log));
  });

  it('取消与超时都结束整个进程组', async () => {
    const dir = logDir();
    const started = Date.now();
    const cancelled = startInstall({
      command: 'sleep 30 & sleep 30',
      cwd: dir,
      env,
      extraEnv: {},
      platform: 'darwin',
      logPath: join(dir, 'a.log'),
      timeoutMs: 60_000,
      redactor: new Redactor([]),
    });
    setTimeout(() => cancelled.cancel(), 200);
    expect((await cancelled.result).kind).toBe('cancelled');
    const timedOut = startInstall({
      command: 'sleep 30',
      cwd: dir,
      env,
      extraEnv: {},
      platform: 'darwin',
      logPath: join(dir, 'b.log'),
      timeoutMs: 300,
      redactor: new Redactor([]),
    });
    expect((await timedOut.result).kind).toBe('timed_out');
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});
