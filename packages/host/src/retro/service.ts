// 任务回顾（0.76.0，`retro.*`，ADR-0012）：读写投影（按需生成、落后时增量更新、坏了从头重放）、现读不在事件里的东西、组出回顾、
// 可选的模型摘要与脱敏。不在后台更新：只有 `retro.get`、`retro.summarize` 与 Agent 的 `wevir_session_retro` 会算。

import {
  RETRO_SCHEMA_VERSION,
  type RetroSummary,
  RetroSummarySchema,
  type SessionId,
  type SessionRetro,
} from '@wevir/protocol';
import type { Storage } from '@wevir/storage';
import { HostError } from '../errors.js';
import type { EventStore } from '../event-store.js';
import { buildRetro } from './build.js';
import { emptyRetroState, foldRetro, parseRetroState, type RetroState } from './fold.js';
import { type RetroLiveDeps, readRetroLive } from './live.js';
import { redactRetro } from './redact.js';
import {
  parseRetroSummary,
  RETRO_SUMMARY_OUTPUT_SCHEMA,
  RETRO_SUMMARY_TIMEOUT_MS,
  retroIds,
  retroSummaryInput,
} from './summary.js';

/** 发一次不带工具的请求（SessionManager.generateOnce）。 */
export type RetroGenerate = (
  sessionId: SessionId,
  request: {
    instructions: string;
    input: string;
    outputSchema: Record<string, unknown>;
    timeoutMs: number;
    onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void;
  },
) => Promise<{ text: string; providerId: string; modelId: string } | { reason: string }>;

export interface RetroServiceOptions extends Omit<RetroLiveDeps, 'session'> {
  storage: Storage;
  events: EventStore;
  /** 模型摘要的说明（prompts/session-retro.md）；没有时 `retro.summarize` 回 `unsupported`。 */
  instructions?: string;
  generate?: RetroGenerate;
  onWarning?: (message: string, fields?: Record<string, unknown>) => void;
  now?: () => Date;
}

export interface RetroProjection {
  state: RetroState;
  build: SessionRetro['build'];
  builtAt: string;
}

export class RetroService {
  readonly #options: RetroServiceOptions;

  constructor(options: RetroServiceOptions) {
    this.#options = options;
  }

  /**
   * 投影：没有、版本不同、坏了（解析不了、形状不对）、比库还新（库被换过）时从头重放；否则只归约新事件。写回 SQLite。同步执行（Host
   * 只有一个数据库连接，读事件与写投影之间没有别的写入）。
   */
  projection(sessionId: SessionId): RetroProjection {
    const { storage, events } = this.#options;
    if (storage.sessions.get(sessionId) === undefined) {
      throw new HostError('SESSION_NOT_FOUND', `session ${sessionId} not found`);
    }
    const lastSeq = storage.events.lastSeq(sessionId);
    const row = storage.retros.get(sessionId);
    const now = this.#now();
    let state: RetroState | undefined;
    let reason: string | undefined;
    if (row !== undefined) {
      if (row.schemaVersion !== RETRO_SCHEMA_VERSION) reason = 'schema_version';
      else {
        state = parseRetroState(row.state);
        if (state === undefined) reason = 'corrupt';
        else if (state.throughSeq !== row.throughSeq || state.throughSeq > lastSeq) {
          reason = 'ahead_of_events';
          state = undefined;
        }
      }
    }
    if (reason === 'corrupt' || reason === 'ahead_of_events') {
      this.#options.onWarning?.('任务回顾的投影不可用，从事件重建', { sessionId, reason });
    }
    if (state !== undefined && row !== undefined && state.throughSeq === lastSeq) {
      return { state, build: 'cached', builtAt: row.updatedAt };
    }
    const build: SessionRetro['build'] = state === undefined ? 'full' : 'incremental';
    const base = state ?? emptyRetroState();
    const next = foldRetro(base, events.readSince(sessionId, base.throughSeq));
    storage.retros.put({
      sessionId,
      schemaVersion: RETRO_SCHEMA_VERSION,
      throughSeq: next.throughSeq,
      state: JSON.stringify(next),
      builtAt: build === 'full' || row === undefined ? now : row.builtAt,
      updatedAt: now,
    });
    return { state: next, build, builtAt: now };
  }

  /** `retro.get`。 */
  async get(
    sessionId: SessionId,
    options: { redact?: boolean } = {},
  ): Promise<{ retro: SessionRetro; redactions?: number }> {
    const retro = await this.#retro(sessionId);
    if (options.redact !== true) return { retro };
    const redacted = redactRetro(retro);
    return { retro: redacted.retro, redactions: redacted.count };
  }

  async #retro(sessionId: SessionId): Promise<SessionRetro> {
    const { storage } = this.#options;
    const projection = this.projection(sessionId);
    const record = storage.sessions.get(sessionId);
    if (record === undefined)
      throw new HostError('SESSION_NOT_FOUND', `session ${sessionId} not found`);
    const live = await readRetroLive(
      {
        ...this.#options,
        session: (id) => {
          const found = storage.sessions.get(id);
          return found === undefined ? undefined : { title: found.title };
        },
      },
      {
        sessionId,
        workspaceId: record.workspaceId,
        cwd: record.cwd,
        closed: record.state === 'closed',
        state: projection.state,
      },
    );
    const retro = buildRetro({
      sessionId,
      cwd: record.cwd,
      state: projection.state,
      live,
      builtAt: projection.builtAt,
      build: projection.build,
    });
    const titled = record.title === '' ? retro : { ...retro, title: record.title };
    const summary = this.#summary(sessionId, projection.state);
    return summary === undefined ? titled : { ...titled, summary };
  }

  /** 存下的摘要；解析不了就当没有。之后会话又有了有内容的事件时标 `outdated`。 */
  #summary(sessionId: SessionId, state: RetroState): RetroSummary | undefined {
    const row = this.#options.storage.retros.getSummary(sessionId);
    if (row === undefined) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(row.summary);
    } catch {
      return undefined;
    }
    const parsed = RetroSummarySchema.safeParse(value);
    if (!parsed.success) return undefined;
    const { outdated: _, ...summary } = parsed.data;
    return state.lastSubstantiveSeq > summary.throughSeq ? { ...summary, outdated: true } : summary;
  }

  /** `retro.summarize`：用会话当前的模型写一份摘要，存下（替换上一份）。失败回 `reason`，不抛错，不动骨架。 */
  async summarize(sessionId: SessionId): Promise<{ summary?: RetroSummary; reason?: string }> {
    const { instructions, generate } = this.#options;
    if (instructions === undefined || generate === undefined) return { reason: 'unsupported' };
    const retro = await this.#retro(sessionId);
    if (retro.turns.length === 0) return { reason: 'empty' };
    const { retro: redacted } = redactRetro({ ...retro, summary: undefined } as SessionRetro);
    const input = retroSummaryInput(redacted);
    let usage: RetroSummary['usage'];
    const result = await generate(sessionId, {
      instructions,
      input,
      outputSchema: { ...RETRO_SUMMARY_OUTPUT_SCHEMA },
      timeoutMs: RETRO_SUMMARY_TIMEOUT_MS,
      onUsage: (reported) => {
        usage = reported;
      },
    });
    if ('reason' in result) return { reason: result.reason };
    const points = parseRetroSummary(result.text, retroIds(retro));
    if (points === undefined) {
      this.#options.onWarning?.('回顾摘要无法解析，不保存', {
        sessionId,
        output: result.text.slice(0, 500),
      });
      return { reason: 'unparsable' };
    }
    const summary: RetroSummary = {
      points,
      providerId: result.providerId,
      modelId: result.modelId,
      throughSeq: retro.throughSeq,
      generatedAt: this.#now(),
      inputBytes: Buffer.byteLength(input, 'utf8'),
      outputBytes: Buffer.byteLength(result.text, 'utf8'),
      ...(usage !== undefined && { usage }),
    };
    this.#options.storage.retros.putSummary({
      sessionId,
      summary: JSON.stringify(summary),
      createdAt: summary.generatedAt,
    });
    return { summary };
  }

  #now(): string {
    return (this.#options.now?.() ?? new Date()).toISOString();
  }
}
