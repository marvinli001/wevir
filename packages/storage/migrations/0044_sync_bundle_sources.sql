CREATE TABLE sync_bundle_sources (
  vault_id TEXT NOT NULL,
  local_key TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  PRIMARY KEY (vault_id,local_key),
  FOREIGN KEY (vault_id,entity_id) REFERENCES sync_entities(vault_id,entity_id)
) STRICT;
ALTER TABLE sync_bundle_applications ADD COLUMN paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0,1));
ALTER TABLE sync_bundle_bindings ADD COLUMN scope_root TEXT;
