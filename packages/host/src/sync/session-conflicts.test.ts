import {
  EpisodeSchema,
  type MethodParams,
  type SyncSessionConflictContentSchema,
} from '@wevir/protocol';
import { jcs } from '@wevir/protocol/sync';
import { FileSecretStore, openStorage } from '@wevir/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { episode } from '../../../protocol/src/test-samples.js';
import { EventStore } from '../event-store.js';
import { SES, seedSession, T0, useTempDir } from '../test-utils.js';
import { ZuvClient } from '../zuv/client.js';
import { SyncQueue } from './queue.js';
import { SyncSessionConflicts } from './session-conflicts.js';
import { SyncSessionMaterials } from './session-materials.js';

const tempDir = useTempDir();
const stops: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const stop of stops.splice(0).reverse()) stop();
});
type Content = typeof SyncSessionConflictContentSchema._output;
function fixture() {
  const home = tempDir();
  const storage = openStorage({ dataDir: home });
  const events = new EventStore({ storage });
  stops.push(() => {
    events.close();
    storage.close();
  });
  const vaultId = 'vault_synthetic';
  const source = {
    hostId: 'host_source',
    deviceId: 'device_source',
    sessionId: SES,
    streamId: 'stream_source',
  };
  storage.transaction(() => {
    seedSession(storage);
    storage.sync.bindVault({
      vaultId,
      accountId: 'user_synthetic',
      deviceId: 'device_local',
      originHostId: 'host_local',
      appliedCursor: 'initial',
    });
    storage.sync.setScopes(vaultId, {
      enabled: true,
      revision: '1',
      categories: ['project', 'session', 'event-segment'],
      projectIds: ['project_synthetic'],
    });
    storage.sync.putSource({ ...source, vaultId, localSessionId: SES, mirrored: false });
    storage.sync.putContentRef({ vaultId, entityId: SES, kind: 'session', source, localId: SES });
  });
  const client = new ZuvClient({
    origin: 'https://synthetic.invalid',
    secrets: new FileSecretStore(home),
  });
  const materials = new SyncSessionMaterials({
    storage,
    events,
    client,
    eligible: () => storage.sync.activeVault(),
    nativeSource: () => undefined,
    ensureSource: () =>
      storage.sync.sources(vaultId)[0] as NonNullable<
        ReturnType<typeof storage.sync.sources>[number]
      >,
  });
  const conflicts = new SyncSessionConflicts({
    storage,
    materials,
    eligible: () => {
      const vault = storage.sync.activeVault();
      return vault?.enabled ? vault : undefined;
    },
  });
  let seq = 0;
  const apply = async (
    opId: string,
    parents: string[],
    content: Content,
    entityId = SES as string,
    kind: 'put' | 'delete' | 'resolve' = 'put',
  ) => {
    const op = {
      vaultId,
      opId,
      entityId,
      entityType: 'session' as const,
      deviceId: 'device_source',
      kind,
      parents,
      clientTime: T0,
    };
    const record = { opId, entityId, kind, parents, projectId: 'project_synthetic', content };
    const materialize = await materials.prepare(op, record);
    storage.transaction(() => {
      storage.sync.putOperation({
        ...op,
        deviceSeq: String(++seq),
        envelope: op,
        manifest: {},
        digest: opId,
        record,
        direction: 'inbox',
        state: 'applied',
        projectId: 'project_synthetic',
      });
      materialize();
      storage.sync.applyHeads(vaultId, entityId, opId, parents);
    });
  };
  const body = (title = 'Base', archivedAt: string | null = null): Content => ({
    schema: 'wevir-session-state/1',
    source,
    title,
    titleSource: 'user',
    archivedAt,
  });
  const selection = (preview = conflicts.preview(SES)): MethodParams<'sync.resolveSession'> => ({
    vaultId,
    entityId: preview.entityId,
    expectedHeads: preview.expectedHeads,
    localRevision: preview.localRevision,
    localFingerprint: preview.localFingerprint,
    selection: { kind: 'version', opId: 'operation_right' },
  });
  return { storage, events, source, materials, conflicts, vaultId, apply, body, selection };
}

describe('causal session material selection', () => {
  it('keeps explicit version choices when local ancestry crosses a missing RESET boundary', async () => {
    const h = fixture();
    await h.apply('operation_remote', [], h.body('Remote'));
    const entity = h.storage.sync.entity(h.vaultId, SES);
    if (!entity) throw new Error('missing synthetic entity');
    h.storage.transaction(() =>
      new SyncQueue(h.storage).enqueue({
        vaultId: h.vaultId,
        entityId: SES,
        entityType: 'session',
        localKey: entity.localKey,
        projectId: 'project_synthetic',
        parents: ['operation_pruned'],
        content: h.body('Local'),
      }),
    );
    expect(h.conflicts.list().conflicts).toHaveLength(1);
    expect(h.conflicts.preview(SES)).toMatchObject({ mergeState: 'unavailable' });
    await h.conflicts.resolve({
      ...h.selection(),
      selection: { kind: 'version', opId: 'operation_remote' },
    });
    expect(h.storage.sessions.get(SES)?.title).toBe('Remote');
  });
  it('merges independent title and archive changes, preserving versions and execution history', async () => {
    const h = fixture();
    await h.apply('operation_base', [], h.body());
    await h.apply('operation_left', ['operation_base'], h.body('Renamed'));
    await h.apply('operation_right', ['operation_base'], h.body('Base', T0));
    expect(h.conflicts.list().conflicts).toMatchObject([
      { entityId: SES, heads: ['operation_left', 'operation_right'] },
    ]);
    const preview = h.conflicts.preview(SES);
    expect(preview.merged).toMatchObject({ title: 'Renamed', archivedAt: T0 });
    const result = await h.conflicts.resolve({
      ...h.selection(preview),
      selection: { kind: 'merged' },
    });
    expect(h.storage.sessions.get(SES)).toMatchObject({ title: 'Renamed', archivedAt: T0 });
    expect(h.storage.sync.draft(h.vaultId, result.opId)).toMatchObject({
      kind: 'resolve',
      parents: ['operation_left', 'operation_right'],
    });
    expect(h.storage.sync.getOperation(h.vaultId, 'operation_left')?.record).toBeDefined();
    expect(h.storage.sync.getOperation(h.vaultId, 'operation_right')?.record).toBeDefined();
    expect(h.storage.sync.materialJournal(h.vaultId, 'operation_right')).toBeUndefined();
    expect(h.events.readSince(SES, 0)).toEqual([]);
    expect(h.conflicts.list().conflicts).toEqual([]);
  });

  it('keeps overlapping title edits for an explicit version choice', async () => {
    const h = fixture();
    await h.apply('operation_base', [], h.body());
    await h.apply('operation_left', ['operation_base'], h.body('Left'));
    await h.apply('operation_right', ['operation_base'], h.body('Right'));
    expect(h.conflicts.preview(SES)).toMatchObject({ mergeState: 'conflict' });
    await expect(
      h.conflicts.resolve({ ...h.selection(), selection: { kind: 'merged' } }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await h.conflicts.resolve(h.selection());
    expect(h.storage.sessions.get(SES)?.title).toBe('Right');
  });

  it('rejects a preview after an uncaptured local edit or scope change', async () => {
    const h = fixture();
    await h.apply('operation_left', [], h.body('Left'));
    await h.apply('operation_right', [], h.body('Right'));
    const input = h.selection();
    h.storage.sessions.update(SES, { title: 'Unsaved to the queue' });
    await expect(h.conflicts.resolve(input)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    const changed = h.selection();
    h.storage.sync.setScopes(h.vaultId, {
      enabled: false,
      revision: '2',
      categories: ['session'],
      projectIds: ['project_synthetic'],
    });
    await expect(h.conflicts.resolve(changed)).rejects.toMatchObject({ code: 'SCOPE_DISABLED' });
    expect(h.storage.sync.drafts(h.vaultId)).toEqual([]);
    expect(h.storage.sessions.get(SES)?.title).toBe('Unsaved to the queue');
  });

  it('includes a local uncommitted revision alongside a received head', async () => {
    const h = fixture();
    await h.apply('operation_base', [], h.body());
    const local = h.storage.transaction(() => {
      h.storage.sessions.update(SES, { title: 'Local' });
      return new SyncQueue(h.storage).enqueue({
        vaultId: h.vaultId,
        entityId: SES,
        entityType: 'session',
        projectId: 'project_synthetic',
        localKey: `session:${SES}`,
        content: h.body('Local'),
      }) as string;
    });
    await h.apply('operation_right', ['operation_base'], h.body('Remote'));
    expect(h.conflicts.list().conflicts[0]?.heads).toEqual([local, 'operation_right'].sort());
    const preview = h.conflicts.preview(SES);
    const result = await h.conflicts.resolve({
      ...h.selection(preview),
      selection: { kind: 'version', opId: local },
    });
    expect(h.storage.sync.draft(h.vaultId, result.opId)?.parents).toContain(local);
    expect(h.storage.sessions.get(SES)?.title).toBe('Local');
  });

  it('keeps deletion against a running native session unresolved until execution has stopped', async () => {
    const h = fixture();
    await h.apply('operation_left', [], h.body('Local'));
    await h.apply(
      'operation_right',
      [],
      { schema: 'wevir-session-deleted/1', source: h.source, deletedAt: T0 },
      SES,
      'delete',
    );
    h.storage.sessions.update(SES, { activeTurn: { turnId: 'trn_synthetic', startedAt: T0 } });
    await expect(h.conflicts.resolve(h.selection())).rejects.toMatchObject({
      code: 'REVISION_CONFLICT',
    });
    expect(h.storage.sync.drafts(h.vaultId)).toEqual([]);
    expect(h.storage.sessions.get(SES)?.archivedAt).toBeUndefined();
    h.storage.sessions.update(SES, { activeTurn: null });
    await h.conflicts.resolve(h.selection());
    expect(h.storage.sync.sessionDeleted(SES)).toBe(true);
    expect(h.events.readSince(SES, 0)).toEqual([]);
  });

  it('rolls the selected projection back when the outbox cannot claim its resource', async () => {
    const h = fixture();
    await h.apply('operation_left', [], h.body('Left'));
    await h.apply('operation_right', [], h.body('Right'));
    const before = jcs(h.storage.sessions.get(SES));
    vi.spyOn(h.storage.sync, 'claimResource').mockReturnValue(false);
    await expect(h.conflicts.resolve(h.selection())).rejects.toMatchObject({
      code: 'SCOPE_DISABLED',
    });
    expect(jcs(h.storage.sessions.get(SES))).toBe(before);
    expect(h.storage.sync.entity(h.vaultId, SES)?.revision).toBe('operation_left');
    expect(h.storage.sync.drafts(h.vaultId)).toEqual([]);
  });

  it('selects an archived version without retaining a rejected deletion tombstone', async () => {
    const h = fixture();
    await h.apply(
      'operation_left',
      [],
      { schema: 'wevir-session-deleted/1', source: h.source, deletedAt: T0 },
      SES,
      'delete',
    );
    await h.apply('operation_right', [], h.body('Archived version', T0));
    expect(h.storage.sync.sessionDeleted(SES)).toBe(true);
    await h.conflicts.resolve(h.selection());
    expect(h.storage.sessions.get(SES)?.archivedAt).toBe(T0);
    expect(h.storage.sync.sessionDeleted(SES)).toBe(false);
  });

  it.each(['episode', 'retro-summary'] as const)(
    'restores a selected %s version without replaying its references',
    async (kind) => {
      const h = fixture();
      const entityId = kind === 'episode' ? `ep_${SES.slice(4)}` : `retro_${SES}`;
      const localId = kind === 'episode' ? entityId : SES;
      h.storage.transaction(() =>
        h.storage.sync.putContentRef({
          vaultId: h.vaultId,
          entityId,
          kind,
          source: h.source,
          localId,
        }),
      );
      const content = (text: string): Content =>
        kind === 'episode'
          ? {
              schema: 'wevir-episode/1',
              source: h.source,
              episodeId: entityId,
              episode: EpisodeSchema.parse({
                ...episode,
                id: entityId,
                workspaceId: 'ws_1',
                sessionId: SES,
                rootSessionId: SES,
                title: text,
                pinned: text === 'Right',
              }),
              deleted: false,
              createdAt: T0,
              updatedAt: T0,
            }
          : {
              schema: 'wevir-retro-summary/1',
              source: h.source,
              summary: {
                points: [{ text, refs: ['e1'] }],
                providerId: 'synthetic-api',
                modelId: 'synthetic-model',
                throughSeq: 1,
                generatedAt: T0,
                inputBytes: 16,
                outputBytes: 8,
              },
            };
      await h.apply('operation_left', [], content('Left'), entityId);
      await h.apply('operation_right', [], content('Right'), entityId);
      const preview = h.conflicts.preview(entityId);
      await h.conflicts.resolve(h.selection(preview));
      if (kind === 'episode')
        expect(h.storage.episodes.get(localId)).toMatchObject({ pinned: true });
      else
        expect(JSON.parse(h.storage.retros.getSummary(SES)?.summary ?? '{}')).toMatchObject({
          points: [{ text: 'Right' }],
        });
      expect(h.storage.sync.fileBaseline(h.vaultId, entityId)).toBeDefined();
      expect(h.events.readSince(SES, 0)).toEqual([]);
      expect(h.storage.sync.getOperation(h.vaultId, 'operation_left')?.record).toBeDefined();
    },
  );
});
