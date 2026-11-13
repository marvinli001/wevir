ALTER TABLE sync_vaults ADD COLUMN include_history INTEGER NOT NULL DEFAULT 0 CHECK (include_history IN (0, 1));
ALTER TABLE sync_projects ADD COLUMN display_name TEXT;
ALTER TABLE sync_sources ADD COLUMN device_id TEXT;
ALTER TABLE sync_source_events ADD COLUMN local_seq INTEGER;
CREATE INDEX sync_source_local ON sync_sources(local_session_id, vault_id);

CREATE TABLE sync_resource_owners (
  local_key TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL REFERENCES sync_vaults(vault_id)
) STRICT;

CREATE TABLE sync_material_journal (
  vault_id TEXT NOT NULL REFERENCES sync_vaults(vault_id),
  op_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  local_key TEXT NOT NULL,
  target_path TEXT NOT NULL,
  staged_path TEXT,
  previous_hash TEXT,
  next_hash TEXT NOT NULL,
  backup_path TEXT,
  state TEXT NOT NULL CHECK (state IN ('staged', 'applied', 'conflict')),
  PRIMARY KEY (vault_id, op_id)
) STRICT;

CREATE TABLE sync_local_writes (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL REFERENCES sync_vaults(vault_id),
  entity_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  project_id TEXT,
  local_key TEXT NOT NULL,
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('put', 'delete')),
  parents TEXT NOT NULL,
  next_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'abandoned'))
) STRICT;
