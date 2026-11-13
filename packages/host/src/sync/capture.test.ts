import { join } from 'node:path';
import { SessionIdSchema, type WevirEvent } from '@wevir/protocol';
import { openStorage, type SyncVaultRecord } from '@wevir/storage';
import { afterEach, describe, expect, it } from 'vitest';
import { session, workspace } from '../../../storage/src/test-utils.js';
import { EventStore } from '../event-store.js';
import { useTempDir } from '../test-utils.js';
import { SyncEventCapture } from './capture.js';
import { eventDigest } from './crypto.js';
import type { SyncDraftPayload } from './queue.js';

const tempDir = useTempDir();
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture() {
  const storage = openStorage({ dataDir: join(tempDir(), 'home') });
  cleanups.push(() => storage.close());
  storage.workspaces.insert(workspace({ id: 'ws_capture', rootPath: '/synthetic/project' }));
  const native = session({
    id: 'ses_capture',
    workspaceId: 'ws_capture',
    cwd: '/synthetic/project',
  });
  storage.sessions.insert(native);
  const vault = {
    vaultId: 'vault_fixture',
    accountId: 'user_fixture',
    deviceId: 'device_fixture',
    originHostId: 'device_fixture',
    appliedCursor: 'cursor_initial',
  };
  let permitted = false;
  let interruptCapture = false;
  storage.transaction(() => {
    storage.sync.bindVault(vault);
    storage.sync.bindProject(vault.vaultId, 'project_fixture', 'ws_capture');
    storage.sync.setScopes(vault.vaultId, {
      revision: '1',
      enabled: true,
      categories: ['project', 'session', 'event-segment'],
      projectIds: ['project_fixture'],
    });
  });
  const capture = new SyncEventCapture({
    storage,
    eligible: (): SyncVaultRecord | undefined =>
      permitted ? storage.sync.activeVault() : undefined,
  });
  const store = new EventStore({
    storage,
    onAppendInTransaction: (events) => {
      capture.record(events);
      if (interruptCapture) throw new Error('synthetic capture interruption');
    },
  });
  cleanups.push(() => store.close());
  const sessionId = SessionIdSchema.parse(native.id);
  const create = () =>
    store.append(sessionId, {
      type: 'session.created',
      source: 'host',
      payload: {
        workspaceId: 'ws_capture',
        cwd: '/synthetic/project',
        engine: 'dsh',
        engineSessionId: native.engineSessionId,
        providerId: native.providerId,
        modelId: native.modelId,
        title: '',
      },
    });
  return {
    storage,
    capture,
    store,
    vault,
    native,
    sessionId,
    create,
    interrupt: () => {
      interruptCapture = true;
    },
    permit: () => {
      permitted = true;
    },
  };
}

describe('same-transaction source event capture', () => {
  it('declares diagnostic omissions without uploading raw engine content or losing source sequence positions', () => {
    const h = fixture();
    h.permit();
    h.create();
    h.store.append(h.sessionId, {
      type: 'engine.raw',
      source: 'engine',
      payload: {
        protocol: 'synthetic',
        method: 'diagnostic',
        params: { token: 'synthetic-diagnostic-token' },
      },
    });
    expect(h.storage.events.list(h.native.id).at(-1)?.payload).toMatchObject({
      params: { token: 'synthetic-diagnostic-token' },
    });
    h.capture.prepare();
    const draft = h.storage.sync.drafts(h.vault.vaultId).find((row) => row.kind === 'append');
    const payload = draft?.content as SyncDraftPayload;
    expect(payload.origin).toMatchObject({ fromSeq: '1', throughSeq: '2' });
    expect(payload.body).toMatchObject({ exclusions: ['engine.raw'] });
    expect(payload.events?.[1]?.content).toMatchObject({
      seq: 2,
      type: 'engine.raw',
      payload: { omitted: true },
    });
    expect(JSON.stringify(payload)).not.toContain('synthetic-diagnostic-token');
  });
  it('does not capture before consent and excludes previously saved history unless selected', () => {
    const h = fixture();
    h.create();
    expect(h.storage.sync.sources(h.vault.vaultId)).toEqual([]);
    expect(h.storage.sync.drafts(h.vault.vaultId)).toEqual([]);
    h.permit();
    h.capture.initialize(false);
    h.store.append(h.sessionId, {
      type: 'session.title_changed',
      source: 'host',
      payload: { title: 'Synthetic task', source: 'user' },
    });
    h.capture.prepare();
    const stream = h.storage.sync.drafts(h.vault.vaultId).find((row) => row.kind === 'append');
    const payload = stream?.content as SyncDraftPayload;
    expect(payload.origin).toMatchObject({
      fromSeq: '2',
      throughSeq: '2',
      hostId: 'device_fixture',
      sessionId: h.native.id,
    });
    expect(payload.events).toHaveLength(1);
    const event = payload.events?.[0];
    expect(event?.sha256).toBe(
      eventDigest(
        {
          vaultId: h.vault.vaultId,
          hostId: 'device_fixture',
          sessionId: h.native.id,
          streamId: payload.origin?.streamId as string,
          seq: '2',
        },
        event?.content,
      ),
    );
  });

  it('rolls the event, metadata drafts and capture range back if the business transaction fails', () => {
    const h = fixture();
    h.permit();
    h.interrupt();
    expect(() => h.create()).toThrow('synthetic capture interruption');
    expect(h.storage.events.list(h.native.id)).toEqual([]);
    expect(h.storage.sync.drafts(h.vault.vaultId)).toEqual([]);
    expect(h.storage.sync.captures(h.vault.vaultId)).toEqual([]);
  });

  it('preserves stream identity while assigning independent immutable entities to later event segments', () => {
    const h = fixture();
    h.permit();
    h.create();
    h.capture.prepare();
    h.store.append(h.sessionId, {
      type: 'session.title_changed',
      source: 'host',
      payload: { title: 'Later progress', source: 'user' },
    });
    h.capture.prepare();
    const segments = h.storage.sync.drafts(h.vault.vaultId).filter((row) => row.kind === 'append');
    const payloads = segments.map((row) => row.content as SyncDraftPayload);
    expect(segments).toHaveLength(2);
    expect(segments[0]?.entityId).not.toBe(segments[1]?.entityId);
    expect(payloads[0]?.origin?.streamId).toBe(payloads[1]?.origin?.streamId);
    expect(payloads[1]?.origin).toMatchObject({
      fromSeq: '2',
      throughSeq: '2',
    });
    expect(segments.map((row) => row.parents)).toEqual([[], []]);
  });

  it('never queues mirrored imports as this device source events', () => {
    const h = fixture();
    h.create();
    h.storage.sync.putSource({
      vaultId: h.vault.vaultId,
      hostId: 'host_remote',
      sessionId: 'session_remote',
      streamId: 'stream_remote',
      localSessionId: h.native.id,
      mirrored: true,
    });
    h.permit();
    h.capture.initialize(true);
    h.storage.transaction(() =>
      h.capture.record([
        {
          sessionId: h.sessionId,
          seq: 2,
          ts: new Date().toISOString(),
          type: 'session.title_changed',
          source: 'host',
          payload: { title: 'Remote projection only', source: 'user' },
        } as WevirEvent,
      ]),
    );
    expect(h.storage.sync.drafts(h.vault.vaultId)).toEqual([]);
    expect(h.storage.sync.captures(h.vault.vaultId)).toEqual([]);
  });
});
