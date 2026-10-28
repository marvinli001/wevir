import type { SqliteDatabase, SqlRow } from './driver.js';
import {
  changed,
  integer,
  json,
  optionalJson,
  optionalText,
  orNull,
  text,
  toJson,
  toNullableJson,
} from './rows.js';

/** `channels` 表的一行（0026_channels，协议 0.120.0）。JSON 列的形状由 Host 按协议校验，这里不解释。 */
export interface ChannelRecord {
  id: string;
  /** `project` / `assistant` / `group`。 */
  kind: string;
  /** 群没有工作区，存空串。 */
  workspaceId: string;
  title: string;
  /** 助理的身份与规矩；项目频道没有。 */
  assistant?: unknown;
  /** 群的成员（0027_channel_groups）；别的频道没有。 */
  group?: unknown;
  /** 群是 null。 */
  coordinator: unknown;
  budget: unknown;
  pausedAt?: string;
  /** `user` / `budget`。 */
  pauseReason?: string;
  lastPostSeq: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

/** `channel_posts` 表的一行。 */
export interface ChannelPostRecord {
  channelId: string;
  seq: number;
  id: string;
  author: unknown;
  content: unknown;
  replyTo?: string;
  routedTo?: string[];
  card?: unknown;
  files?: unknown;
  clientPostId?: string;
  /** Host 自用的附加信息（0027_channel_groups）：发给谁、@ 了谁、来回层数、回答送回哪里。 */
  meta?: unknown;
  createdAt: string;
}

/** `channel_threads` 表的一行：线程会话的频道附加部分。 */
export interface ChannelThreadRecord {
  sessionId: string;
  channelId: string;
  rootPostId: string;
  /** `coordinator` / `user`。 */
  openedBy: string;
  resolvedAt?: string;
  /** `user` / `coordinator` / `thread`。 */
  resolvedBy?: string;
  createdAt: string;
}

export interface ChannelUsageRecord {
  day: string;
  wakes: number;
  tokens: number;
}

export interface ChannelRepository {
  insert(record: Omit<ChannelRecord, 'lastPostSeq' | 'deletedAt'>): void;
  /** 已软删的也返回（`deletedAt`）。 */
  get(id: string): ChannelRecord | undefined;
  /** 没删的频道，按建的先后。 */
  list(): ChannelRecord[];
  /** 改名称、身份、协调者、预算与暂停；没有这条时返回 false。 */
  update(
    id: string,
    patch: Partial<
      Pick<ChannelRecord, 'title' | 'assistant' | 'group' | 'coordinator' | 'budget'>
    > & {
      pausedAt?: string | null;
      pauseReason?: string | null;
      updatedAt: string;
    },
  ): boolean;
  softDelete(id: string, deletedAt: string): boolean;
  /**
   * 追加一条帖子：`seq` 取频道的 `last_post_seq + 1`，同一事务里加一；返回带 `seq` 的记录。同一个 `clientPostId` 已有时返回那条，
   * `created: false`。
   */
  appendPost(post: Omit<ChannelPostRecord, 'seq'>): { post: ChannelPostRecord; created: boolean };
  getPost(id: string): ChannelPostRecord | undefined;
  /** 按 `seq` 升序：`afterSeq` 之后的前 `limit` 条，或 `beforeSeq` 之前（不给时是最新）的最后 `limit` 条。 */
  posts(
    channelId: string,
    options: { beforeSeq?: number; afterSeq?: number; limit: number },
  ): ChannelPostRecord[];
  setRoutedTo(id: string, routedTo: string[]): boolean;
  setCard(id: string, card: unknown): boolean;
  insertThread(record: ChannelThreadRecord): void;
  getThread(sessionId: string): ChannelThreadRecord | undefined;
  /** 这个频道的线程，新的在前。 */
  threads(channelId: string): ChannelThreadRecord[];
  resolveThread(
    sessionId: string,
    resolution: { resolvedAt: string; resolvedBy: string } | null,
  ): boolean;
  /** 读者看到了 `seq` 为止；只往前走。 */
  markRead(channelId: string, reader: string, seq: number): void;
  /** 各读者里看到的最大 `seq`；没人读过时 0。 */
  seenSeq(channelId: string): number;
  /** `seq` 大于 `afterSeq` 的、作者不是用户的帖子数。 */
  countUnread(channelId: string, afterSeq: number): number;
  usage(channelId: string, day: string): ChannelUsageRecord | undefined;
  /** 当天的唤醒加 `wakes`、token 加 `tokens`。 */
  addUsage(channelId: string, day: string, add: { wakes?: number; tokens?: number }): void;
}

function toChannel(row: SqlRow): ChannelRecord {
  const record: ChannelRecord = {
    id: text(row, 'id'),
    kind: text(row, 'kind'),
    workspaceId: text(row, 'workspace_id'),
    title: text(row, 'title'),
    coordinator: json(row, 'coordinator'),
    budget: json(row, 'budget'),
    lastPostSeq: integer(row, 'last_post_seq'),
    createdAt: text(row, 'created_at'),
    updatedAt: text(row, 'updated_at'),
  };
  const assistant = optionalJson(row, 'assistant');
  if (assistant !== undefined) record.assistant = assistant;
  const group = optionalJson(row, 'group_info');
  if (group !== undefined) record.group = group;
  const pausedAt = optionalText(row, 'paused_at');
  if (pausedAt !== undefined) record.pausedAt = pausedAt;
  const pauseReason = optionalText(row, 'pause_reason');
  if (pauseReason !== undefined) record.pauseReason = pauseReason;
  const deletedAt = optionalText(row, 'deleted_at');
  if (deletedAt !== undefined) record.deletedAt = deletedAt;
  return record;
}

function toPost(row: SqlRow): ChannelPostRecord {
  const record: ChannelPostRecord = {
    channelId: text(row, 'channel_id'),
    seq: integer(row, 'seq'),
    id: text(row, 'id'),
    author: json(row, 'author'),
    content: json(row, 'content'),
    createdAt: text(row, 'created_at'),
  };
  const replyTo = optionalText(row, 'reply_to');
  if (replyTo !== undefined) record.replyTo = replyTo;
  const routedTo = optionalJson(row, 'routed_to');
  if (routedTo !== undefined) record.routedTo = routedTo as string[];
  const card = optionalJson(row, 'card');
  if (card !== undefined) record.card = card;
  const files = optionalJson(row, 'files');
  if (files !== undefined) record.files = files;
  const clientPostId = optionalText(row, 'client_post_id');
  if (clientPostId !== undefined) record.clientPostId = clientPostId;
  const meta = optionalJson(row, 'meta');
  if (meta !== undefined) record.meta = meta;
  return record;
}

function toThread(row: SqlRow): ChannelThreadRecord {
  const record: ChannelThreadRecord = {
    sessionId: text(row, 'session_id'),
    channelId: text(row, 'channel_id'),
    rootPostId: text(row, 'root_post_id'),
    openedBy: text(row, 'opened_by'),
    createdAt: text(row, 'created_at'),
  };
  const resolvedAt = optionalText(row, 'resolved_at');
  if (resolvedAt !== undefined) record.resolvedAt = resolvedAt;
  const resolvedBy = optionalText(row, 'resolved_by');
  if (resolvedBy !== undefined) record.resolvedBy = resolvedBy;
  return record;
}

export function createChannelRepository(db: SqliteDatabase): ChannelRepository {
  const insert = db.prepare(`
    INSERT INTO channels (
      id, kind, workspace_id, title, assistant, group_info, coordinator, budget, paused_at, pause_reason, created_at,
      updated_at
    ) VALUES (
      :id, :kind, :workspaceId, :title, :assistant, :group, :coordinator, :budget, :pausedAt, :pauseReason, :createdAt,
      :updatedAt
    )`);
  const get = db.prepare('SELECT * FROM channels WHERE id = ?');
  const list = db.prepare(
    'SELECT * FROM channels WHERE deleted_at IS NULL ORDER BY created_at, rowid',
  );
  const softDelete = db.prepare(
    'UPDATE channels SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL',
  );
  const bumpSeq = db.prepare(
    'UPDATE channels SET last_post_seq = last_post_seq + 1 WHERE id = ? RETURNING last_post_seq',
  );
  const insertPost = db.prepare(`
    INSERT INTO channel_posts (
      channel_id, seq, id, author, content, reply_to, routed_to, card, files, client_post_id, meta, created_at
    ) VALUES (
      :channelId, :seq, :id, :author, :content, :replyTo, :routedTo, :card, :files, :clientPostId, :meta, :createdAt
    )`);
  const byClient = db.prepare(
    'SELECT * FROM channel_posts WHERE channel_id = ? AND client_post_id = ?',
  );
  const getPost = db.prepare('SELECT * FROM channel_posts WHERE id = ?');
  const after = db.prepare(
    'SELECT * FROM channel_posts WHERE channel_id = ? AND seq > ? ORDER BY seq LIMIT ?',
  );
  const before = db.prepare(
    'SELECT * FROM channel_posts WHERE channel_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?',
  );
  const setRoutedTo = db.prepare('UPDATE channel_posts SET routed_to = ? WHERE id = ?');
  const setCard = db.prepare('UPDATE channel_posts SET card = ? WHERE id = ?');
  const insertThread = db.prepare(`
    INSERT INTO channel_threads (
      session_id, channel_id, root_post_id, opened_by, resolved_at, resolved_by, created_at
    ) VALUES (:sessionId, :channelId, :rootPostId, :openedBy, :resolvedAt, :resolvedBy, :createdAt)`);
  const getThread = db.prepare('SELECT * FROM channel_threads WHERE session_id = ?');
  const threads = db.prepare(
    'SELECT * FROM channel_threads WHERE channel_id = ? ORDER BY created_at DESC, rowid DESC',
  );
  const resolveThread = db.prepare(
    'UPDATE channel_threads SET resolved_at = ?, resolved_by = ? WHERE session_id = ?',
  );
  const markRead = db.prepare(`
    INSERT INTO channel_reads (channel_id, reader, seen_seq) VALUES (?, ?, ?)
    ON CONFLICT (channel_id, reader) DO UPDATE SET seen_seq = max(seen_seq, excluded.seen_seq)`);
  const seenSeq = db.prepare(
    'SELECT coalesce(max(seen_seq), 0) AS seen FROM channel_reads WHERE channel_id = ?',
  );
  const countUnread = db.prepare(`
    SELECT count(*) AS n FROM channel_posts
    WHERE channel_id = ? AND seq > ? AND json_extract(author, '$.kind') <> 'user'`);
  const usage = db.prepare('SELECT * FROM channel_usage WHERE channel_id = ? AND day = ?');
  const addUsage = db.prepare(`
    INSERT INTO channel_usage (channel_id, day, wakes, tokens) VALUES (:channelId, :day, :wakes, :tokens)
    ON CONFLICT (channel_id, day) DO UPDATE SET wakes = wakes + excluded.wakes, tokens = tokens + excluded.tokens`);

  return {
    insert(record) {
      insert.run({
        id: record.id,
        kind: record.kind,
        workspaceId: record.workspaceId,
        title: record.title,
        assistant: toNullableJson(record.assistant),
        group: toNullableJson(record.group),
        coordinator: toJson(record.coordinator),
        budget: toJson(record.budget),
        pausedAt: orNull(record.pausedAt),
        pauseReason: orNull(record.pauseReason),
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      });
    },
    get(id) {
      const row = get.get(id);
      return row === undefined ? undefined : toChannel(row);
    },
    list: () => list.all().map(toChannel),
    update(id, patch) {
      const sets: string[] = ['updated_at = :updatedAt'];
      const values: Record<string, string | null> = { id, updatedAt: patch.updatedAt };
      if (patch.title !== undefined) {
        sets.push('title = :title');
        values.title = patch.title;
      }
      if (patch.assistant !== undefined) {
        sets.push('assistant = :assistant');
        values.assistant = toJson(patch.assistant);
      }
      if (patch.group !== undefined) {
        sets.push('group_info = :group');
        values.group = toJson(patch.group);
      }
      if (patch.coordinator !== undefined) {
        sets.push('coordinator = :coordinator');
        values.coordinator = toJson(patch.coordinator);
      }
      if (patch.budget !== undefined) {
        sets.push('budget = :budget');
        values.budget = toJson(patch.budget);
      }
      if (patch.pausedAt !== undefined) {
        sets.push('paused_at = :pausedAt');
        values.pausedAt = patch.pausedAt;
      }
      if (patch.pauseReason !== undefined) {
        sets.push('pause_reason = :pauseReason');
        values.pauseReason = patch.pauseReason;
      }
      return changed(
        db.prepare(`UPDATE channels SET ${sets.join(', ')} WHERE id = :id`).run(values),
      );
    },
    softDelete: (id, deletedAt) => changed(softDelete.run(deletedAt, deletedAt, id)),
    appendPost(post) {
      db.exec('SAVEPOINT channel_post');
      try {
        if (post.clientPostId !== undefined) {
          const existing = byClient.get(post.channelId, post.clientPostId);
          if (existing !== undefined) {
            db.exec('RELEASE channel_post');
            return { post: toPost(existing), created: false };
          }
        }
        const bumped = bumpSeq.get(post.channelId);
        if (bumped === undefined) throw new Error(`channel ${post.channelId} not found`);
        const seq = integer(bumped, 'last_post_seq');
        insertPost.run({
          channelId: post.channelId,
          seq,
          id: post.id,
          author: toJson(post.author),
          content: toJson(post.content),
          replyTo: orNull(post.replyTo),
          routedTo: toNullableJson(post.routedTo),
          card: toNullableJson(post.card),
          files: toNullableJson(post.files),
          clientPostId: orNull(post.clientPostId),
          meta: toNullableJson(post.meta),
          createdAt: post.createdAt,
        });
        db.exec('RELEASE channel_post');
        return { post: { ...post, seq }, created: true };
      } catch (error) {
        db.exec('ROLLBACK TO channel_post');
        db.exec('RELEASE channel_post');
        throw error;
      }
    },
    getPost(id) {
      const row = getPost.get(id);
      return row === undefined ? undefined : toPost(row);
    },
    posts(channelId, { beforeSeq, afterSeq, limit }) {
      if (afterSeq !== undefined) return after.all(channelId, afterSeq, limit).map(toPost);
      return before
        .all(channelId, beforeSeq ?? Number.MAX_SAFE_INTEGER, limit)
        .map(toPost)
        .reverse();
    },
    setRoutedTo: (id, routedTo) => changed(setRoutedTo.run(toJson(routedTo), id)),
    setCard: (id, card) => changed(setCard.run(toJson(card), id)),
    insertThread(record) {
      insertThread.run({
        sessionId: record.sessionId,
        channelId: record.channelId,
        rootPostId: record.rootPostId,
        openedBy: record.openedBy,
        resolvedAt: orNull(record.resolvedAt),
        resolvedBy: orNull(record.resolvedBy),
        createdAt: record.createdAt,
      });
    },
    getThread(sessionId) {
      const row = getThread.get(sessionId);
      return row === undefined ? undefined : toThread(row);
    },
    threads: (channelId) => threads.all(channelId).map(toThread),
    resolveThread: (sessionId, resolution) =>
      changed(
        resolveThread.run(
          resolution?.resolvedAt ?? null,
          resolution?.resolvedBy ?? null,
          sessionId,
        ),
      ),
    markRead(channelId, reader, seq) {
      markRead.run(channelId, reader, seq);
    },
    seenSeq: (channelId) => integer(seenSeq.get(channelId) ?? { seen: 0 }, 'seen'),
    countUnread: (channelId, afterSeq) =>
      integer(countUnread.get(channelId, afterSeq) ?? { n: 0 }, 'n'),
    usage(channelId, day) {
      const row = usage.get(channelId, day);
      return row === undefined
        ? undefined
        : { day: text(row, 'day'), wakes: integer(row, 'wakes'), tokens: integer(row, 'tokens') };
    },
    addUsage(channelId, day, add) {
      addUsage.run({ channelId, day, wakes: add.wakes ?? 0, tokens: add.tokens ?? 0 });
    },
  };
}
