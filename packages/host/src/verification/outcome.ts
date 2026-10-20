// 从检查的退出码与输出判断结果（0.65.0，ADR-0008 决策 7、8、12）：通过不只看退出码；识别测试计数、环境不可用与失败的错误指纹。
// 都是纯函数，输入是去掉了 ANSI 控制序列的输出。

import { createHash } from 'node:crypto';
import type { CheckKind, VerificationStatus, VerificationTests } from '@wevir/protocol';
import { VERIFICATION_SUMMARY_MAX_LENGTH } from '@wevir/protocol';

export interface CheckOutcome {
  status: Extract<VerificationStatus, 'passed' | 'failed' | 'environment_unavailable'>;
  reason?: string;
  tests?: VerificationTests;
}

/** 能让修复链开始或继续的失败原因：都是代码本身的问题。 */
export const REPAIRABLE_REASONS: ReadonlySet<string> = new Set([
  'exit_code',
  'no_tests',
  'expect_unmatched',
]);

/**
 * 一次运行的结果。`exitCode` 为 null 表示被信号结束（这里不处理超时与取消，调用方先判断）。
 */
export function judgeOutcome(input: {
  kind: CheckKind;
  exitCode: number | null;
  output: string;
  expectOutput?: string;
}): CheckOutcome {
  const { kind, exitCode, output } = input;
  const tests = kind === 'test' ? countTests(output) : undefined;
  const withTests = tests !== undefined ? { tests } : {};
  if (exitCode !== 0) {
    const environment = environmentProblem(exitCode, output);
    if (environment !== undefined) {
      return { status: 'environment_unavailable', reason: environment, ...withTests };
    }
    return { status: 'failed', reason: 'exit_code', ...withTests };
  }
  if (input.expectOutput !== undefined && !expectMatches(input.expectOutput, output)) {
    return { status: 'failed', reason: 'expect_unmatched', ...withTests };
  }
  if (kind === 'test') {
    if (tests === undefined) return { status: 'failed', reason: 'tests_unconfirmed' };
    if (tests.passed + tests.failed === 0) return { status: 'failed', reason: 'no_tests', tests };
    if (tests.failed > 0) return { status: 'failed', reason: 'exit_code', tests };
  }
  return { status: 'passed', ...withTests };
}

function expectMatches(pattern: string, output: string): boolean {
  try {
    return new RegExp(pattern, 'im').test(output);
  } catch {
    // 保存时已校验过；万一不合法，当作字面文本找。
    return output.toLowerCase().includes(pattern.toLowerCase());
  }
}

/** `expectOutput` 是不是合法的正则（`checks.save` 用）。 */
export function validExpectOutput(pattern: string): boolean {
  try {
    new RegExp(pattern, 'im');
    return true;
  } catch {
    return false;
  }
}

/**
 * 依赖或命令本身不可用（不是代码的问题）：126 / 127、shell 或包管理器报命令找不到、pnpm 报没装依赖。`Cannot find module`
 * 一类不算：那也可能是 Agent 写错了 import。
 */
export function environmentProblem(exitCode: number | null, output: string): string | undefined {
  if (/Local package\.json exists, but node_modules missing/i.test(output)) {
    return 'dependencies_missing';
  }
  if (exitCode === 126 || exitCode === 127) return 'command_not_found';
  if (
    /(^|\n)[^\n]*(command not found|: not found$|is not recognized as an internal or external command)/im.test(
      output,
    ) ||
    /ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL[^\n]*Command "[^"]+" not found/i.test(output) ||
    /(^|\n)\s*(npm ERR!|ERR!) missing script:/im.test(output) ||
    /ERR_PNPM_NO_SCRIPT|None of the selected packages has a "[^"]+" script/i.test(output)
  ) {
    return 'command_not_found';
  }
  return undefined;
}

type Counts = { passed: number; failed: number; skipped: number };

function add(total: Counts | undefined, part: Partial<Counts>): Counts {
  return {
    passed: (total?.passed ?? 0) + (part.passed ?? 0),
    failed: (total?.failed ?? 0) + (part.failed ?? 0),
    skipped: (total?.skipped ?? 0) + (part.skipped ?? 0),
  };
}

function words(segment: string): Partial<Counts> {
  const counts: Partial<Counts> = {};
  for (const match of segment.matchAll(
    /(\d+)\s+(passed|passing|pass|failed|failing|fail|errors?|skipped|pending|todo|ignored|xfailed|xpassed|deselected)\b/gi,
  )) {
    const n = Number(match[1]);
    const word = (match[2] ?? '').toLowerCase();
    if (word.startsWith('pass') || word === 'xpassed') counts.passed = (counts.passed ?? 0) + n;
    else if (word.startsWith('fail') || word.startsWith('error'))
      counts.failed = (counts.failed ?? 0) + n;
    else counts.skipped = (counts.skipped ?? 0) + n;
  }
  return counts;
}

/**
 * 从常见测试框架的汇总行里数出跑过的测试；一行都认不出时 undefined。按下面的顺序取第一种认得出的格式，同一种格式出现多次
 * （`pnpm -r` 跑了几个包）时相加。
 */
export function countTests(output: string): VerificationTests | undefined {
  const lines = output.split(/\r?\n/);
  const formats: Array<(line: string) => Partial<Counts> | undefined> = [
    // Vitest：` Tests  1 failed | 2 passed (3)`
    (line) => (/^\s*Tests\s{2,}\d+\s+\w+/.test(line) ? words(line) : undefined),
    // Jest：`Tests:       1 failed, 2 passed, 3 total`
    (line) => (/^\s*Tests:\s+\d+/.test(line) ? words(line.replace(/\d+\s+total/i, '')) : undefined),
    // node:test 的 TAP 与 spec 汇总：`# pass 3` / `ℹ pass 3`
    (line) => {
      const match = /^\s*(?:#|ℹ)\s+(pass|fail|skipped|todo|cancelled)\s+(\d+)\s*$/.exec(line);
      if (!match) return undefined;
      const n = Number(match[2]);
      if (match[1] === 'pass') return { passed: n };
      if (match[1] === 'fail' || match[1] === 'cancelled') return { failed: n };
      return { skipped: n };
    },
    // Mocha：`  3 passing (12ms)`、`  1 failing`、`  2 pending`
    (line) => (/^\s*\d+\s+(passing|failing|pending)\b/.test(line) ? words(line) : undefined),
    // pytest：`==== 2 passed, 1 failed in 0.12s ====`
    (line) =>
      /^=+ .*\b\d+ (passed|failed|error|errors|skipped)\b.* in [\d.]+s/.test(line)
        ? words(line)
        : undefined,
    // pytest 什么都没收集到：`no tests ran in 0.01s`
    (line) => (/^=+ no tests ran\b/.test(line) ? {} : undefined),
    // Cargo：`test result: ok. 3 passed; 0 failed; 1 ignored; …`
    (line) => (/^test result: /.test(line) ? words(line) : undefined),
    // Go：每个包一行 `ok  \tpkg\t0.01s` / `FAIL\tpkg` / `?   \tpkg\t[no test files]`
    (line) => {
      if (/^ok\s+\S+\s+(\(cached\)|[\d.]+s)/.test(line)) return { passed: 1 };
      if (/^FAIL\s+\S+/.test(line)) return { failed: 1 };
      if (/^\?\s+\S+\s+\[no test files\]/.test(line)) return {};
      return undefined;
    },
  ];
  for (const format of formats) {
    let total: Counts | undefined;
    for (const line of lines) {
      const part = format(line);
      if (part !== undefined) total = add(total, part);
    }
    if (total !== undefined) return total;
  }
  return undefined;
}

/** 输出的尾部：最多 `VERIFICATION_SUMMARY_MAX_LENGTH` 字，从一行的开头截起。 */
export function summarize(output: string): string | undefined {
  const text = output.replace(/\s+$/, '');
  if (text === '') return undefined;
  if (text.length <= VERIFICATION_SUMMARY_MAX_LENGTH) return text;
  const tail = text.slice(-VERIFICATION_SUMMARY_MAX_LENGTH);
  const newline = tail.indexOf('\n');
  return newline > 0 && newline < 400 ? tail.slice(newline + 1) : tail;
}

const ERROR_LINE =
  /(^|\s)(FAIL\b|FAILED\b|not ok\b|✗|✖|×|AssertionError|[A-Za-z]*Error\b|error(\[\w+\])?:|error TS\d+|panicked at|Traceback|E {3})/;

/** 一行错误去掉每次运行都会变的部分：耗时、时间戳、地址、绝对路径前缀。 */
function normalizeLine(line: string, cwd: string): string {
  let text = line;
  if (cwd !== '') text = text.split(cwd).join('');
  return text
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, '<time>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<addr>')
    .replace(/\(?\b\d+(\.\d+)?\s?(ms|s|µs|us|ns|m)\b\)?/g, '<dur>')
    .replace(/(\/private)?\/(tmp|var\/folders)\/[^\s:'"]+/g, '<tmp>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 错误行，连同每行之后最多 `ERROR_CONTEXT_LINES` 个非空行，到调用栈为止：断言的细节（`0 !== 32`、期望与实际）常常在错误行的下面，
 * 不带上它们，错得不一样的两次会算成同一个错误。
 */
function errorLines(lines: readonly string[]): string[] {
  const picked: string[] = [];
  lines.forEach((line, index) => {
    if (!ERROR_LINE.test(line)) return;
    picked.push(line);
    let taken = 0;
    for (let next = index + 1; next < lines.length && taken < ERROR_CONTEXT_LINES; next++) {
      const text = lines[next] as string;
      if (text.trim() === '') continue;
      if (/^\s*at\s/.test(text) || ERROR_LINE.test(text)) break;
      picked.push(text);
      taken++;
    }
  });
  return picked;
}

const ERROR_CONTEXT_LINES = 3;

/**
 * 失败的错误指纹（决策 12）：输出里的错误行（带下面几行细节）规整、排序、去重后，连同检查 ID 与失败原因求散列；一行错误都没认出时用规整后的
 * 最后 20 行。同一个错误反复出现时指纹相同，修复链据此停下。
 */
export function errorFingerprint(input: {
  checkId: string;
  reason: string;
  output: string;
  cwd: string;
}): string {
  const lines = input.output.split(/\r?\n/);
  let picked = errorLines(lines).map((line) => normalizeLine(line, input.cwd));
  if (picked.length === 0) {
    picked = lines
      .map((line) => normalizeLine(line, input.cwd))
      .filter((line) => line !== '')
      .slice(-20);
  }
  const unique = [...new Set(picked.filter((line) => line !== ''))].sort().slice(0, 200);
  const hash = createHash('sha256');
  hash.update(`${input.checkId}\n${input.reason}\n${unique.join('\n')}`);
  return `sha256:${hash.digest('hex').slice(0, 32)}`;
}

/** 一轮失败的指纹：各检查的指纹排序后合起来。 */
export function roundFingerprint(fingerprints: readonly string[]): string {
  const hash = createHash('sha256');
  hash.update([...fingerprints].sort().join('\n'));
  return `sha256:${hash.digest('hex').slice(0, 32)}`;
}
