import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AUTOMATION_CHECK_OUTPUT_MAX_LENGTH } from '@wevir/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CheckOutcome, decide, runCheck } from './check.js';

const posix = process.platform !== 'win32';
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wevir-check-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe.runIf(posix)('runCheck', () => {
  it('在给的目录跑，合并 stdout 与 stderr、去掉控制序列，记退出码', async () => {
    const outcome = await runCheck({
      command: "pwd; printf '\\033[31mred\\033[0m\\n' >&2; exit 1",
      cwd: dir,
      timeoutMs: 10_000,
    });
    expect(outcome.exitCode).toBe(1);
    expect(outcome.timedOut).toBe(false);
    expect(outcome.output).toContain('wevir-check-');
    expect(outcome.output).toContain('red\n');
    expect(outcome.output).not.toContain('\u001b');
  });

  it('超时时结束整个进程组', async () => {
    const marker = join(dir, 'grandchild');
    const started = Date.now();
    const outcome = await runCheck({
      command: `(sleep 3; echo alive > ${marker}) & sleep 30`,
      cwd: dir,
      timeoutMs: 300,
    });
    expect(outcome).toMatchObject({ exitCode: null, timedOut: true });
    expect(Date.now() - started).toBeLessThan(5_000);
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    await expect(readFile(marker, 'utf8')).rejects.toThrow();
  }, 15_000);

  it('输出太长时只留末尾；摘要看整段', async () => {
    const command = `node -e "process.stdout.write('a'.repeat(200000) + 'END')"`;
    const one = await runCheck({ command, cwd: dir, timeoutMs: 10_000 });
    expect(one.truncated).toBe(true);
    expect(one.output).toHaveLength(AUTOMATION_CHECK_OUTPUT_MAX_LENGTH);
    expect(one.output.endsWith('aEND')).toBe(true);
    const other = await runCheck({
      command: `node -e "process.stdout.write('b' + 'a'.repeat(199999) + 'END')"`,
      cwd: dir,
      timeoutMs: 10_000,
    });
    expect(other.output).toBe(one.output);
    expect(other.fingerprint).not.toBe(one.fingerprint);
  });

  it('目录不在时起不来', async () => {
    const outcome = await runCheck({ command: 'true', cwd: join(dir, 'gone'), timeoutMs: 5_000 });
    expect(outcome.exitCode).toBeNull();
    expect(outcome.error).toBeDefined();
  });

  it('取消时结束进程', async () => {
    const abort = new AbortController();
    const pending = runCheck({
      command: 'sleep 30',
      cwd: dir,
      timeoutMs: 60_000,
      signal: abort.signal,
    });
    setTimeout(() => abort.abort(), 100);
    expect(await pending).toMatchObject({ cancelled: true, exitCode: null });
  });
});

describe('decide', () => {
  const outcome = (partial: Partial<CheckOutcome>): CheckOutcome => ({
    exitCode: 0,
    timedOut: false,
    cancelled: false,
    durationMs: 1,
    output: '',
    truncated: false,
    fingerprint: 'f1',
    ...partial,
  });
  const byExit = { command: 'x', wake: 'exit_code' } as const;
  const byOutput = { command: 'x', wake: 'output_changed', timeoutSeconds: 5 } as const;

  it('按退出码：0 唤醒、1 不唤醒、别的失败；不动基准', () => {
    expect(decide(byExit, outcome({ exitCode: 0 }), 'b').result.decision).toBe('wake');
    expect(decide(byExit, outcome({ exitCode: 1 }), 'b')).toMatchObject({
      result: { decision: 'silent' },
      baseline: 'b',
    });
    expect(decide(byExit, outcome({ exitCode: 127 }), undefined).result).toMatchObject({
      decision: 'failed',
      exitCode: 127,
    });
  });

  it('按输出：第一次作基准，同则不唤醒，变了唤醒；超时失败、不动基准', () => {
    expect(decide(byOutput, outcome({}), undefined)).toMatchObject({
      result: { decision: 'silent', error: expect.stringMatching(/baseline/) },
      baseline: 'f1',
    });
    expect(decide(byOutput, outcome({ exitCode: 8 }), 'f1').result.decision).toBe('silent');
    expect(decide(byOutput, outcome({ fingerprint: 'f2' }), 'f1')).toMatchObject({
      result: { decision: 'wake' },
      baseline: 'f2',
    });
    expect(
      decide(byOutput, outcome({ exitCode: null, timedOut: true, fingerprint: 'f3' }), 'f1'),
    ).toMatchObject({
      result: { decision: 'failed', timedOut: true, error: 'The check timed out after 5 s.' },
      baseline: 'f1',
    });
  });
});
