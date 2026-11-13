import type { Session, WevirEvent } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { adaptEventForClient, adaptResultForClient } from './rpc-connection.js';

const at = '2026-10-01T10:00:00.000Z';
const session: Session = {
  id: 'ses_demo',
  workspaceId: 'ws_demo',
  cwd: '/workspace/demo',
  engine: { kind: 'imported', sessionId: 'external-demo' },
  providerId: 'claude',
  modelId: 'demo',
  title: 'Counter',
  titleSource: 'first_prompt',
  state: 'closed',
  createdAt: at,
  updatedAt: at,
  lastSeq: 2,
  origin: { kind: 'imported', app: 'claude', externalId: 'demo', path: '/external/demo.jsonl' },
  readOnly: { reason: 'imported', message: '', since: at },
};

describe('external import compatibility', () => {
  it('keeps synchronized histories read-only for clients predating cloud synchronization', () => {
    const synced: Session = {
      ...session,
      origin: {
        kind: 'synced',
        vaultId: 'vault_synthetic',
        hostId: 'host_synthetic',
        sessionId: session.id,
      },
      readOnly: { message: '', since: at, reason: 'synchronized' },
    };
    for (const version of ['0.154.0', '0.171.0']) {
      expect(adaptResultForClient('session.get', { session: synced }, {}, version)).toMatchObject({
        session: { readOnly: { reason: 'engine_session_incompatible' } },
      });
      expect(
        (
          adaptResultForClient('session.get', { session: synced }, {}, version) as {
            session: Session;
          }
        ).session.origin,
      ).toBeUndefined();
      expect(
        adaptEventForClient(
          {
            type: 'session.read_only',
            seq: 2,
            sessionId: session.id,
            ts: at,
            source: 'host',
            payload: { reason: 'synchronized', message: '' },
          },
          {},
          version,
        ),
      ).toMatchObject({ payload: { reason: 'engine_session_incompatible' } });
    }
    expect(adaptResultForClient('session.get', { session: synced }, {}, '0.172.0')).toEqual({
      session: synced,
    });
  });
  it('downgrades new origin/reason values for pre-import clients in snapshots and lists', () => {
    const result = adaptResultForClient(
      'session.get',
      { session, pendingApprovals: [] },
      {},
      '0.154.0',
    ) as { session: Session };
    expect(result.session.origin).toBeUndefined();
    expect(result.session.readOnly?.reason).toBe('engine_session_incompatible');
    expect(
      adaptResultForClient('session.list', { sessions: [session] }, {}, '0.154.0'),
    ).toMatchObject({ sessions: [result.session] });
    expect(
      adaptResultForClient('session.get', { session, pendingApprovals: [] }, {}, '0.155.0'),
    ).toMatchObject({ session });
  });
  it('downgrades imported read-only events and unsupported import kinds', () => {
    const event: WevirEvent = {
      seq: 2,
      sessionId: session.id,
      ts: at,
      source: 'host',
      type: 'session.read_only',
      payload: { reason: 'imported', message: '' },
    };
    expect(adaptEventForClient(event, {}, '0.154.0')).toMatchObject({
      payload: { reason: 'engine_session_incompatible' },
    });
    expect(adaptEventForClient(event, {}, '0.155.0')).toEqual(event);
    expect(
      adaptResultForClient(
        'import.scan',
        { sessions: [], unsupported: ['session', 'memory'] },
        {},
        '0.154.0',
      ),
    ).toEqual({ unsupported: ['memory'] });
  });
});
