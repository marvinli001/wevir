import type { SqliteDatabase, SqliteStatement, SqlParams, SqlRow } from './driver.js';
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
 * （domain-model §3.3）。0.25.0 起 `providerId` 与 `engineSessionId` 也是：接力（`session.handoff`）换成当前的那个，挂过的别的
 * 引擎会话只在事件里。
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
  /**
   * 会话是怎么来的（U23，0005_session_origin）：`suggested_task` 是从一项建议开出来的（提出建议的会话与建议的 ID）；`agent`（0.30.0）
   * 是另一个会话里的 agent 用应用级工具开出来的（`sessionId` 是那个会话，没有 `taskId`；用预设角色开的带 `role`，角色名）；`fork` 是从
   * 带角色的会话分出来的分支或支线（`sessionId` 是被分的会话，`role` 抄它的）；`automation`（0.66.0）是一次自动化运行开的
   * （自动化与运行的 ID）；`second_opinion`（0.75.0）是给另一个会话第二意见的会话（`sessionId` 是收到意见的会话、`opinionId` 是意见，
   * `role` 是审阅用的预设角色）。建会话后不变。
   */
  origin?:
    | {
        kind: 'suggested_task' | 'agent' | 'fork';
        sessionId: string;
        taskId?: string;
        role?: string;
        opinionId?: undefined;
      }
    | {
        kind: 'second_opinion';
        sessionId: string;
        opinionId: string;
        role?: string;
        taskId?: undefined;
      }
    | {
        kind: 'automation';
        automationId: string;
        runId: string;
        sessionId?: undefined;
        taskId?: undefined;
        role?: undefined;
        opinionId?: undefined;
      };
  /**
   * 工具预设（0010_tool_preset）：`id` 是 `full` 或 `core`，`groups` 是在 `core` 之上另加的组。省略表示没有选，等同 `full`。建会话后
   * 不变；只管 Host 的应用级工具。
   */
  toolPreset?: { id: string; groups?: string[] };
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
  /** 接力（0.25.0）后当前的 Provider 与引擎会话。 */
  providerId?: string;
  engineSessionId?: string;
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
  /**
   * 会话的“一家”（0.43.0，`session.delete`）：它自己、它的子会话（按 `parent_session_id` 一层层往下）与从它分出的支线（`forked_from`
   * 指向它的 `side` 会话），以及这些会话各自的子会话与支线。它自己在前，父会话在子会话之前。不存在时为空数组。
   */
  family(id: string): SessionRecord[];
  /**
   * 删掉这些会话的行与它们的事件、审批、发送回执（0.43.0）以及在它们里面写的行级批注（0.67.0）。要在调用方的事务里；`ids` 里的子会话要排在父会话之后（`family` 的顺序），
   * 按倒序删。返回删掉的会话数。
   */
  remove(ids: readonly string[]): number;
  /** 更新缓存字段；会话不存在时返回 false。 */
  update(id: string, patch: SessionCachePatch): boolean;
  /** 状态不是 `closed` 的会话数（不含子会话）：有这样的会话时工作区不能移除（domain-model §3.1）。 */
  countOpenByWorkspace(workspaceId: string): number;
  /** 同上，Provider 被未关闭会话（不含子会话）引用时不能删除（domain-model §3.2）。 */
  countOpenByProvider(providerId: string): number;
}

// SessionCachePatch 字段 → 列名。update() 只拼接这里列出的列，不接受任意键。
const PATCH_COLUMNS = {
  providerId: 'provider_id',
  engineSessionId: 'engine_session_id',
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
  // update() 的语句按列组合缓存：事件库每次提交都写一次缓存列，组合只有少数几种。
  const updates = new Map<string, SqliteStatement>();
  const insert = db.prepare(`
    INSERT INTO sessions (
      id, workspace_id, cwd, engine, engine_session_id, provider_id, model_id, reasoning_effort,
      permission_mode, environment_id, extra_roots, worktrees, origin, tool_preset, forked_from, side,
      parent_session_id, parent_tool_call_id,
      title, title_source, state, active_turn, last_error, last_seq, created_at, updated_at
    ) VALUES (
      :id, :workspaceId, :cwd, :engine, :engineSessionId, :providerId, :modelId, :reasoningEffort,
      :permissionMode, :environmentId, :extraRoots, :worktrees, :origin, :toolPreset, :forkedFrom, :side,
      :parentSessionId, :parentToolCallId,
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

  const descendants = db.prepare(`
    SELECT * FROM sessions
    WHERE parent_session_id = :id
      OR (side = 1 AND json_valid(forked_from) AND json_extract(forked_from, '$.sessionId') = :id)
    ORDER BY created_at, id`);
  const removeEvents = db.prepare('DELETE FROM events WHERE session_id = ?');
  const removeApprovals = db.prepare('DELETE FROM approvals WHERE session_id = ?');
  const removeReceipts = db.prepare('DELETE FROM send_receipts WHERE session_id = ?');
  const removeReviewComments = db.prepare('DELETE FROM review_comments WHERE session_id = ?');
  const removeSession = db.prepare('DELETE FROM sessions WHERE id = ?');

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
        toolPreset: toNullableJson(record.toolPreset),
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
    family(id) {
      const root = get.get(id);
      if (!root) return [];
      const records = [fromRow(root)];
      const seen = new Set([id]);
      for (let index = 0; index < records.length; index += 1) {
        for (const row of descendants.all({ id: (records[index] as SessionRecord).id })) {
          const record = fromRow(row);
          if (seen.has(record.id)) continue;
          seen.add(record.id);
          records.push(record);
        }
      }
      return records;
    },
    remove(ids) {
      let removed = 0;
      for (const id of [...ids].reverse()) {
        removeEvents.run(id);
        removeApprovals.run(id);
        removeReceipts.run(id);
        removeReviewComments.run(id);
        removed += removeSession.run(id).changes > 0 ? 1 : 0;
      }
      return removed;
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
      const columns = sets.join(', ');
      let statement = updates.get(columns);
      if (statement === undefined) {
        statement = db.prepare(`UPDATE sessions SET ${columns} WHERE id = :id`);
        updates.set(columns, statement);
      }
      return changed(statement.run(params));
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
  const toolPreset = optionalJson(row, 'tool_preset');
  if (toolPreset !== undefined) {
    record.toolPreset = toolPreset as NonNullable<SessionRecord['toolPreset']>;
  }
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
