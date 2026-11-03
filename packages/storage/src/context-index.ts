import type { SqliteDatabase, SqlRow, SqlValue } from './driver.js';

export const CONTEXT_INDEX_VERSION = 1;
export const CONTEXT_SCAN_LIMIT = 5000;
export interface ContextDocRecord {
  ref: string;
  kind: 'memory' | 'episode';
  workspaceId?: string;
  title: string;
  body: string;
  updatedAt: string;
  revision: string;
  state: 'active' | 'disabled' | 'invalid' | 'excluded';
  paths: string[];
}
export interface ContextIndexRepository {
  readonly fts: boolean;
  reset(): void;
  removeRef(ref: string): void;
  sync(workspaceId: string | undefined, docs: readonly ContextDocRecord[]): void;
  query(options: {
    workspaceIds: string[];
    kinds: string[];
    includeInvalid: boolean;
    path?: string;
    terms: readonly { text: string; indexable: boolean }[];
  }): {
    docs: Array<ContextDocRecord & { score: number }>;
    scan?: { reason: 'short_term' | 'fts_unavailable'; examined: number; limit: number };
  };
}

const DDL = `
CREATE TABLE IF NOT EXISTS context_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS context_docs (
  id INTEGER PRIMARY KEY, ref TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, workspace_id TEXT,
  title TEXT NOT NULL, body TEXT NOT NULL, updated_at TEXT NOT NULL, revision TEXT NOT NULL, state TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS context_docs_by_ws ON context_docs(workspace_id, kind, updated_at);
CREATE TABLE IF NOT EXISTS context_paths (
  doc_id INTEGER NOT NULL REFERENCES context_docs(id) ON DELETE CASCADE,
  path TEXT NOT NULL, PRIMARY KEY(doc_id, path)
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS context_paths_by_path ON context_paths(path);`;
const DROP = `DROP TRIGGER IF EXISTS episode_context_update; DROP TRIGGER IF EXISTS episode_context_delete; DROP TRIGGER IF EXISTS session_context_delete; DROP TRIGGER IF EXISTS workspace_context_remove; DROP TRIGGER IF EXISTS context_insert; DROP TRIGGER IF EXISTS context_update; DROP TRIGGER IF EXISTS context_delete;
DROP TABLE IF EXISTS context_fts; DROP TABLE IF EXISTS context_paths; DROP TABLE IF EXISTS context_docs; DROP TABLE IF EXISTS context_meta;`;

export function createContextIndexRepository(
  db: SqliteDatabase,
  options: { fts?: boolean } = {},
): ContextIndexRepository {
  let fts = false;
  const ensure = () => {
    db.exec(DDL);
    if (
      Number(
        db.prepare("SELECT value FROM context_meta WHERE key='version'").get()?.value ??
          CONTEXT_INDEX_VERSION,
      ) !== CONTEXT_INDEX_VERSION
    ) {
      db.exec(DROP);
      db.exec(DDL);
    }
    try {
      if (options.fts === false) throw new Error('scan');
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS context_fts USING fts5(title, body, content='context_docs', content_rowid='id', tokenize='trigram remove_diacritics 1');
        CREATE TRIGGER IF NOT EXISTS context_insert AFTER INSERT ON context_docs BEGIN
          INSERT INTO context_fts(rowid,title,body) VALUES(new.id,new.title,new.body); END;
        CREATE TRIGGER IF NOT EXISTS context_update AFTER UPDATE ON context_docs BEGIN
          INSERT INTO context_fts(context_fts,rowid,title,body) VALUES('delete',old.id,old.title,old.body);
          INSERT INTO context_fts(rowid,title,body) VALUES(new.id,new.title,new.body); END;
        CREATE TRIGGER IF NOT EXISTS context_delete AFTER DELETE ON context_docs BEGIN
          INSERT INTO context_fts(context_fts,rowid,title,body) VALUES('delete',old.id,old.title,old.body); END;`);
      fts = true;
    } catch {
      fts = false;
      db.exec(
        'DROP TRIGGER IF EXISTS context_insert; DROP TRIGGER IF EXISTS context_update; DROP TRIGGER IF EXISTS context_delete; DROP TABLE IF EXISTS context_fts;',
      );
    }
    db.exec(`CREATE TRIGGER IF NOT EXISTS episode_context_update AFTER UPDATE ON episodes BEGIN
      DELETE FROM context_docs WHERE kind='episode' AND instr(ref,'ep:' || old.id || '#')=1; END;
      CREATE TRIGGER IF NOT EXISTS episode_context_delete AFTER DELETE ON episodes BEGIN
      DELETE FROM context_docs WHERE kind='episode' AND instr(ref,'ep:' || old.id || '#')=1; END;
      CREATE TRIGGER IF NOT EXISTS session_context_delete AFTER DELETE ON sessions BEGIN
      DELETE FROM context_docs WHERE kind='episode' AND instr(ref,'ep:ep_' || substr(old.id,5) || '#')=1; END;
      CREATE TRIGGER IF NOT EXISTS workspace_context_remove AFTER UPDATE OF removed_at ON workspaces WHEN new.removed_at IS NOT NULL BEGIN
      DELETE FROM context_docs WHERE workspace_id=new.id; END;`);
    const previous = db.prepare("SELECT value FROM context_meta WHERE key='mode'").get()?.value;
    if (previous !== undefined && previous !== (fts ? 'fts' : 'scan')) {
      db.exec(DROP);
      db.exec(DDL);
      db.prepare("INSERT INTO context_meta VALUES('mode',?)").run(fts ? 'fts' : 'scan');
      ensure();
      return;
    }
    const put = db.prepare(
      'INSERT INTO context_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    );
    put.run('version', String(CONTEXT_INDEX_VERSION));
    put.run('mode', fts ? 'fts' : 'scan');
  };
  try {
    ensure();
  } catch {
    db.exec(DROP);
    ensure();
  }
  return {
    get fts() {
      return fts;
    },
    removeRef(ref) {
      db.prepare('DELETE FROM context_docs WHERE ref=?').run(ref);
    },
    reset() {
      db.exec(DROP);
      ensure();
    },
    sync(workspaceId, docs) {
      const existing = db
        .prepare('SELECT id, ref FROM context_docs WHERE workspace_id IS ?')
        .all(workspaceId ?? null);
      const keep = new Set(docs.map((doc) => doc.ref));
      const remove = db.prepare('DELETE FROM context_docs WHERE id=?');
      for (const row of existing) if (!keep.has(String(row.ref))) remove.run(row.id as number);
      const put =
        db.prepare(`INSERT INTO context_docs(ref,kind,workspace_id,title,body,updated_at,revision,state) VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(ref) DO UPDATE SET title=excluded.title,body=excluded.body,updated_at=excluded.updated_at,revision=excluded.revision,state=excluded.state
        WHERE context_docs.revision != excluded.revision OR context_docs.state != excluded.state OR context_docs.body != excluded.body OR context_docs.title != excluded.title`);
      const get = db.prepare('SELECT id FROM context_docs WHERE ref=?');
      const clearPaths = db.prepare('DELETE FROM context_paths WHERE doc_id=?');
      const addPath = db.prepare('INSERT OR IGNORE INTO context_paths VALUES(?,?)');
      for (const doc of docs) {
        put.run(
          doc.ref,
          doc.kind,
          workspaceId ?? null,
          doc.title,
          doc.body.slice(0, 20000),
          doc.updatedAt,
          doc.revision,
          doc.state,
        );
        const id = get.get(doc.ref)?.id as number;
        clearPaths.run(id);
        for (const path of doc.paths) addPath.run(id, path);
      }
    },
    query({ workspaceIds, kinds, includeInvalid, path, terms }) {
      const scopes = [
        'workspace_id IS NULL',
        ...(workspaceIds.length
          ? [`workspace_id IN (${workspaceIds.map(() => '?').join(',')})`]
          : []),
      ];
      const args: SqlValue[] = [...workspaceIds, ...kinds];
      const where = [
        `(${scopes.join(' OR ')})`,
        `kind IN (${kinds.map(() => '?').join(',')})`,
        `state IN ('active'${includeInvalid ? ", 'invalid'" : ''})`,
      ];
      if (path !== undefined) {
        where.push(
          'EXISTS(SELECT 1 FROM context_paths p WHERE p.doc_id=d.id AND (p.path=? OR instr(p.path,?)=1))',
        );
        args.push(path, `${path}/`);
      }
      const indexed = terms.filter((term) => term.indexable);
      const useFts = fts && indexed.length > 0;
      const prefix = `SELECT d.*, ${useFts ? '-bm25(context_fts, 3.0, 1.0)' : '1'} AS score FROM context_docs d ${useFts ? 'JOIN context_fts ON context_fts.rowid=d.id' : ''}`;
      if (useFts) {
        where.push('context_fts MATCH ?');
        args.push(indexed.map((term) => `"${term.text.replaceAll('"', '""')}"`).join(' AND '));
      }
      const scanRows = db
        .prepare(
          `${prefix} WHERE ${where.join(' AND ')} ORDER BY ${useFts ? 'score DESC,' : ''} updated_at DESC, ref LIMIT ?`,
        )
        .all(...args, CONTEXT_SCAN_LIMIT) as SqlRow[];
      const rows = scanRows.filter((row) =>
        terms.every((term) =>
          `${row.title} ${row.body}`
            .toLowerCase()
            .normalize('NFD')
            .replace(/\p{M}/gu, '')
            .includes(term.text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '')),
        ),
      );
      return {
        docs: rows.map((row) => ({
          ref: String(row.ref),
          kind: row.kind as ContextDocRecord['kind'],
          ...(row.workspace_id !== null && { workspaceId: String(row.workspace_id) }),
          title: String(row.title),
          body: String(row.body),
          updatedAt: String(row.updated_at),
          revision: String(row.revision),
          state: row.state as ContextDocRecord['state'],
          paths: [],
          score: Number(row.score),
        })),
        ...(!useFts && {
          scan: {
            reason: fts ? ('short_term' as const) : ('fts_unavailable' as const),
            examined: scanRows.length,
            limit: CONTEXT_SCAN_LIMIT,
          },
        }),
      };
    },
  };
}
