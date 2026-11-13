ALTER TABLE sync_bootstrap_entries ADD COLUMN applied INTEGER NOT NULL DEFAULT 0 CHECK (applied IN (0, 1));
ALTER TABLE sync_bootstrap_jobs ADD COLUMN active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1));
UPDATE sync_bootstrap_jobs SET active = 1 WHERE rowid IN (SELECT MAX(rowid) FROM sync_bootstrap_jobs GROUP BY vault_id);
CREATE UNIQUE INDEX sync_active_bootstrap ON sync_bootstrap_jobs(vault_id) WHERE active = 1;

CREATE TABLE sync_bootstrap_applications (
  vault_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  snapshot_cursor TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('applying', 'applied', 'acknowledged')),
  scope_revision TEXT,
  scope_attempt TEXT,
  error_code TEXT,
  PRIMARY KEY (vault_id, job_id),
  FOREIGN KEY (vault_id, job_id) REFERENCES sync_bootstrap_jobs(vault_id, job_id)
) STRICT;

ALTER TABLE sync_operations ADD COLUMN rebased_to TEXT;
ALTER TABLE sync_commits ADD COLUMN rebased INTEGER NOT NULL DEFAULT 0 CHECK (rebased IN (0, 1));
CREATE TABLE sync_reset_drafts (
  vault_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  op_id TEXT NOT NULL,
  original TEXT NOT NULL,
  PRIMARY KEY (vault_id, job_id, op_id),
  FOREIGN KEY (vault_id, job_id) REFERENCES sync_bootstrap_jobs(vault_id, job_id)
) STRICT;
