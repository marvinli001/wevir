CREATE TABLE tool_supply (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  server TEXT NOT NULL,
  at TEXT NOT NULL,
  tool_count INTEGER NOT NULL,
  tool_bytes INTEGER NOT NULL,
  instruction_bytes INTEGER NOT NULL,
  memory_index_bytes INTEGER NOT NULL,
  digest TEXT NOT NULL
) STRICT;
CREATE INDEX tool_supply_session ON tool_supply (session_id, server, id);

CREATE TABLE tool_calls_ledger (
  id INTEGER PRIMARY KEY,
  session_id TEXT,
  turn_id TEXT,
  at TEXT NOT NULL,
  server TEXT NOT NULL,
  tool TEXT NOT NULL,
  raw_bytes INTEGER NOT NULL,
  returned_bytes INTEGER NOT NULL,
  spilled INTEGER NOT NULL,
  is_error INTEGER NOT NULL
) STRICT;
CREATE INDEX tool_calls_ledger_turn ON tool_calls_ledger (session_id, turn_id);
