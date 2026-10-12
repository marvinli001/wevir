// 每一步的结果汇总到 fixtures/summary.json，报告里的结论都对照这里和各 fixture。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { saveFixture } from './acp.ts';
import { FIXTURES_DIR } from './env.ts';

export type Status = 'pass' | 'fail' | 'skip' | 'observe';

export interface CheckResult {
  step: string;
  check: string;
  status: Status;
  detail?: unknown;
}

const results: CheckResult[] = [];

export function record(step: string, check: string, status: Status, detail?: unknown): void {
  results.push({ step, check, status, detail });
  const mark = { pass: '✓', fail: '✗', skip: '–', observe: '·' }[status];
  const brief = detail === undefined ? '' : ` ${JSON.stringify(detail).slice(0, 160)}`;
  console.log(`  ${mark} [${step}] ${check}${brief}`);
}

export function expect(step: string, check: string, ok: boolean, detail?: unknown): boolean {
  record(step, check, ok ? 'pass' : 'fail', detail);
  return ok;
}

/** 合并写入 summary.<mode>.json：只替换本次运行过的 step，保留其他 step 的上次结果。 */
export function flushSummary(meta: { mode: string } & Record<string, unknown>): void {
  const name = `summary.${meta.mode}.json`;
  const file = join(FIXTURES_DIR, name);
  let previous: CheckResult[] = [];
  if (existsSync(file)) {
    previous = (JSON.parse(readFileSync(file, 'utf8')) as { results: CheckResult[] }).results;
  }
  const ran = new Set(results.map((r) => r.step));
  const merged = [...previous.filter((r) => !ran.has(r.step)), ...results];
  saveFixture(name, { meta, results: merged });
}

export function failures(): CheckResult[] {
  return results.filter((r) => r.status === 'fail');
}
