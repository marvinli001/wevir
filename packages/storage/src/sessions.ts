import type { SqliteDatabase, SqlParams, SqlRow } from './driver.js';
import { changed, integer, optionalJson, optionalText, text, toNullableJson } from './rows.js';

/** 与 protocol `ActiveTurn` 同形。 */
export interface ActiveTurnRecord {
  turnId: string;
  startedAt: string;
  clientMessageId?: string;
}

/** 与 protocol `EngineErrorInfo` 同形。 */
export interface SessionErrorRecord {
  category: string;
  message: string;
}

/**
 * `sessions` 表的一行。身份字段（`id` 到 `reasoningEffort`）创建后不变；`title` 之后是由事件推导的
 * 缓存，与事件不一致时以事件为准（domain-model §3.3）。
 */
export interface SessionRecord {
  id: string;
  workspaceId: string;
  /** 创建时工作区 `rootPath` 的 realpath，resume 用。 */
  cwd: string;
  /** 引擎种类，v0 恒为 `dsh`。 */
  engine: string;
  /** 引擎会话 ID；`(engine, engineSessionId)` 唯一。 */
  engineSessionId: string;
  providerId: string;
  modelId: string;
  reasoningEffort?: string;
  title: string;
  titleSource: string;
  state: string;
  activeTurn?: ActiveTurnRecord;
  lastError?: SessionErrorRecord;
  lastSeq: number;
  createdAt: string;
  updatedAt: string;
}

/** 可更新的缓存字段。`activeTurn`、`lastError` 传 `null` 表示清空。 */
export interface SessionCachePatch {
  title?: string;
  titleSource?: string;
  state?: string;
  activeTurn?: ActiveTurnRecord | null;
  lastError?: SessionErrorRecord | null;
  lastSeq?: number;
  updatedAt?: string;
}

export interface SessionRepository {
  /** 插入新会话；工作区不存在时抛外键错误，引擎会话 ID 重复时抛唯一约束错误。 */
  insert(record: SessionRecord): void;
  get(id: string): SessionRecord | undefined;
  /** 按引擎会话 ID 找 Wevir 会话（适配器事件的路由）。 */
  getByEngineSessionId(engine: string, engineSessionId: string): SessionRecord | undefined;
  /**
   * 会话列表，最近更新的在前。默认隐藏已移除工作区的会话（domain-model §3.1）。
   */
  list(options?: { workspaceId?: string; includeRemovedWorkspaces?: boolean }): SessionRecord[];
  /** 更新缓存字段；会话不存在时返回 false。 */
  update(id: string, patch: SessionCachePatch): boolean;
  /** 状态不是 `closed` 的会话数：有这样的会话时工作区不能移除（domain-model §3.1）。 */
  countOpenByWorkspace(workspaceId: string): number;
  /** 同上，Provider 被未关闭会话引用时不能删除（domain-model §3.2）。 */
  countOpenByProvider(providerId: string): number;
}

// SessionCachePatch 字段 → 列名。update() 只拼接这里列出的列，不接受任意键。
const PATCH_COLUMNS = {
  title: 'title',
  titleSource: 'title_source',
  state: 'state',
  activeTurn: 'active_turn',
  lastError: 'last_error',
  lastSeq: 'last_seq',
  updatedAt: 'updated_at',
} as const satisfies Record<keyof SessionCachePatch, string>;

export function createSessionRepository(db: SqliteDatabase): SessionRepository {
  const insert = db.prepare(`
    INSERT INTO sessions (
      id, workspace_id, cwd, engine, engine_session_id, provider_id, model_id, reasoning_effort,
      title, title_source, state, active_turn, last_error, last_seq, created_at, updated_at
    ) VALUES (
      :id, :workspaceId, :cwd, :engine, :engineSessionId, :providerId, :modelId, :reasoningEffort,
      :title, :titleSource, :state, :activeTurn, :lastError, :lastSeq, :createdAt, :updatedAt
    )`);
  const get = db.prepare('SELECT * FROM sessions WHERE id = ?');
  const getByEngineSessionId = db.prepare(
    'SELECT * FROM sessions WHERE engine = ? AND engine_session_id = ?',
  );
  const list = db.prepare(`
    SELECT s.* FROM sessions s JOIN workspaces w ON w.id = s.workspace_id
    WHERE (:workspaceId IS NULL OR s.workspace_id = :workspaceId)
      AND (:includeRemoved = 1 OR w.removed_at IS NULL)
    ORDER BY s.updated_at DESC, s.id DESC`);
  const countOpenByWorkspace = db.prepare(
    "SELECT COUNT(*) AS n FROM sessions WHERE workspace_id = ? AND state <> 'closed'",
  );
  const countOpenByProvider = db.prepare(
    "SELECT COUNT(*) AS n FROM sessions WHERE provider_id = ? AND state <> 'closed'",
  );

  return {
    insert(record) {
      insert.run({
        id: record.id,
        workspaceId: record.workspaceId,
        cwd: record.cwd,
        engine: record.engine,
        engineSessionId: record.engineSessionId,
        providerId: record.providerId,
        modelId: record.modelId,
        reasoningEffort: record.reasoningEffort ?? null,
        title: record.title,
        titleSource: record.titleSource,
        state: record.state,
        activeTurn: toNullableJson(record.activeTurn),
        lastError: toNullableJson(record.lastError),
        lastSeq: record.lastSeq,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      });
    },
    get(id) {
      const row = get.get(id);
      return row ? fromRow(row) : undefined;
    },
    getByEngineSessionId(engine, engineSessionId) {
      const row = getByEngineSessionId.get(engine, engineSessionId);
      return row ? fromRow(row) : undefined;
    },
    list(options) {
      return list
        .all({
          workspaceId: options?.workspaceId ?? null,
          includeRemoved: options?.includeRemovedWorkspaces ? 1 : 0,
        })
        .map(fromRow);
    },
    update(id, patch) {
      const sets: string[] = [];
      const params: SqlParams = { id };
      for (const [key, column] of Object.entries(PATCH_COLUMNS)) {
        const value = patch[key as keyof SessionCachePatch];
        if (value === undefined) continue;
        sets.push(`${column} = :${key}`);
        params[key] =
          key === 'activeTurn' || key === 'lastError'
            ? toNullableJson(value)
            : (value as string | number);
      }
      if (sets.length === 0) throw new TypeError('SessionCachePatch 至少要有一个字段');
      return changed(
        db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = :id`).run(params),
      );
    },
    countOpenByWorkspace: (workspaceId) =>
      integer(countOpenByWorkspace.get(workspaceId) ?? {}, 'n'),
    countOpenByProvider: (providerId) => integer(countOpenByProvider.get(providerId) ?? {}, 'n'),
  };
}

function fromRow(row: SqlRow): SessionRecord {
  const record: SessionRecord = {
    id: text(row, 'id'),
    workspaceId: text(row, 'workspace_id'),
    cwd: text(row, 'cwd'),
    engine: text(row, 'engine'),
    engineSessionId: text(row, 'engine_session_id'),
    providerId: text(row, 'provider_id'),
    modelId: text(row, 'model_id'),
    title: text(row, 'title'),
    titleSource: text(row, 'title_source'),
    state: text(row, 'state'),
    lastSeq: integer(row, 'last_seq'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
  const reasoningEffort = optionalText(row, 'reasoning_effort');
  if (reasoningEffort !== undefined) record.reasoningEffort = reasoningEffort;
  const activeTurn = optionalJson(row, 'active_turn');
  if (activeTurn !== undefined) record.activeTurn = activeTurn as ActiveTurnRecord;
  const lastError = optionalJson(row, 'last_error');
  if (lastError !== undefined) record.lastError = lastError as SessionErrorRecord;
  return record;
}
