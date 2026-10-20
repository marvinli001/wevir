import { describe, expect, it } from 'vitest';
import {
  countTests,
  environmentProblem,
  errorFingerprint,
  judgeOutcome,
  roundFingerprint,
  summarize,
} from './outcome.js';

describe('countTests', () => {
  it('reads the summary lines of common runners', () => {
    expect(countTests('# tests 4\n# suites 0\n# pass 3\n# fail 1\n# skipped 0\n# todo 0')).toEqual({
      passed: 3,
      failed: 1,
      skipped: 0,
    });
    expect(countTests('ℹ tests 2\nℹ pass 2\nℹ fail 0')).toEqual({
      passed: 2,
      failed: 0,
      skipped: 0,
    });
    expect(
      countTests(' Test Files  1 passed (1)\n      Tests  1 failed | 2 passed | 1 skipped (4)'),
    ).toEqual({
      passed: 2,
      failed: 1,
      skipped: 1,
    });
    expect(countTests('Tests:       1 failed, 2 passed, 3 total')).toEqual({
      passed: 2,
      failed: 1,
      skipped: 0,
    });
    expect(countTests('  3 passing (12ms)\n  1 failing')).toEqual({
      passed: 3,
      failed: 1,
      skipped: 0,
    });
    expect(countTests('===== 2 passed, 1 failed in 0.12s =====')).toEqual({
      passed: 2,
      failed: 1,
      skipped: 0,
    });
    expect(countTests('test result: ok. 3 passed; 0 failed; 1 ignored; 0 measured')).toEqual({
      passed: 3,
      failed: 0,
      skipped: 1,
    });
    expect(countTests('ok  \texample.com/a\t0.01s\nFAIL\texample.com/b\t0.02s')).toEqual({
      passed: 1,
      failed: 1,
      skipped: 0,
    });
  });

  it('adds up repeated summaries (pnpm -r) and says when nothing is recognized', () => {
    expect(countTests('      Tests  2 passed (2)\n...\n      Tests  3 passed (3)')).toEqual({
      passed: 5,
      failed: 0,
      skipped: 0,
    });
    expect(countTests('=== no tests ran in 0.01s ===')).toEqual({
      passed: 0,
      failed: 0,
      skipped: 0,
    });
    expect(countTests('compiled successfully')).toBeUndefined();
  });
});

describe('judgeOutcome', () => {
  it('does not pass a test check that exits 0 without running tests', () => {
    expect(
      judgeOutcome({ kind: 'test', exitCode: 0, output: '# tests 0\n# pass 0\n# fail 0' }),
    ).toEqual({
      status: 'failed',
      reason: 'no_tests',
      tests: { passed: 0, failed: 0, skipped: 0 },
    });
    expect(judgeOutcome({ kind: 'test', exitCode: 0, output: 'done' })).toEqual({
      status: 'failed',
      reason: 'tests_unconfirmed',
    });
    expect(judgeOutcome({ kind: 'test', exitCode: 0, output: '# pass 2\n# fail 0' }).status).toBe(
      'passed',
    );
  });

  it('checks expectOutput and exit codes', () => {
    expect(
      judgeOutcome({ kind: 'build', exitCode: 0, output: 'ok', expectOutput: 'built in \\d+' }),
    ).toEqual({
      status: 'failed',
      reason: 'expect_unmatched',
    });
    expect(
      judgeOutcome({
        kind: 'build',
        exitCode: 0,
        output: 'built in 3s',
        expectOutput: 'BUILT IN \\d+',
      }).status,
    ).toBe('passed');
    expect(judgeOutcome({ kind: 'lint', exitCode: 1, output: 'src/a.ts: error' })).toEqual({
      status: 'failed',
      reason: 'exit_code',
    });
  });

  it('marks a missing environment instead of a code failure', () => {
    expect(
      judgeOutcome({ kind: 'test', exitCode: 127, output: 'sh: vitest: command not found' }),
    ).toEqual({
      status: 'environment_unavailable',
      reason: 'command_not_found',
    });
    expect(
      environmentProblem(1, ' ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "vitest" not found'),
    ).toBe('command_not_found');
    expect(
      environmentProblem(
        1,
        'Local package.json exists, but node_modules missing, did you mean to install?',
      ),
    ).toBe('dependencies_missing');
    // 找不到模块可能是代码写错了 import：不算环境问题。
    expect(environmentProblem(1, "Error: Cannot find module './convert.js'")).toBeUndefined();
  });
});

describe('errorFingerprint', () => {
  const base = { checkId: 'chk_1', reason: 'exit_code', cwd: '/work/repo' };

  it('ignores durations, timestamps and paths that change between runs', () => {
    const a = errorFingerprint({
      ...base,
      output:
        'not ok 1 - converts (12.5ms)\nAssertionError: 9 !== 32\n  at /work/repo/test/a.js:3:9\n# duration_ms 40.1',
    });
    const b = errorFingerprint({
      ...base,
      output:
        'not ok 1 - converts (3.1ms)\nAssertionError: 9 !== 32\n  at /work/repo/test/a.js:3:9\n# duration_ms 77.9',
    });
    expect(a).toBe(b);
  });

  it('changes when the error changes', () => {
    const a = errorFingerprint({ ...base, output: 'AssertionError: 9 !== 32' });
    const b = errorFingerprint({ ...base, output: 'AssertionError: 41 !== 32' });
    expect(a).not.toBe(b);
    // node:test 把实际值写在错误行下面。
    const detail = (actual: number) =>
      `✖ converts (1.1ms)\n  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n  ${actual} !== 32\n\n      at TestContext.<anonymous> (file:///work/repo/a.test.mjs:4:33)`;
    expect(errorFingerprint({ ...base, output: detail(0) })).not.toBe(
      errorFingerprint({ ...base, output: detail(1) }),
    );
    expect(errorFingerprint({ ...base, output: detail(0) })).toBe(
      errorFingerprint({ ...base, output: detail(0).replace('1.1ms', '9.4ms') }),
    );
    expect(roundFingerprint([a, b])).toBe(roundFingerprint([b, a]));
  });
});

describe('summarize', () => {
  it('keeps the tail and starts at a line', () => {
    const text = `${'x'.repeat(50)}\n${'line\n'.repeat(1200)}end`;
    const summary = summarize(text) ?? '';
    expect(summary.length).toBeLessThanOrEqual(4000);
    expect(summary.endsWith('end')).toBe(true);
    expect(summary.startsWith('line')).toBe(true);
    expect(summarize('  \n')).toBeUndefined();
  });
});
