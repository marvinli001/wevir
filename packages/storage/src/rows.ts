import type { SqlRow, SqlValue } from './driver.js';

// 行与记录之间的转换工具，只在本包内用。表都是 STRICT，类型不符说明 schema 与代码不一致，直接抛错。

export function text(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw new Error(`列 ${column} 应为 TEXT，实际为 ${typeof value}`);
  return value;
}

export function optionalText(row: SqlRow, column: string): string | undefined {
  return row[column] === null ? undefined : text(row, column);
}

export function integer(row: SqlRow, column: string): number {
  const value = row[column];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`列 ${column} 应为 INTEGER，实际为 ${typeof value}`);
}

export function json(row: SqlRow, column: string): unknown {
  return JSON.parse(text(row, column));
}

export function optionalJson(row: SqlRow, column: string): unknown {
  return row[column] === null ? undefined : json(row, column);
}

/** 序列化 JSON 列；`undefined`、函数这类序列化不出来的值直接拒绝。 */
export function toJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('值不能序列化为 JSON');
  return serialized;
}

/** 可空 JSON 列：`undefined` 与 `null` 都存 SQL NULL。 */
export function toNullableJson(value: unknown): string | null {
  return value === undefined || value === null ? null : toJson(value);
}

export function orNull(value: string | number | undefined): SqlValue {
  return value ?? null;
}

export function changed(result: { changes: number | bigint }): boolean {
  return Number(result.changes) > 0;
}
