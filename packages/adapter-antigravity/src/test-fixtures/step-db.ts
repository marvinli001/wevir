// 测试用：照 Antigravity 运行体会话库（`conversations/<id>.db` 的 `steps` 表）写步骤，元数据是手写的 protobuf（step-usage.ts）。

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { openDatabase } from '@wevir/storage';
import { antigravitySessionDatabase } from '../step-usage.js';

function varint(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  out.push(rest);
  return out;
}

export type Value = number | string | Uint8Array;

/** 一层 protobuf：number 写 varint，string / 字节写 length-delimited。 */
export function message(fields: Array<[number, Value]>): Uint8Array {
  const bytes: number[] = [];
  for (const [field, value] of fields) {
    if (typeof value === 'number') {
      bytes.push(...varint(field * 8), ...varint(value));
    } else {
      const data = typeof value === 'string' ? Buffer.from(value) : value;
      bytes.push(...varint(field * 8 + 2), ...varint(data.length), ...data);
    }
  }
  return Uint8Array.from(bytes);
}

const at = (ms: number) =>
  message([
    [1, Math.floor(ms / 1000)],
    [2, (ms % 1000) * 1e6],
  ]);

export function metadata(usage: Array<[number, Value]>, times = true): Uint8Array {
  return message([
    ...(times ? ([[1, at(1_792_193_283_718)]] as Array<[number, Value]>) : []),
    [3, 2],
    ...(times
      ? ([
          [6, at(1_792_193_290_535)],
          [7, at(1_792_193_294_883)],
        ] as Array<[number, Value]>)
      : []),
    [9, message(usage)],
    [11, 1417],
  ]);
}

/** 一次模型请求的元数据：只有 token 与 response_id。 */
export function usageMetadata(responseId: string, input: number, output = 1): Uint8Array {
  return metadata(
    [
      [2, input],
      [3, output],
      [11, responseId],
    ],
    false,
  );
}

/** 建一个会话库（`metadata` 列是新表结构；`payload` 是只有整个步骤的旧结构）。 */
export function stepDatabase(
  profile: string,
  sessionId: string,
  columns: 'metadata' | 'payload' = 'metadata',
) {
  const file = antigravitySessionDatabase(profile, sessionId);
  mkdirSync(path.dirname(file), { recursive: true });
  const db = openDatabase(file);
  db.exec(
    `CREATE TABLE IF NOT EXISTS steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, ${
      columns === 'metadata' ? 'metadata blob, ' : ''
    }step_payload blob)`,
  );
  return {
    add(idx: number, status: number, meta?: Uint8Array) {
      if (columns === 'metadata') {
        db.prepare(
          'INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, 15, ?, ?, ?)',
        ).run(idx, status, meta ?? null, message([[1, 15]]));
      } else {
        db.prepare(
          'INSERT INTO steps (idx, step_type, status, step_payload) VALUES (?, 15, ?, ?)',
        ).run(
          idx,
          status,
          message([
            [1, 15],
            ...(meta === undefined ? [] : ([[5, meta]] as Array<[number, Value]>)),
          ]),
        );
      }
    },
    update(idx: number, status: number, meta: Uint8Array) {
      db.prepare('UPDATE steps SET status = ?, metadata = ? WHERE idx = ?').run(status, meta, idx);
    },
    close: () => db.close(),
  };
}
