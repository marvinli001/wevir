import type { SqliteDatabase, SqliteStatement, SqlParams, SqlRow, SqlValue } from './driver.js';
import { integer, optionalText, text } from './rows.js';

// 会话全文搜索的索引（协议 0.77.0）：从事件派生，可以整体删掉重建。
//
// - **不存正文。** FTS5 是无内容表（`content=''`），只存 trigram 倒排；`search_docs` 只记一条索引对应哪个事件（会话、seq、回合、
//   种类、时间）与它现在看不看得见。正文、片段与高亮都在查询时从 `events` 里那条事件重新取，事件库仍是唯一事实来源。
// - **不走迁移。** 这几张表是派生数据，Host 打开库时按 `SEARCH_INDEX_VERSION` 建好；版本不同（取文规则改了）或索引坏了就删表重建，
//   不占迁移号，也不会因为索引出错挡住 Host 启动。
// - **删会话一起删。** `search_docs` 与 `search_progress` 对 `sessions` 是 ON DELETE CASCADE，`search_docs` 的删除触发器再删掉
//   FTS 里同一行，与 `sessions.remove` 在同一个事务里。
// - **可见性与会话列表一致。** 撤销的回合隐藏、撤回的回合删掉；已移除工作区的会话与支线不出现；已归档的默认不出现。
// - **没有 FTS5 时降级。** 运行时的 SQLite 没编进 FTS5 或 trigram（Node 24.15 / 26 与 Electron 44 都有，见 ADR-0003 补记）就只建
//   `search_docs`，查询全部走有上限的扫描（`scan`），调用方要标明是回退结果。

/** 取文规则或表结构改了就加一，旧索引在下次打开时整体重建。 */
export const SEARCH_INDEX_VERSION = 1;

/** trigram：子串匹配，中英文都行；不区分大小写、去掉变音符号。查询词不足 3 个字符时 FTS 匹配不到，要走扫描。 */
const FTS_DDL = `CREATE VIRTUAL TABLE search_fts USING fts5(
  body, content = '', contentless_delete = 1, tokenize = 'trigram remove_diacritics 1')`;

const TABLES_DDL = `
CREATE TABLE IF NOT EXISTS search_meta (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS search_progress (
  session_id   TEXT PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
  indexed_seq  INTEGER NOT NULL,
  provider_id  TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS search_docs (
  id           INTEGER PRIMARY KEY,
  session_id   TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  turn_id      TEXT,
  kind         TEXT NOT NULL,
  provider_id  TEXT,
  ts           TEXT NOT NULL,
  hidden       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (session_id, seq)
) STRICT;
CREATE INDEX IF NOT EXISTS search_docs_by_turn ON search_docs (session_id, turn_id);
CREATE INDEX IF NOT EXISTS search_docs_by_ts ON search_docs (ts, id);`;

const DROP_DDL = `
DROP TRIGGER IF EXISTS search_docs_delete;
DROP TABLE IF EXISTS search_fts;
DROP TABLE IF EXISTS search_docs;
DROP TABLE IF EXISTS search_progress;
DROP TABLE IF EXISTS search_meta;`;

/** 一条索引：一个事件。 */
export interface SearchDocRecord {
  sessionId: string;
  seq: number;
  turnId?: string;
  /** `user_message`、`assistant_message`、`command`、`file_change`。 */
  kind: string;
  /** 写这个事件时会话用的 Provider（接力之后换成新的）。 */
  providerId?: string;
  ts: string;
}

/** 索引对哪些会话还没追上：`indexedSeq` 之后到 `lastSeq` 的事件还没看过。 */
export interface SearchLag {
  sessionId: string;
  indexedSeq: number;
  lastSeq: number;
  providerId?: string;
}

/** 只看这些种类的事件（其余事件只推进水位）。 */
export interface SearchSourceEvent {
  seq: number;
  ts: string;
  type: string;
  payload: unknown;
}

/** 查询的范围：先按它过滤，再排序与分页。列表为空数组时什么都不匹配。 */
export interface SearchFilter {
  workspaceIds?: readonly string[];
  sessionIds?: readonly string[];
  kinds?: readonly string[];
  providerIds?: readonly string[];
  /** ISO 时间，含两端。 */
  since?: string;
  until?: string;
  /** 默认不含已归档的会话（与会话列表一样）；子会话看它的父会话。支线一律不含。 */
  includeArchived?: boolean;
}

export interface SearchHitRecord {
  docId: number;
  sessionId: string;
  workspaceId: string;
  sessionTitle: string;
  parentSessionId?: string;
  archived: boolean;
  seq: number;
  turnId?: string;
  kind: string;
  providerId?: string;
  ts: string;
}

export interface SearchRepository {
  /** 这个 SQLite 有没有 FTS5 trigram；没有时 `match` 不能用，只能 `scan`。 */
  readonly fts: boolean;
  /** 建表（必要时整体重建）。`openStorage` 调一次；`rebuild` 也走它。 */
  ensure(): void;
  /** 删掉全部索引与水位，按当前版本重建空表。 */
  reset(): void;
  /** 水位落后的会话，最近更新的在前。 */
  lagging(limit?: number): SearchLag[];
  /** 还没索引的会话数与事件数。 */
  pending(): { sessions: number; events: number };
  /** 已索引的条数。 */
  docCount(): number;
  /** `(afterSeq, throughSeq]` 里这些类型的事件，按 seq 升序（payload 已解析）。 */
  sourceEvents(
    sessionId: string,
    afterSeq: number,
    throughSeq: number,
    types: readonly string[],
  ): SearchSourceEvent[];
  /** 加一条索引；同一事件已有时什么都不做。`body` 只进 FTS 倒排，不存。 */
  insert(doc: SearchDocRecord, body: string): void;
  /** 回合撤销 / 重做（0.51.0）：这个回合的索引看不看得见。 */
  setTurnHidden(sessionId: string, turnId: string, hidden: boolean): void;
  /** 回合撤回（0.38.0）：删掉这个回合的索引。 */
  removeTurn(sessionId: string, turnId: string): void;
  setProgress(sessionId: string, indexedSeq: number, providerId: string | undefined): void;
  /** FTS 查询（`match` 是 FTS5 的查询串），范围过滤之后按相关度或时间排序。 */
  match(
    match: string,
    filter: SearchFilter,
    options: { sort: 'relevance' | 'recent'; limit: number; offset: number },
  ): SearchHitRecord[];
  /**
   * 回退扫描：范围内最新的 `limit` 条索引，再用 `likes`（每个都要包含，`%` `_` `\` 已转义）筛事件 payload，按时间从新到旧。
   * `examined` 是范围内实际看了多少条（不超过 `limit`）。
   */
  scan(
    filter: SearchFilter,
    likes: readonly string[],
    limit: number,
  ): { examined: number; hits: Array<SearchHitRecord & { payload: unknown }> };
  /** 一条事件的 payload（片段与高亮从它重新取文）；不存在时 `undefined`。 */
  payload(sessionId: string, seq: number): unknown;
}

export function createSearchRepository(db: SqliteDatabase): SearchRepository {
  let fts = false;
  // 语句按 SQL 缓存；删表重建之后旧语句作废，`ensure` 清掉缓存。
  const statements = new Map<string, SqliteStatement>();
  const st = (sql: string): SqliteStatement => {
    let statement = statements.get(sql);
    if (statement === undefined) {
      statement = db.prepare(sql);
      statements.set(sql, statement);
    }
    return statement;
  };

  const ensure = () => {
    statements.clear();
    db.exec(TABLES_DDL);
    const version = db.prepare("SELECT value FROM search_meta WHERE key = 'version'").get();
    if (version !== undefined && Number(version.value) !== SEARCH_INDEX_VERSION) {
      db.exec(DROP_DDL);
      db.exec(TABLES_DDL);
    }
    fts = createFts(db);
    // 上次用的 SQLite 有 FTS5、这次没有（或反过来）：已有的索引与 FTS 对不上，水位清零重建。
    const mode = fts ? 'fts' : 'scan';
    const previous = db.prepare("SELECT value FROM search_meta WHERE key = 'mode'").get();
    if (previous !== undefined && previous.value !== mode) {
      db.exec('DELETE FROM search_docs; DELETE FROM search_progress;');
      if (fts) db.exec("INSERT INTO search_fts (search_fts) VALUES ('delete-all')");
    }
    const upsert = db.prepare(
      'INSERT INTO search_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    );
    upsert.run('version', String(SEARCH_INDEX_VERSION));
    upsert.run('mode', mode);
  };
  try {
    ensure();
  } catch {
    // 索引表坏了：派生数据，删掉重建，不挡住打开库。
    db.exec(DROP_DDL);
    ensure();
  }

  const lagging = `
    SELECT s.id AS session_id, s.last_seq, COALESCE(p.indexed_seq, 0) AS indexed_seq, p.provider_id
    FROM sessions s LEFT JOIN search_progress p ON p.session_id = s.id
    WHERE s.last_seq > COALESCE(p.indexed_seq, 0)
    ORDER BY s.updated_at DESC, s.id DESC LIMIT ?`;

  return {
    get fts() {
      return fts;
    },
    ensure,
    reset() {
      db.exec(DROP_DDL);
      ensure();
    },
    lagging(limit = -1) {
      return st(lagging)
        .all(limit)
        .map((row) => ({
          sessionId: text(row, 'session_id'),
          indexedSeq: integer(row, 'indexed_seq'),
          lastSeq: integer(row, 'last_seq'),
          ...optional('providerId', optionalText(row, 'provider_id')),
        }));
    },
    pending() {
      const row = st(`
          SELECT COUNT(*) AS sessions, COALESCE(SUM(s.last_seq - COALESCE(p.indexed_seq, 0)), 0) AS events
          FROM sessions s LEFT JOIN search_progress p ON p.session_id = s.id
          WHERE s.last_seq > COALESCE(p.indexed_seq, 0)`).get() as SqlRow;
      return { sessions: integer(row, 'sessions'), events: integer(row, 'events') };
    },
    docCount() {
      return integer(st('SELECT COUNT(*) AS n FROM search_docs').get() as SqlRow, 'n');
    },
    sourceEvents(sessionId, afterSeq, throughSeq, types) {
      return st(`
          SELECT seq, ts, type, payload FROM events
          WHERE session_id = ? AND seq > ? AND seq <= ? AND type IN (SELECT value FROM json_each(?))
          ORDER BY seq`)
        .all(sessionId, afterSeq, throughSeq, JSON.stringify(types))
        .map((row) => ({
          seq: integer(row, 'seq'),
          ts: text(row, 'ts'),
          type: text(row, 'type'),
          payload: JSON.parse(text(row, 'payload')),
        }));
    },
    insert(doc, body) {
      const result = st(`
          INSERT INTO search_docs (session_id, seq, turn_id, kind, provider_id, ts)
          VALUES (:sessionId, :seq, :turnId, :kind, :providerId, :ts)
          ON CONFLICT (session_id, seq) DO NOTHING`).run({
        sessionId: doc.sessionId,
        seq: doc.seq,
        turnId: doc.turnId ?? null,
        kind: doc.kind,
        providerId: doc.providerId ?? null,
        ts: doc.ts,
      });
      if (Number(result.changes) === 0 || !fts) return;
      st('INSERT INTO search_fts (rowid, body) VALUES (?, ?)').run(result.lastInsertRowid, body);
    },
    setTurnHidden(sessionId, turnId, hidden) {
      st('UPDATE search_docs SET hidden = ? WHERE session_id = ? AND turn_id = ?').run(
        hidden ? 1 : 0,
        sessionId,
        turnId,
      );
    },
    removeTurn(sessionId, turnId) {
      st('DELETE FROM search_docs WHERE session_id = ? AND turn_id = ?').run(sessionId, turnId);
    },
    setProgress(sessionId, indexedSeq, providerId) {
      st(`
        INSERT INTO search_progress (session_id, indexed_seq, provider_id) VALUES (?, ?, ?)
        ON CONFLICT (session_id) DO UPDATE SET indexed_seq = excluded.indexed_seq, provider_id = excluded.provider_id`).run(
        sessionId,
        indexedSeq,
        providerId ?? null,
      );
    },
    match(match, filter, options) {
      if (!fts) throw new Error('FTS5 不可用');
      const where = filterSql(filter);
      const order =
        options.sort === 'recent' ? 'd.ts DESC, d.id DESC' : 'rank, d.ts DESC, d.id DESC';
      return st(`
          SELECT ${HIT_COLUMNS}, bm25(search_fts) AS rank
          FROM search_fts JOIN search_docs d ON d.id = search_fts.rowid ${HIT_JOINS}
          WHERE search_fts MATCH :match AND ${where.sql}
          ORDER BY ${order} LIMIT :limit OFFSET :offset`)
        .all({ ...where.params, match, limit: options.limit, offset: options.offset })
        .map(hitFromRow);
    },
    scan(filter, likes, limit) {
      const where = filterSql(filter);
      const recent = `
        SELECT ${HIT_COLUMNS} FROM search_docs d ${HIT_JOINS}
        WHERE ${where.sql} ORDER BY d.ts DESC, d.id DESC LIMIT :limit`;
      const params = { ...where.params, limit };
      const examined = integer(
        st(`SELECT COUNT(*) AS n FROM (${recent})`).get(params) as SqlRow,
        'n',
      );
      const likeParams: SqlParams = {};
      const conditions = likes.map((like, index) => {
        likeParams[`like${index}`] = like;
        return `e.payload LIKE :like${index} ESCAPE '\\'`;
      });
      const hits = st(`
          WITH recent AS (${recent})
          SELECT r.*, e.payload FROM recent r
          JOIN events e ON e.session_id = r.session_id AND e.seq = r.seq
          ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
          ORDER BY r.ts DESC, r.doc_id DESC`)
        .all({ ...params, ...likeParams })
        .map((row) => ({ ...hitFromRow(row), payload: JSON.parse(text(row, 'payload')) }));
      return { examined, hits };
    },
    payload(sessionId, seq) {
      const row = st('SELECT payload FROM events WHERE session_id = ? AND seq = ?').get(
        sessionId,
        seq,
      );
      return row === undefined ? undefined : JSON.parse(text(row, 'payload'));
    },
  };
}

/** 建 FTS5 表与删除触发器；这个 SQLite 不支持时返回 false，并去掉可能留下的触发器（不然删会话会失败）。 */
function createFts(db: SqliteDatabase): boolean {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'search_fts'")
    .get();
  try {
    if (!exists) db.exec(FTS_DDL);
    // 有表但模块不可用时，读一下就会报错。
    db.prepare('SELECT COUNT(*) FROM search_fts WHERE rowid = 0').get();
    db.exec(`CREATE TRIGGER IF NOT EXISTS search_docs_delete AFTER DELETE ON search_docs BEGIN
      DELETE FROM search_fts WHERE rowid = old.id;
    END`);
    return true;
  } catch {
    db.exec('DROP TRIGGER IF EXISTS search_docs_delete');
    return false;
  }
}

const HIT_COLUMNS = `
  d.id AS doc_id, d.session_id, d.seq, d.turn_id, d.kind, d.provider_id, d.ts,
  s.workspace_id, s.title, s.parent_session_id,
  (s.archived_at IS NOT NULL OR up.archived_at IS NOT NULL) AS archived`;

// 子会话（0002）没有自己的归档：看它的父会话。
const HIT_JOINS = `
  JOIN sessions s ON s.id = d.session_id
  JOIN workspaces w ON w.id = s.workspace_id
  LEFT JOIN sessions up ON up.id = s.parent_session_id`;

function filterSql(filter: SearchFilter): { sql: string; params: SqlParams } {
  const params: SqlParams = {};
  // 支线（0006）与会话列表一样不列：它只活在父会话的窗格里，关掉就关闭。
  const parts = ['d.hidden = 0', 'w.removed_at IS NULL', 's.side IS NULL'];
  const list = (name: string, column: string, values: readonly string[] | undefined) => {
    if (values === undefined) return;
    params[name] = JSON.stringify(values);
    parts.push(`${column} IN (SELECT value FROM json_each(:${name}))`);
  };
  list('workspaceIds', 's.workspace_id', filter.workspaceIds);
  list('sessionIds', 'd.session_id', filter.sessionIds);
  list('kinds', 'd.kind', filter.kinds);
  list('providerIds', 'd.provider_id', filter.providerIds);
  if (filter.since !== undefined) {
    params.since = filter.since;
    parts.push('d.ts >= :since');
  }
  if (filter.until !== undefined) {
    params.until = filter.until;
    parts.push('d.ts <= :until');
  }
  if (filter.includeArchived !== true) {
    parts.push('s.archived_at IS NULL AND up.archived_at IS NULL');
  }
  return { sql: parts.join(' AND '), params };
}

function hitFromRow(row: SqlRow): SearchHitRecord {
  return {
    docId: integer(row, 'doc_id'),
    sessionId: text(row, 'session_id'),
    workspaceId: text(row, 'workspace_id'),
    sessionTitle: text(row, 'title'),
    ...optional('parentSessionId', optionalText(row, 'parent_session_id')),
    archived: truthy(row.archived),
    seq: integer(row, 'seq'),
    ...optional('turnId', optionalText(row, 'turn_id')),
    kind: text(row, 'kind'),
    ...optional('providerId', optionalText(row, 'provider_id')),
    ts: text(row, 'ts'),
  };
}

function truthy(value: SqlValue | undefined): boolean {
  return value === 1 || value === 1n;
}

function optional<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: string };
}
