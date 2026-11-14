ALTER TABLE sync_sources ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1));
CREATE TABLE session_create_requests (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  owner TEXT NOT NULL,
  params TEXT NOT NULL
) STRICT;
