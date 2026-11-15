ALTER TABLE sync_projects ADD COLUMN events_suspended INTEGER NOT NULL DEFAULT 0 CHECK (events_suspended IN (0, 1));
ALTER TABLE sync_event_captures ADD COLUMN history_floor_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sync_operations ADD COLUMN material_referenced INTEGER NOT NULL DEFAULT 0 CHECK (material_referenced IN (0, 1));
