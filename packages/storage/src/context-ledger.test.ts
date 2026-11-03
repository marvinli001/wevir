import { describe, expect, it } from 'vitest';
import { useTempStorage } from './test-utils.js';

describe('contextLedger', () => {
  const { storage } = useTempStorage();
  it('only stores changed supplies per server, and keeps ISO call times without a session foreign key', () => {
    const ledger = storage().contextLedger;
    const supply = {
      sessionId: 'deleted',
      server: 'wevir',
      at: '2026-11-04T00:00:00.123Z',
      toolCount: 1,
      toolBytes: 20,
      instructionBytes: 6,
      memoryIndexBytes: 3,
      digest: 'a',
    };
    expect(ledger.supply(supply)).toBe(true);
    expect(ledger.supply(supply)).toBe(false);
    expect(ledger.supply({ ...supply, digest: 'b' })).toBe(true);
    expect(ledger.supply(supply)).toBe(true);
    expect(ledger.supply({ ...supply, server: 'wevir_more' })).toBe(true);
    const call = {
      sessionId: 'deleted',
      turnId: 'turn',
      at: supply.at,
      server: 'wevir',
      tool: 't',
      rawBytes: 100,
      returnedBytes: 50,
      spilled: true,
      isError: false,
    };
    ledger.call(call);
    ledger.call({ ...call, sessionId: undefined, turnId: undefined });
    expect(ledger.calls(['deleted'])).toEqual([call]);
    expect(ledger.supplies(['deleted'])).toHaveLength(4);
    expect(ledger.calls([])).toEqual([]);
  });
});
