ALTER TABLE sync_commits ADD COLUMN outcome TEXT NOT NULL DEFAULT 'ready'
  CHECK (outcome IN ('ready', 'uncertain', 'rejected', 'recovered'));
ALTER TABLE sync_commits ADD COLUMN error_code TEXT;
ALTER TABLE sync_commits ADD COLUMN queries INTEGER NOT NULL DEFAULT 0;

CREATE TABLE sync_executions (
  vault_id TEXT NOT NULL REFERENCES sync_vaults(vault_id),
  local_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  state TEXT NOT NULL,
  turn_id TEXT,
  fencing_token TEXT,
  expires_at TEXT,
  source TEXT,
  PRIMARY KEY (vault_id, local_session_id)
) STRICT;

CREATE TABLE sync_outbox_recoveries (
  vault_id TEXT NOT NULL REFERENCES sync_vaults(vault_id),
  op_id TEXT NOT NULL,
  recovered_op_id TEXT NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (vault_id, op_id)
) STRICT;
