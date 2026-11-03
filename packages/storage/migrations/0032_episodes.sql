CREATE TABLE episodes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL UNIQUE,
  root_session_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  through_seq INTEGER NOT NULL,
  digest_json TEXT NOT NULL,
  overrides_json TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  excluded INTEGER NOT NULL DEFAULT 0,
  revision TEXT NOT NULL,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX episodes_by_workspace ON episodes(workspace_id, updated_at DESC, id DESC);
