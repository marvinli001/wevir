import { describe, expect, it } from 'vitest';
import { type OfflineConversation, offlineTranscript, PersistentDrafts } from './offline.js';

describe('persistent input drafts', () => {
  it('keeps cached execution and approval state out of the offline projection', () => {
    const date = '2026-11-13T00:00:00.000Z';
    const value: OfflineConversation = {
      hostId: 'host_synthetic',
      clientId: 'client_synthetic',
      savedAt: date,
      session: {
        id: 'ses_synthetic',
        workspaceId: 'ws_synthetic',
        cwd: '/synthetic',
        engine: { kind: 'echo', sessionId: 'native_synthetic' },
        providerId: 'synthetic',
        modelId: 'synthetic',
        title: 'Synthetic',
        titleSource: 'user',
        state: 'running',
        lastSeq: 1,
        createdAt: date,
        updatedAt: date,
      },
      events: [
        {
          sessionId: 'ses_synthetic',
          seq: 1,
          ts: date,
          source: 'host',
          type: 'turn.started',
          payload: { turnId: 'trn_synthetic' },
        },
      ],
    };
    const transcript = offlineTranscript(value);
    expect(transcript.state).toBeUndefined();
    expect(transcript.activeTurnId).toBeUndefined();
    expect(transcript.pendingApprovals).toEqual([]);
    expect(transcript.pendingQuestions).toEqual([]);
    expect(transcript.pendingMessages).toEqual([]);
    expect(() =>
      offlineTranscript({
        ...value,
        events: [{ ...value.events[0], sessionId: 'ses_other' } as (typeof value.events)[number]],
      }),
    ).toThrow('offline source mismatch');
  });
  it('survives a new reader and only clears after an explicit write', async () => {
    const values = new Map<string, string>();
    const storage = {
      get: async (key: string) => values.get(key),
      set: async (key: string, value: string) => {
        values.set(key, value);
      },
      delete: async (key: string) => {
        values.delete(key);
      },
    };
    const first = new PersistentDrafts(storage);
    await first.write('host-a/client/session', 'synthetic draft');
    const restarted = new PersistentDrafts(storage);
    expect(await restarted.read('host-a/client/session')).toBe('synthetic draft');
    expect(await restarted.read('host-b/client/session')).toBe('');
    await restarted.write('host-a/client/session', '');
    expect(await first.read('host-a/client/session')).toBe('');
  });
});
