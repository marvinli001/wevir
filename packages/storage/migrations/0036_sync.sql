CREATE TABLE sync_vaults (
  vault_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  origin_host_id TEXT NOT NULL,
  device_seq TEXT NOT NULL DEFAULT '0',
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  revision TEXT NOT NULL DEFAULT '0',
  categories TEXT NOT NULL DEFAULT '[]',
  project_ids TEXT NOT NULL DEFAULT '[]',
  applied_cursor TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX sync_active_vault ON sync_vaults(active) WHERE active = 1;

CREATE TABLE sync_projects (
  vault_id TEXT NOT NULL REFERENCES sync_vaults(vault_id),
  project_id TEXT NOT NULL,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  PRIMARY KEY (vault_id, project_id),
  UNIQUE (vault_id, workspace_id)
) STRICT;

CREATE TABLE sync_sources (
  vault_id TEXT NOT NULL REFERENCES sync_vaults(vault_id),
  host_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  local_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  mirrored INTEGER NOT NULL CHECK (mirrored IN (0, 1)),
  PRIMARY KEY (vault_id, host_id, session_id, stream_id)
) STRICT;

CREATE TABLE sync_source_events (
  vault_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  seq TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY (vault_id, host_id, session_id, stream_id, seq),
  FOREIGN KEY (vault_id, host_id, session_id, stream_id)
    REFERENCES sync_sources(vault_id, host_id, session_id, stream_id)
) STRICT;

CREATE TABLE sync_operations (
  vault_id TEXT NOT NULL REFERENCES sync_vaults(vault_id),
  op_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_seq TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  project_id TEXT,
  envelope TEXT NOT NULL,
  manifest TEXT NOT NULL,
  digest TEXT NOT NULL,
  record TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('outbox', 'inbox')),
  state TEXT NOT NULL CHECK (state IN ('queued', 'pending', 'committed', 'received', 'applied', 'quarantined')),
  commit_id TEXT,
  error_code TEXT,
  heads_applied INTEGER NOT NULL DEFAULT 0 CHECK (heads_applied IN (0, 1)),
  PRIMARY KEY (vault_id, op_id),
  UNIQUE (vault_id, device_id, device_seq)
) STRICT;
CREATE INDEX sync_outbox ON sync_operations(vault_id, direction, state);
CREATE INDEX sync_entity_revisions ON sync_operations(vault_id, entity_id);

CREATE TABLE sync_heads (
  vault_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  op_id TEXT NOT NULL,
  PRIMARY KEY (vault_id, entity_id, op_id),
  FOREIGN KEY (vault_id, op_id) REFERENCES sync_operations(vault_id, op_id)
) STRICT;

CREATE TABLE sync_commits (
  vault_id TEXT NOT NULL REFERENCES sync_vaults(vault_id),
  commit_id TEXT NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'pending', 'committed')),
  cursor TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (vault_id, commit_id)
) STRICT;

CREATE TABLE sync_pages (
  vault_id TEXT NOT NULL REFERENCES sync_vaults(vault_id),
  page_id TEXT NOT NULL,
  from_cursor TEXT NOT NULL,
  next_cursor TEXT NOT NULL,
  op_ids TEXT NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0, 1)),
  PRIMARY KEY (vault_id, page_id)
) STRICT;

CREATE TABLE sync_blobs (
  vault_id TEXT NOT NULL REFERENCES sync_vaults(vault_id),
  blob_id TEXT NOT NULL,
  cipher_sha256 TEXT NOT NULL,
  cipher_bytes INTEGER NOT NULL CHECK (cipher_bytes > 0),
  key_epoch TEXT NOT NULL,
  cache_path TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('local', 'reserved', 'ready', 'quarantined')),
  PRIMARY KEY (vault_id, blob_id)
) STRICT;

CREATE TABLE sync_file_journal (
  vault_id TEXT NOT NULL REFERENCES sync_vaults(vault_id),
  entity_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  project_id TEXT,
  path TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  staged_path TEXT,
  op_id TEXT,
  PRIMARY KEY (vault_id, entity_id)
) STRICT;
