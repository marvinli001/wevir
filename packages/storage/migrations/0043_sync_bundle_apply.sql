CREATE TABLE sync_bundle_bindings (
  vault_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  target_key TEXT NOT NULL,
  target_anchor TEXT NOT NULL,
  target_path TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('file','directory')),
  revision TEXT,
  fingerprint TEXT NOT NULL,
  manifest TEXT NOT NULL,
  PRIMARY KEY (vault_id,entity_id),
  UNIQUE (vault_id,target_path),
  FOREIGN KEY (vault_id,entity_id) REFERENCES sync_entities(vault_id,entity_id)
) STRICT;

CREATE TABLE sync_bundle_applications (
  vault_id TEXT NOT NULL,
  op_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  scope_revision TEXT NOT NULL,
  previous_revision TEXT,
  previous_hash TEXT NOT NULL,
  next_hash TEXT NOT NULL,
  digest TEXT NOT NULL,
  operation TEXT NOT NULL,
  content TEXT NOT NULL,
  files TEXT NOT NULL,
  manifest TEXT NOT NULL,
  publish INTEGER NOT NULL CHECK (publish IN (0,1)),
  state TEXT NOT NULL CHECK (state IN ('prepared','applying','applied','conflict','abandoned')),
  PRIMARY KEY (vault_id,op_id),
  FOREIGN KEY (vault_id,entity_id) REFERENCES sync_bundle_bindings(vault_id,entity_id)
) STRICT;
CREATE UNIQUE INDEX sync_bundle_pending ON sync_bundle_applications(vault_id,entity_id)
  WHERE state IN ('prepared','applying','conflict');
