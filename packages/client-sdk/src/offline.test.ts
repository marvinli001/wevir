import { ErrorCode } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { ConnectionLostError, RequestTimeoutError, WevirRpcError } from './errors.js';
import {
  type OfflineConversation,
  offlineTranscript,
  PersistentDrafts,
  sendOutcomeUnknown,
} from './offline.js';

describe('persistent input drafts', () => {
  it('distinguishes transport uncertainty from definite RPC results', () => {
    expect(
      sendOutcomeUnknown(
        new WevirRpcError('session.send', { code: ErrorCode.DEVICE_FORBIDDEN, message: 'denied' }),
      ),
    ).toBe(false);
    expect(
      sendOutcomeUnknown(
        new WevirRpcError('session.send', {
          code: ErrorCode.ENGINE_ERROR,
          message: 'engine error',
        }),
      ),
    ).toBe(false);
    expect(
      sendOutcomeUnknown(new ConnectionLostError('session.send', undefined, '', undefined, false)),
    ).toBe(false);
    expect(sendOutcomeUnknown(new RequestTimeoutError('session.send', 1000, false))).toBe(false);
    expect(sendOutcomeUnknown(new RequestTimeoutError('session.send', 1000, true))).toBe(true);
    expect(sendOutcomeUnknown(new Error('lost response'))).toBe(true);
  });
  it('reuses a persisted send identity and settles it from acknowledged events', async () => {
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
    const sent = await first.begin('host/session', 'original input', 'message_stable');
    await first.writeState('host/session', { text: 'later edit', uncertain: true });
    const reopened = new PersistentDrafts(storage);
    const retried = await reopened.begin('host/session', 'later edit', 'message_changed');
    expect(retried.clientMessageId).toBe(sent.clientMessageId);
    expect(retried.submittedText).toBe('original input');
    await reopened.acknowledge('host/session', 'message_stable');
    expect(await reopened.readState('host/session')).toEqual({
      text: 'later edit',
      uncertain: false,
    });
  });
  it('preserves uncertain sends across restart and acknowledges only the submitted text', async () => {
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
    await first.writeState('host/session', { text: 'submitted input', uncertain: true });
    const reopened = new PersistentDrafts(storage);
    expect(await reopened.readState('host/session')).toEqual({
      text: 'submitted input',
      uncertain: true,
    });
    await reopened.writeState('host/session', { text: 'newer local edit', uncertain: true });
    expect(await reopened.settle('host/session', 'submitted input')).toEqual({
      text: 'newer local edit',
      uncertain: false,
    });
    await reopened.writeState('host/session', { text: 'confirmed input', uncertain: true });
    await reopened.settle('host/session', 'confirmed input');
    expect(await new PersistentDrafts(storage).readState('host/session')).toEqual({
      text: '',
      uncertain: false,
    });
  });
  it('keeps legacy text intact without claiming an unknown old outcome was not executed', async () => {
    const original = '{"v":1,"text":"literal user input","uncertain":false}';
    const values = new Map([['legacy/session', original]]);
    const drafts = new PersistentDrafts({
      get: async (key) => values.get(key),
      set: async (key, value) => {
        values.set(key, value);
      },
      delete: async (key) => {
        values.delete(key);
      },
    });
    expect(await drafts.readState('legacy/session')).toEqual({ text: original, uncertain: true });
    await drafts.writeState('legacy/session', { text: original, uncertain: true });
    expect(values.has('legacy/session')).toBe(false);
    expect(await drafts.read('legacy/session')).toBe(original);
    const manual = await drafts.begin('legacy/session', original, 'manual-legacy-send');
    expect(manual.clientMessageId).toBe('manual-legacy-send');
    expect((await drafts.begin('legacy/session', original, 'different-id')).clientMessageId).toBe(
      'manual-legacy-send',
    );
  });
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
