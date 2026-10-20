// Antigravity 每次模型请求的 token（0.62.0 的 `usage.recorded`，docs/architecture/antigravity-event-mapping.md §2）。
//
// 运行体 1.3.0 不把分项用量交给 ACP 客户端：`session/prompt` 的结果只有 `stopReason`，`usage_update` 只有上下文占用的总数
// （它把输入、缓存、输出、思考加在一起）。分项只在运行体自己的会话库里：`<GEMINI_HOME>/antigravity-acp/conversations/<会话 ID>.db`
// 的 `steps` 表（Go 的 localharness 用 gorm 写；ACP 进程读它恢复会话）。每个模型回复步骤（`step_type` 15，PLANNER_RESPONSE）的
// `metadata`（`exa.cortex_pb.CortexStepMetadata`）里有 `model_usage`（`exa.codeium_common_pb.ModelUsageStats`）：
//
// - `input_tokens` 不含缓存命中（genairesponse.go 已减掉），`cache_read_tokens` / `cache_write_tokens` 另记；
// - `output_tokens` 含思考，`thinking_output_tokens` + `response_output_tokens` 是它的拆分；
// - `response_id` 每次请求唯一，作 `requestId`。
//
// 字段号取自运行体里的 proto 描述；2026-10-20 用本机 Antigravity IDE 的 104 个会话库（同一套 harness 与表结构）核对：2768 个带
// 用量的步骤全是 15 类，`response_id` 都在且不重复，输出都等于思考加正文。这里只读、只解这几个数字，不碰步骤内容。

import path from 'node:path';
import type { UsageRecordedEvent } from '@wevir/runtime-adapter';
import { openReadOnlyDatabase, type SqliteDatabase } from '@wevir/storage';

export type StepUsage = Omit<UsageRecordedEvent, 'type' | 'engineSessionId'>;

/** 会话库的路径（profile 是运行体的 GEMINI_HOME）。 */
export function antigravitySessionDatabase(profileDirectory: string, sessionId: string): string {
  return path.join(profileDirectory, 'antigravity-acp', 'conversations', `${sessionId}.db`);
}

// CortexStepStatus 里还没结束的状态：PENDING 1、RUNNING 2、GENERATING 8、WAITING 9、QUEUED 11。
const UNFINISHED = new Set([1, 2, 8, 9, 11]);

// 字段号。
const STEP_METADATA = 5;
const META_CREATED_AT = 1;
const META_VIEWABLE_AT = 6;
const META_FINISHED_GENERATING_AT = 7;
const META_MODEL_USAGE = 9;
const USAGE_INPUT = 2;
const USAGE_OUTPUT = 3;
const USAGE_CACHE_WRITE = 4;
const USAGE_CACHE_READ = 5;
const USAGE_MESSAGE_ID = 7;
const USAGE_THINKING = 9;
const USAGE_RESPONSE = 10;
const USAGE_RESPONSE_ID = 11;

type Field = number | Uint8Array;

/** protobuf 线格式的一层：字段号 → 值（varint 是 number，length-delimited 是字节）。坏数据返回 undefined。 */
function decode(bytes: Uint8Array): Map<number, Field[]> | undefined {
  const fields = new Map<number, Field[]>();
  let i = 0;
  const varint = (): number | undefined => {
    let value = 0;
    let scale = 1;
    for (let n = 0; n < 10; n++) {
      if (i >= bytes.length) return undefined;
      const byte = bytes[i++] as number;
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) return value;
      scale *= 128;
    }
    return undefined;
  };
  while (i < bytes.length) {
    const key = varint();
    if (key === undefined) return undefined;
    const field = Math.floor(key / 8);
    const wire = key % 8;
    let value: Field;
    if (wire === 0) {
      const v = varint();
      if (v === undefined) return undefined;
      value = v;
    } else if (wire === 2) {
      const length = varint();
      if (length === undefined || i + length > bytes.length) return undefined;
      value = bytes.subarray(i, i + length);
      i += length;
    } else if (wire === 1 || wire === 5) {
      i += wire === 1 ? 8 : 4;
      if (i > bytes.length) return undefined;
      continue;
    } else {
      return undefined;
    }
    if (field === 0) return undefined;
    const list = fields.get(field);
    if (list === undefined) fields.set(field, [value]);
    else list.push(value);
  }
  return fields;
}

function last(fields: Map<number, Field[]>, field: number): Field | undefined {
  const list = fields.get(field);
  return list?.[list.length - 1];
}

function count(fields: Map<number, Field[]>, field: number): number {
  const value = last(fields, field);
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : 0;
}

function text(fields: Map<number, Field[]>, field: number): string | undefined {
  const value = last(fields, field);
  if (!(value instanceof Uint8Array) || value.length === 0) return undefined;
  return Buffer.from(value).toString('utf8');
}

/** `google.protobuf.Timestamp` → 毫秒。 */
function timestamp(fields: Map<number, Field[]>, field: number): number | undefined {
  const value = last(fields, field);
  if (!(value instanceof Uint8Array)) return undefined;
  const parts = decode(value);
  if (parts === undefined) return undefined;
  const seconds = count(parts, 1);
  if (seconds === 0) return undefined;
  return seconds * 1000 + Math.floor(count(parts, 2) / 1e6);
}

/**
 * 一个步骤的 `CortexStepMetadata` → 这次请求的用量；没有 `model_usage` 或全是 0 时 undefined。`fallbackId` 用在没有
 * `response_id` / `message_id` 时（核对过的库里没有这种）。时长从步骤建立（发请求）算到生成结束，首字到步骤可见。
 */
export function stepUsage(metadata: Uint8Array, fallbackId: string): StepUsage | undefined {
  const meta = decode(metadata);
  const raw = meta === undefined ? undefined : last(meta, META_MODEL_USAGE);
  if (meta === undefined || !(raw instanceof Uint8Array)) return undefined;
  const usage = decode(raw);
  if (usage === undefined) return undefined;
  const input = count(usage, USAGE_INPUT);
  const thinking = count(usage, USAGE_THINKING);
  const output = Math.max(count(usage, USAGE_OUTPUT), thinking + count(usage, USAGE_RESPONSE));
  const cacheRead = count(usage, USAGE_CACHE_READ);
  const cacheWrite = count(usage, USAGE_CACHE_WRITE);
  if (input + output + cacheRead + cacheWrite === 0) return undefined;
  const created = timestamp(meta, META_CREATED_AT);
  const finished = timestamp(meta, META_FINISHED_GENERATING_AT);
  const viewable = timestamp(meta, META_VIEWABLE_AT);
  const since = (at: number | undefined) =>
    created !== undefined && at !== undefined && at >= created ? at - created : undefined;
  const durationMs = since(finished);
  const firstTokenMs = since(viewable);
  return {
    requestId:
      text(usage, USAGE_RESPONSE_ID) ?? text(usage, USAGE_MESSAGE_ID) ?? `step-${fallbackId}`,
    inputTokens: input,
    outputTokens: output,
    ...(cacheRead > 0 && { cacheReadTokens: cacheRead }),
    ...(cacheWrite > 0 && { cacheWriteTokens: cacheWrite }),
    ...(thinking > 0 && { reasoningTokens: thinking }),
    ...(durationMs !== undefined && { durationMs }),
    ...(firstTokenMs !== undefined && firstTokenMs <= (durationMs ?? Infinity) && { firstTokenMs }),
  };
}

/** 步骤的元数据：新的库有单独的 `metadata` 列；没有时从整个步骤（`gemini_coder.Step`）的第 5 个字段取。 */
function metadataOf(row: Record<string, unknown>): Uint8Array | undefined {
  if (row.metadata instanceof Uint8Array && row.metadata.length > 0) return row.metadata;
  if (!(row.step_payload instanceof Uint8Array)) return undefined;
  const step = decode(row.step_payload);
  const value = step === undefined ? undefined : last(step, STEP_METADATA);
  return value instanceof Uint8Array ? value : undefined;
}

/**
 * 一个会话已读到哪一步。建会话、恢复时 `start` 记下库里已有的最后一步（之前的请求不再报：恢复前报过，分支复制来的属于
 * 原会话）；回合结束后 `read` 报之后结束了的步骤。还没结束的步骤停住水位，下次再读。
 */
export class AntigravityStepUsage {
  readonly #file: string;
  #watermark = -1;
  readonly #reported = new Set<string>();

  constructor(profileDirectory: string, sessionId: string) {
    this.#file = antigravitySessionDatabase(profileDirectory, sessionId);
  }

  /** 记下库里已有的最后一步。库还不在（新会话）时从头读。 */
  start(): void {
    const db = this.#open();
    if (db === undefined) return;
    try {
      const row = db.prepare('SELECT MAX(idx) AS idx FROM steps').get();
      if (typeof row?.idx === 'number') this.#watermark = row.idx;
    } catch {
      // 还没有 steps 表：从头读。
    } finally {
      db.close();
    }
  }

  /** 读水位之后的步骤，返回新的用量；`pending` 表示还有没结束的步骤（稍后再读）。读不了时返回空。 */
  read(): { usage: StepUsage[]; pending: boolean } {
    const db = this.#open();
    if (db === undefined) return { usage: [], pending: false };
    try {
      const columns = new Set(
        db
          .prepare('PRAGMA table_info(steps)')
          .all()
          .map((column) => column.name),
      );
      const select = columns.has('metadata') ? 'metadata' : 'step_payload';
      const status = columns.has('status') ? 'status' : 'NULL AS status';
      const rows = db
        .prepare(`SELECT idx, ${status}, ${select} FROM steps WHERE idx > ? ORDER BY idx`)
        .all(this.#watermark);
      const usage: StepUsage[] = [];
      let pending = false;
      for (const row of rows) {
        if (typeof row.idx !== 'number') continue;
        if (typeof row.status === 'number' && UNFINISHED.has(row.status)) {
          pending = true;
          continue;
        }
        if (!pending) this.#watermark = row.idx;
        const metadata = metadataOf(row);
        const entry = metadata === undefined ? undefined : stepUsage(metadata, String(row.idx));
        if (entry === undefined || this.#reported.has(entry.requestId)) continue;
        this.#reported.add(entry.requestId);
        usage.push(entry);
      }
      return { usage, pending };
    } catch {
      return { usage: [], pending: false };
    } finally {
      db.close();
    }
  }

  #open(): SqliteDatabase | undefined {
    try {
      return openReadOnlyDatabase(this.#file);
    } catch {
      return undefined;
    }
  }
}
