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
 * `sessions` 表的一行。身份字段（`id` 到 `parentToolCallId`）创建后不变，`modelId`、`reasoningEffort` 与 `permissionMode`
 * 除外：0.9.0 起（权限模式 0.11.0 起）可由 `session.configured` 事件改，同 `title` 之后的列一样是由事件推导的缓存，与事件不一致时以事件为准
 * （domain-model §3.3）。
 */
export interface SessionRecord {
  id: string;
  workspaceId: string;
  /** 创建时工作区 `rootPath` 的 realpath，resume 用；环境会话可以是 worktree 里的目录（0004_environments）。 */
  cwd: string;
  /** 引擎种类，v0 恒为 `dsh`。 */
  engine: string;
  /** 引擎会话 ID；`(engine, engineSessionId)` 唯一。 */
  engineSessionId: string;
  providerId: string;
  modelId: string;
  reasoningEffort?: string;
  /** 权限模式（U15，0003_permission_mode）：省略表示 `on_request`。 */
  permissionMode?: string;
  /** 环境会话（U22.1，0004_environments）：用哪个环境建的、额外的可写目录、新开的 worktree。建会话后不变。 */
  environmentId?: string;
  extraRoots?: string[];
  worktrees?: { workspaceId: string; path: string; branch: string }[];
  /** 从一项建议开出来的会话（U23，0005_session_origin）：提出建议的会话与建议的 ID。建会话后不变。 */
  origin?: { kind: string; sessionId: string; taskId: string };
  /** 支线会话（U23.1，0006_side_sessions）：从哪个会话、到它哪个完成的回合为止分出来。建会话后不变。 */
  forkedFrom?: { sessionId: string; turnId?: string };
  side?: true;
  /** 子会话的父会话（R4，0002_subagents）；普通会话没有。 */
  parentSessionId?: string;
  /** 子会话：父会话里派出它的工具调用。 */
  parentToolCallId?: string;
  title: string;
  titleSource: string;
  state: string;
  activeTurn?: ActiveTurnRecord;
  lastError?: SessionErrorRecord;
  lastSeq: number;
  createdAt: string;
  updatedAt: string;
  /** 归档的时刻（0009_session_archive，协议 0.23.0）；没有归档时省略。不是事件推导的缓存。 */
  archivedAt?: string;
}

/** 可更新的缓存字段。`activeTurn`、`lastError`、`reasoningEffort` 传 `null` 表示清空。 */
export interface SessionCachePatch {
  modelId?: string;
  reasoningEffort?: string | null;
  permissionMode?: string;
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
   * 会话列表，最近更新的在前。默认隐藏已移除工作区的会话（domain-model §3.1），也不含子会话（§3.3.1）：给了
   * `parentSessionId` 只列它的子会话，`includeChildren` 时普通会话与子会话都列。
   */
  list(options?: {
    workspaceId?: string;
    includeRemovedWorkspaces?: boolean;
    parentSessionId?: string;
    includeChildren?: boolean;
    /** 也列支线会话（0006）；默认不列。 */
    includeSide?: boolean;
    /** 归档（0009）：`only` 只列已归档的，`include` 都列；默认不列已归档的。 */
    archived?: 'only' | 'include';
  }): SessionRecord[];
  /** 归档或取消归档（`undefined`）；会话不存在时返回 false。 */
  setArchived(id: string, archivedAt: string | undefined): boolean;
  /** 更新缓存字段；会话不存在时返回 false。 */
  update(id: string, patch: SessionCachePatch): boolean;
  /** 状态不是 `closed` 的会话数（不含子会话）：有这样的会话时工作区不能移除（domain-model §3.1）。 */
  countOpenByWorkspace(workspaceId: string): number;
  /** 同上，Provider 被未关闭会话（不含子会话）引用时不能删除（domain-model §3.2）。 */
  countOpenByProvider(providerId: string): number;
}

// SessionCachePatch 字段 → 列名。update() 只拼接这里列出的列，不接受任意键。
const PATCH_COLUMNS = {
  modelId: 'model_id',
  reasoningEffort: 'reasoning_effort',
  permissionMode: 'permission_mode',
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
      permission_mode, environment_id, extra_roots, worktrees, origin, forked_from, side, parent_session_id,
      parent_tool_call_id,
      title, title_source, state, active_turn, last_error, last_seq, created_at, updated_at
    ) VALUES (
      :id, :workspaceId, :cwd, :engine, :engineSessionId, :providerId, :modelId, :reasoningEffort,
      :permissionMode, :environmentId, :extraRoots, :worktrees, :origin, :forkedFrom, :side, :parentSessionId,
      :parentToolCallId,
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
      AND CASE
        WHEN :parentSessionId IS NOT NULL THEN s.parent_session_id = :parentSessionId
        WHEN :includeChildren = 1 THEN 1
        ELSE s.parent_session_id IS NULL
      END
      AND (:includeSide = 1 OR s.side IS NULL)
      AND CASE :archived
        WHEN 'only' THEN s.archived_at IS NOT NULL
        WHEN 'include' THEN 1
        ELSE s.archived_at IS NULL
      END
    ORDER BY s.updated_at DESC, s.id DESC`);
  const setArchived = db.prepare('UPDATE sessions SET archived_at = ? WHERE id = ?');
  const countOpenByWorkspace = db.prepare(
    "SELECT COUNT(*) AS n FROM sessions WHERE workspace_id = ? AND state <> 'closed' AND parent_session_id IS NULL AND side IS NULL",
  );
  const countOpenByProvider = db.prepare(
    "SELECT COUNT(*) AS n FROM sessions WHERE provider_id = ? AND state <> 'closed' AND parent_session_id IS NULL AND side IS NULL",
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
        permissionMode: record.permissionMode ?? null,
        environmentId: record.environmentId ?? null,
        extraRoots: record.extraRoots ? JSON.stringify(record.extraRoots) : null,
        worktrees: record.worktrees ? JSON.stringify(record.worktrees) : null,
        origin: toNullableJson(record.origin),
        forkedFrom: toNullableJson(record.forkedFrom),
        side: record.side ? 1 : null,
        parentSessionId: record.parentSessionId ?? null,
        parentToolCallId: record.parentToolCallId ?? null,
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
          parentSessionId: options?.parentSessionId ?? null,
          includeChildren: options?.includeChildren ? 1 : 0,
          includeSide: options?.includeSide ? 1 : 0,
          archived: options?.archived ?? null,
        })
        .map(fromRow);
    },
    setArchived(id, archivedAt) {
      return changed(setArchived.run(archivedAt ?? null, id));
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
            : (value as string | number | null);
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
  const permissionMode = optionalText(row, 'permission_mode');
  if (permissionMode !== undefined) record.permissionMode = permissionMode;
  const environmentId = optionalText(row, 'environment_id');
  if (environmentId !== undefined) record.environmentId = environmentId;
  const extraRoots = optionalJson(row, 'extra_roots');
  if (extraRoots !== undefined) record.extraRoots = extraRoots as string[];
  const worktrees = optionalJson(row, 'worktrees');
  if (worktrees !== undefined)
    record.worktrees = worktrees as NonNullable<SessionRecord['worktrees']>;
  const forkedFrom = optionalJson(row, 'forked_from');
  if (forkedFrom !== undefined) {
    record.forkedFrom = forkedFrom as NonNullable<SessionRecord['forkedFrom']>;
  }
  if (row.side === 1) record.side = true;
  const origin = optionalJson(row, 'origin');
  if (origin !== undefined) record.origin = origin as NonNullable<SessionRecord['origin']>;
  const parentSessionId = optionalText(row, 'parent_session_id');
  if (parentSessionId !== undefined) record.parentSessionId = parentSessionId;
  const parentToolCallId = optionalText(row, 'parent_tool_call_id');
  if (parentToolCallId !== undefined) record.parentToolCallId = parentToolCallId;
  const activeTurn = optionalJson(row, 'active_turn');
  if (activeTurn !== undefined) record.activeTurn = activeTurn as ActiveTurnRecord;
  const lastError = optionalJson(row, 'last_error');
  if (lastError !== undefined) record.lastError = lastError as SessionErrorRecord;
  const archivedAt = optionalText(row, 'archived_at');
  if (archivedAt !== undefined) record.archivedAt = archivedAt;
  return record;
}
