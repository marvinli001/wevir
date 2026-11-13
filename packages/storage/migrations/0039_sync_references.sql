ALTER TABLE sync_vaults ADD COLUMN scope_initialized INTEGER NOT NULL DEFAULT 0 CHECK (scope_initialized IN (0, 1));
ALTER TABLE sync_vaults ADD COLUMN history_backfill_pending INTEGER NOT NULL DEFAULT 0 CHECK (history_backfill_pending IN (0, 1));

CREATE TABLE sync_content_refs (
  vault_id TEXT NOT NULL REFERENCES sync_vaults(vault_id),
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('episode', 'retro-summary', 'session')),
  source TEXT NOT NULL,
  local_id TEXT,
  PRIMARY KEY (vault_id, entity_id)
) STRICT;
CREATE INDEX sync_content_local ON sync_content_refs(kind, local_id);
CREATE INDEX sync_source_events_local ON sync_source_events(vault_id, host_id, session_id, stream_id, local_seq);

CREATE TABLE sync_session_deletions (
  vault_id TEXT NOT NULL REFERENCES sync_vaults(vault_id),
  entity_id TEXT NOT NULL,
  local_session_id TEXT NOT NULL,
  op_id TEXT NOT NULL,
  PRIMARY KEY (vault_id, entity_id)
) STRICT;
