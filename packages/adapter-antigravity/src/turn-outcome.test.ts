import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '@wevir/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { antigravitySessionDatabase } from './step-usage.js';
import { watchAntigravityPromptOutcome } from './turn-outcome.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const profile = mkdtempSync(path.join(tmpdir(), 'wevir-agy-outcome-'));
  directories.push(profile);
  const id = 'session-test';
  const file = antigravitySessionDatabase(profile, id);
  mkdirSync(path.dirname(file), { recursive: true });
  let index = 0;
  const add = (type: number, text: string) => {
    const db = openDatabase(file);
    try {
      db.exec(
        'CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)',
      );
      db.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(index++, type, Buffer.from(text));
    } finally {
      db.close();
    }
  };
  return { profile, id, file, add, watch: () => watchAntigravityPromptOutcome(profile, id) };
}

const QUOTA =
  'Error 429, Message: Quota exhausted., Status: RESOURCE_EXHAUSTED, Details: [reason:QUOTA_EXHAUSTED quotaResetTimeStamp:2026-12-01T00:00:00Z]';

describe('Antigravity prompt outcome', () => {
  it('识别 end_turn 的额度错误与恢复时间；忽略旧回合错误和正常回答中的错误文字', () => {
    const f = fixture();
    const first = f.watch();
    f.add(17, QUOTA);
    expect(first({ stopReason: 'end_turn' })).toMatchObject({
      type: 'turn.failed',
      category: 'provider',
      code: 429,
      usageLimit: { resetsAt: '2026-12-01T00:00:00Z' },
    });
    const next = f.watch();
    expect(next({ stopReason: 'end_turn' })).toBeUndefined();
    f.add(15, QUOTA);
    expect(next({ stopReason: 'end_turn' })).toBeUndefined();
  });

  it('普通上游错误算失败；临时 429 也带 usageLimit，未知错误不暴露栈', () => {
    const f = fixture();
    for (const [text, expected] of [
      [
        'Error 503, Message: Service unavailable, Status: UNAVAILABLE\nstack',
        { message: 'Service unavailable', code: 503 },
      ],
      [
        'Error 429, Message: Rate limited, Status: RESOURCE_EXHAUSTED',
        { message: 'Rate limited', usageLimit: {} },
      ],
      [
        'internal stack and private paths',
        { message: 'Antigravity stopped this turn because of an error.' },
      ],
    ] as const) {
      const check = f.watch();
      f.add(17, text);
      expect(check({ stopReason: 'end_turn' })).toMatchObject(expected);
    }
  });

  it('非法恢复时间回退到时长；cancelled 不变成额度错误', () => {
    const f = fixture();
    const check = f.watch();
    const before = Date.now();
    f.add(
      17,
      QUOTA.replace('2026-12-01T00:00:00Z', 'soon').replace(']', ' quotaResetDelay:1h2m3s]'),
    );
    const outcome = check({ stopReason: 'end_turn' });
    const at = Date.parse(outcome?.usageLimit?.resetsAt ?? '');
    expect(at).toBeGreaterThanOrEqual(before + 3_723_000);
    expect(at).toBeLessThanOrEqual(Date.now() + 3_723_000);
    expect(check({ stopReason: 'cancelled' })).toBeUndefined();
  });

  it('refusal 没有会话库时仍算额度错误；拒绝路径穿越与链接日志', () => {
    const f = fixture();
    const invalid = watchAntigravityPromptOutcome(f.profile, '../outside');
    expect(invalid({ stopReason: 'refusal' })).toMatchObject({ usageLimit: {} });
    f.add(17, QUOTA);
    const linked = antigravitySessionDatabase(f.profile, 'linked');
    symlinkSync(f.file, linked);
    const check = watchAntigravityPromptOutcome(f.profile, 'linked');
    expect(check({ stopReason: 'end_turn' })).toBeUndefined();
    expect(check({ stopReason: 'refusal' })).toMatchObject({ usageLimit: {} });
  });
});
