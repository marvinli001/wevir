ALTER TABLE sync_vaults ADD COLUMN key_epoch TEXT NOT NULL DEFAULT '1';
ALTER TABLE sync_vaults ADD COLUMN transport_state TEXT NOT NULL DEFAULT 'disabled';
ALTER TABLE sync_vaults ADD COLUMN last_error TEXT;
ALTER TABLE sync_vaults ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_vaults ADD COLUMN last_sync_at TEXT;

ALTER TABLE sync_blobs ADD COLUMN upload_id TEXT;
ALTER TABLE sync_blobs ADD COLUMN upload_expires_at TEXT;
ALTER TABLE sync_blobs ADD COLUMN upload_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_blobs ADD COLUMN download_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_blobs ADD COLUMN error_code TEXT;

CREATE TABLE sync_entities (
  vault_id TEXT NOT NULL REFERENCES sync_vaults(vault_id),
  entity_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  project_id TEXT,
  local_key TEXT NOT NULL,
  revision TEXT,
  fingerprint TEXT,
  materialized INTEGER NOT NULL DEFAULT 1 CHECK (materialized IN (0, 1)),
  PRIMARY KEY (vault_id, entity_id)
) STRICT;
CREATE UNIQUE INDEX sync_local_entity ON sync_entities(vault_id, local_key) WHERE materialized = 1;
CREATE INDEX sync_entity_collisions ON sync_entities(vault_id, local_key);

CREATE TABLE sync_drafts (
  vault_id TEXT NOT NULL,
  op_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  parents TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (vault_id, op_id),
  FOREIGN KEY (vault_id, entity_id) REFERENCES sync_entities(vault_id, entity_id)
) STRICT;

CREATE TABLE sync_event_captures (
  vault_id TEXT NOT NULL REFERENCES sync_vaults(vault_id),
  local_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  stream_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  through_seq INTEGER NOT NULL,
  prepared_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (vault_id, local_session_id, stream_id),
  CHECK (prepared_seq >= 0 AND through_seq >= prepared_seq)
) STRICT;
