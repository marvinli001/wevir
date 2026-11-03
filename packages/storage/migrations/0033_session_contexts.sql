CREATE TABLE session_contexts (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  engine_session_key TEXT NOT NULL,
  text TEXT NOT NULL,
  hash TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(session_id, engine_session_key)
) STRICT, WITHOUT ROWID;
