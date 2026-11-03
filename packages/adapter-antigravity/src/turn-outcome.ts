// SPDX-License-Identifier: MIT
// 改写自 pingdotgg/t3code apps/server/src/provider/acp/AntigravityTurnOutcome.ts
// 来源提交 ab8e488e10d883fa880b0ddcf01917b51839ab07
// Copyright (c) 2026 T3 Tools Inc.
// 修改：同步只读 SQLite，结果换成 Wevir 的 turn.failed；只读当前 prompt 新增的最后一步。

import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { PromptResponse } from '@wevir/adapter-acp/sdk';
import { redactDiagnostics, type TurnFailedEvent } from '@wevir/runtime-adapter';
import { openReadOnlyDatabase, type SqliteDatabase } from '@wevir/storage';

const MAX_ERROR_BYTES = 16_384;
const API_ERROR = /Error (\d{3}), Message: (.+?), Status: ([A-Z_]+)/su;
const DURATION_UNIT_MS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  µs: 1e-3,
  μs: 1e-3,
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

function resetAt(text: string): string | undefined {
  const timestamp = /\bquotaResetTimeStamp:([^\s\]]+)/u.exec(text)?.[1];
  if (timestamp !== undefined && Number.isFinite(Date.parse(timestamp))) return timestamp;
  const delay = /\bquotaResetDelay:((?:\d+(?:\.\d+)?(?:ns|us|µs|μs|ms|h|m|s))+)(?=[\s\]])/u.exec(
    text,
  )?.[1];
  if (delay === undefined) return undefined;
  let ms = 0;
  for (const [, amount, unit] of delay.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|μs|ms|h|m|s)/gu)) {
    ms += Number(amount) * (DURATION_UNIT_MS[unit as string] as number);
  }
  const at = Date.now() + ms;
  return ms > 0 && Number.isFinite(at) && at <= 8.64e15 ? new Date(at).toISOString() : undefined;
}

function failure(
  engineSessionId: string,
  response: PromptResponse,
  row?: Record<string, unknown>,
): TurnFailedEvent | undefined {
  if (response.stopReason !== 'end_turn' && response.stopReason !== 'refusal') return undefined;
  if (row?.step_type !== 17 && response.stopReason !== 'refusal') return undefined;
  const text = row?.payload instanceof Uint8Array ? Buffer.from(row.payload).toString('utf8') : '';
  const api = API_ERROR.exec(text);
  const quota = response.stopReason === 'refusal' || /\breason:QUOTA_EXHAUSTED\b/u.test(text);
  const limited = quota || api?.[1] === '429' || api?.[3] === 'RESOURCE_EXHAUSTED';
  const resetsAt = limited ? resetAt(text) : undefined;
  return {
    type: 'turn.failed',
    engineSessionId,
    category: 'provider',
    message: redactDiagnostics(
      quota
        ? 'You have reached your Antigravity quota for this period.'
        : api?.[2]?.trim() || 'Antigravity stopped this turn because of an error.',
    ),
    ...(api !== null && { code: Number(api[1]) }),
    ...(limited && { usageLimit: { ...(resetsAt !== undefined && { resetsAt }) } }),
  };
}

function read<A>(file: string, query: (db: SqliteDatabase) => A): A | undefined {
  try {
    const db = openReadOnlyDatabase(file);
    try {
      db.exec('PRAGMA busy_timeout = 100');
      return query(db);
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

/** 不跟随会话目录里的链接，也不将旧回合或别的会话的错误归到当前回合。 */
export function watchAntigravityPromptOutcome(
  profile: string,
  engineSessionId: string,
): (response: PromptResponse) => TurnFailedEvent | undefined {
  const typedOnly = (response: PromptResponse) => failure(engineSessionId, response);
  if (!/^[\w-]+$/u.test(engineSessionId)) return typedOnly;
  let file: string;
  let before: { dev: number; ino: number } | undefined;
  let index = -1;
  try {
    let directory = realpathSync(profile);
    for (const segment of ['antigravity-acp', 'conversations']) {
      directory = path.join(directory, segment);
      if (!lstatSync(directory).isDirectory()) return typedOnly;
    }
    file = path.join(directory, `${engineSessionId}.db`);
    const info = lstatSync(file, { throwIfNoEntry: false });
    if (info !== undefined) {
      if (!info.isFile() || info.nlink !== 1) return typedOnly;
      before = info;
      const last = read(file, (db) =>
        db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'steps'").get()
          ? db.prepare('SELECT MAX(idx) AS idx FROM steps').get()
          : { idx: -1 },
      );
      if (last === undefined) return typedOnly;
      index = typeof last.idx === 'number' ? last.idx : -1;
    }
  } catch {
    return typedOnly;
  }
  return (response) => {
    let row: Record<string, unknown> | undefined;
    try {
      if (
        !lstatSync(path.dirname(file)).isDirectory() ||
        !lstatSync(path.dirname(path.dirname(file))).isDirectory()
      )
        return typedOnly(response);
      const info = lstatSync(file);
      if (
        info.isFile() &&
        info.nlink === 1 &&
        (before === undefined || (before.dev === info.dev && before.ino === info.ino))
      ) {
        row = read(file, (db) =>
          db
            .prepare(
              'SELECT step_type, substr(step_payload, 1, ?) AS payload FROM steps WHERE idx > ? ORDER BY idx DESC LIMIT 1',
            )
            .get(MAX_ERROR_BYTES, index),
        );
      }
    } catch {
      // 没有可读的会话库时，只按 ACP 自己报的停止原因判断。
    }
    return failure(engineSessionId, response, row);
  };
}
