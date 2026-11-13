CREATE TABLE sync_snapshot_proofs (
  vault_id TEXT NOT NULL REFERENCES sync_vaults(vault_id),
  job_id TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  PRIMARY KEY (vault_id, job_id)
) STRICT;

CREATE TABLE sync_bootstrap_jobs (
  vault_id TEXT NOT NULL REFERENCES sync_vaults(vault_id),
  job_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  origin TEXT NOT NULL,
  scope_revision TEXT NOT NULL,
  categories TEXT NOT NULL,
  project_ids TEXT NOT NULL,
  from_cursor TEXT NOT NULL,
  pending_before INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('creating', 'metadata', 'records', 'staged', 'failed')),
  error_code TEXT,
  PRIMARY KEY (vault_id, job_id)
) STRICT;

CREATE TABLE sync_bootstrap_entries (
  vault_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  op_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  envelope TEXT NOT NULL,
  manifest TEXT NOT NULL,
  digest TEXT NOT NULL,
  selected INTEGER NOT NULL CHECK (selected IN (0, 1)),
  record TEXT,
  record_digest TEXT,
  PRIMARY KEY (vault_id, job_id, op_id),
  UNIQUE (vault_id, job_id, position),
  FOREIGN KEY (vault_id, job_id) REFERENCES sync_bootstrap_jobs(vault_id, job_id)
) STRICT;

CREATE TABLE sync_snapshot_roots (
  vault_id TEXT NOT NULL,
  op_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  PRIMARY KEY (vault_id, op_id),
  FOREIGN KEY (vault_id, job_id) REFERENCES sync_snapshot_proofs(vault_id, job_id)
) STRICT;
