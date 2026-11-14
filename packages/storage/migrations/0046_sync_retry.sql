ALTER TABLE sync_blobs ADD COLUMN retry_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_operations ADD COLUMN quarantine_version TEXT;
ALTER TABLE sync_operations ADD COLUMN acknowledged INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged IN (0, 1));
