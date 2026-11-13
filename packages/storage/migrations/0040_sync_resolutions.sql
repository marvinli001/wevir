ALTER TABLE sync_local_writes ADD COLUMN resolution INTEGER NOT NULL DEFAULT 0 CHECK (resolution IN (0, 1));
