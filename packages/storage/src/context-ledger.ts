import type { SqliteDatabase } from './driver.js';

export interface ToolSupplyRow {
  sessionId: string;
  server: string;
  at: string;
  toolCount: number;
  toolBytes: number;
  instructionBytes: number;
  memoryIndexBytes: number;
  digest: string;
}

export interface ToolCallRow {
  sessionId?: string;
  turnId?: string;
  at: string;
  server: string;
  tool: string;
  rawBytes: number;
  returnedBytes: number;
  spilled: boolean;
  isError: boolean;
}

export function createContextLedgerRepository(db: SqliteDatabase) {
  const supply = db.prepare(`INSERT INTO tool_supply
    (session_id, server, at, tool_count, tool_bytes, instruction_bytes, memory_index_bytes, digest)
    SELECT :sessionId, :server, :at, :toolCount, :toolBytes, :instructionBytes, :memoryIndexBytes, :digest
    WHERE :digest IS NOT (SELECT digest FROM tool_supply WHERE session_id = :sessionId AND server = :server ORDER BY id DESC LIMIT 1)`);
  const call = db.prepare(`INSERT INTO tool_calls_ledger
    (session_id, turn_id, at, server, tool, raw_bytes, returned_bytes, spilled, is_error)
    VALUES (:sessionId, :turnId, :at, :server, :tool, :rawBytes, :returnedBytes, :spilled, :isError)`);
  return {
    supply(row: ToolSupplyRow): boolean {
      return Number(supply.run({ ...row }).changes) > 0;
    },
    call(row: ToolCallRow): void {
      call.run({
        ...row,
        sessionId: row.sessionId ?? null,
        turnId: row.turnId ?? null,
        spilled: Number(row.spilled),
        isError: Number(row.isError),
      });
    },
    supplies(sessionIds: readonly string[]): ToolSupplyRow[] {
      return db
        .prepare(`SELECT session_id AS sessionId, server, at, tool_count AS toolCount, tool_bytes AS toolBytes,
        instruction_bytes AS instructionBytes, memory_index_bytes AS memoryIndexBytes, digest
        FROM tool_supply WHERE session_id IN (SELECT value FROM json_each(?)) ORDER BY id`)
        .all(JSON.stringify(sessionIds)) as unknown as ToolSupplyRow[];
    },
    calls(sessionIds: readonly string[]): ToolCallRow[] {
      return db
        .prepare(`SELECT session_id AS sessionId, turn_id AS turnId, at, server, tool, raw_bytes AS rawBytes,
        returned_bytes AS returnedBytes, spilled, is_error AS isError
        FROM tool_calls_ledger WHERE session_id IN (SELECT value FROM json_each(?)) ORDER BY id`)
        .all(JSON.stringify(sessionIds))
        .map((row) => {
          const { turnId, spilled, isError, ...rest } = row;
          return {
            ...rest,
            ...(turnId !== null && { turnId }),
            spilled: spilled === 1,
            isError: isError === 1,
          } as unknown as ToolCallRow;
        });
    },
  };
}

export type ContextLedgerRepository = ReturnType<typeof createContextLedgerRepository>;
