import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WevirEventSchema } from '@wevir/protocol';
import { jcs, packRecord, type SyncOperation } from '@wevir/protocol/sync';
import {
  FileSecretStore,
  openStorage,
  type SyncDraftRecord,
  type SyncVaultRecord,
} from '@wevir/storage';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventStore } from '../event-store.js';
import { newId } from '../ids.js';
import { ImageStore } from '../images.js';
import { MemoryStore } from '../memory.js';
import { HostSettingsStore } from '../settings.js';
import { useTempDir } from '../test-utils.js';
import { ZuvClient } from '../zuv/client.js';
import { sha256 } from './crypto.js';
import { SyncFilesCapture } from './files-capture.js';
import { SyncMaterials } from './materials.js';
import { SyncMemoryConflicts } from './memory-conflicts.js';
import type { SyncDraftPayload } from './queue.js';
import { SyncSettings } from './settings.js';

const tempDir = useTempDir();
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
  const home = join(tempDir(), newId('fixture'));
  const storage = openStorage({ dataDir: home });
  const events = new EventStore({ storage });
  cleanups.push(() => {
    events.close();
    storage.close();
  });
  storage.transaction(() => {
    storage.sync.bindVault({
      vaultId: 'vault_synthetic',
      accountId: 'user_synthetic',
      deviceId: 'device_synthetic',
      originHostId: 'device_synthetic',
      appliedCursor: 'initial',
    });
    storage.sync.setScopes('vault_synthetic', {
      enabled: true,
      revision: '1',
      categories: ['artifact', 'skill-bundle', 'rule'],
      projectIds: [],
    });
  });
  const memoryDir = join(home, 'memory');
  const materials = new SyncMaterials({
    client: new ZuvClient({ secrets: new FileSecretStore(home) }),
    eligible: () => storage.sync.activeVault(),
    nativeSource: () => undefined,
    storage,
    events,
    home,
    memoryDir,
    images: new ImageStore({ dir: join(home, 'images') }),
    settingsSync: new SyncSettings({ storage, home, settings: new HostSettingsStore() }),
  });
  const capture = new SyncFilesCapture({ storage, memoryDir });
  let deviceSeq = 0;
  async function apply(
    draft: SyncDraftRecord,
    entityType: SyncOperation['entityType'],
    extra: {
      projectId?: string;
      events?: typeof packRecord._output.events;
      origin?: SyncOperation['origin'];
    } = {},
  ) {
    const record = packRecord.parse({
      opId: draft.opId,
      entityId: draft.entityId,
      kind: draft.kind,
      parents: draft.parents,
      content: (draft.content as SyncDraftPayload).body,
      ...(extra.projectId && { projectId: extra.projectId }),
      ...(extra.events && { events: extra.events }),
    });
    const op: SyncOperation = {
      protocol: 'wevir-sync/1',
      vaultId: 'vault_synthetic',
      opId: record.opId,
      deviceId: 'device_source',
      deviceSeq: String(++deviceSeq),
      entityId: record.entityId,
      entityType,
      kind: record.kind,
      parents: record.parents,
      clientTime: '2026-11-13T00:00:00.000Z',
      ...(extra.origin && { origin: extra.origin }),
    };
    const materialize = await materials.prepareApply(op, record);
    storage.transaction(() => {
      storage.sync.putOperation({
        ...op,
        envelope: op,
        manifest: {},
        digest: sha256(jcs(record)),
        record,
        direction: 'inbox',
        state: 'applied',
      });
      materialize();
      storage.sync.applyHeads(op.vaultId, op.entityId, op.opId, op.parents);
    });
    return op;
  }
  return {
    home,
    storage,
    events,
    capture,
    materials,
    apply,
    vault: storage.sync.activeVault() as SyncVaultRecord,
  };
}
function draft(entityId: string, content: unknown): SyncDraftRecord {
  return {
    vaultId: 'vault_synthetic',
    opId: newId('sop'),
    entityId,
    kind: 'put',
    parents: [],
    content: { schema: 'wevir-sync-draft/1', body: content },
    createdAt: '2026-11-13T00:00:00.000Z',
  };
}

async function memoryConflictFixture(
  baseText: string,
  leftText: string | undefined,
  rightText: string,
) {
  const h = fixture();
  h.storage.sync.setScopes(h.vault.vaultId, { ...h.vault, categories: ['memory'] });
  const vault = h.storage.sync.activeVault() as SyncVaultRecord;
  const memory = new MemoryStore({ dir: join(h.home, 'memory') });
  let index = 0;
  const markdown = (text: string) =>
    `---\nname: synthetic-note\ndescription: Synthetic\ntype: project\nupdated: 2026-11-${12 + index++}T00:00:00.000Z\nupdated-by: user\n---\n\n${text}\n`;
  const change = (text: string | undefined, parents: string[] = []) => ({
    ...draft('memory_synthetic', {
      schema: 'wevir-memory/1',
      scope: 'global',
      name: 'synthetic-note',
      ...(text === undefined ? { deleted: true } : { markdown: markdown(text) }),
    }),
    parents,
    kind: text === undefined ? 'delete' : 'put',
  });
  const base = await h.apply(change(baseText), 'memory');
  const left = await h.apply(change(leftText, [base.opId]), 'memory');
  const right = await h.apply(change(rightText, [base.opId]), 'memory');
  const conflicts = new SyncMemoryConflicts({
    storage: h.storage,
    home: h.home,
    memoryDir: memory.dir,
    files: h.capture,
    materials: h.materials,
    eligible: () => h.storage.sync.activeVault(),
  });
  return { ...h, vault, memory, markdown, conflicts, base, left, right };
}

describe('untrusted synchronized packages', () => {
  it('replaces a fenced committed memory baseline but preserves a file edited after preparation', async () => {
    const h = await memoryConflictFixture('Base', 'Local', 'Remote');
    h.storage.transaction(() => {
      h.storage.sync.putSnapshotProof(h.vault.vaultId, 'job_snapshot_fence', {
        verified: 'synthetic',
      });
      h.storage.sync.putSnapshotRoot(
        h.vault.vaultId,
        'job_snapshot_fence',
        'memory_synthetic',
        'operation_pruned',
      );
    });
    const leaf = await h.apply(
      {
        ...draft('memory_synthetic', {
          schema: 'wevir-memory/1',
          scope: 'global',
          name: 'synthetic-note',
          markdown: h.markdown('Snapshot after gap'),
        }),
        parents: ['operation_pruned'],
      },
      'memory',
    );
    expect((await h.memory.read('global', undefined, 'synthetic-note')).content).toBe('Local');
    const record = packRecord.parse(
      h.storage.sync.getOperation(h.vault.vaultId, leaf.opId)?.record,
    );
    const materialize = await h.materials.prepareApply(leaf, record, {
      replaceRevision: h.left.opId,
    });
    h.storage.transaction(materialize);
    expect((await h.memory.read('global', undefined, 'synthetic-note')).content).toBe(
      'Snapshot after gap',
    );
    expect(leaf.parents).toEqual(['operation_pruned']);
    expect(h.storage.sync.getOperation(h.vault.vaultId, 'operation_pruned')).toBeUndefined();
    const next = { ...leaf, opId: newId('sop'), deviceSeq: '99' };
    const nextRecord = packRecord.parse({
      ...record,
      opId: next.opId,
      content: { ...(record.content as object), markdown: h.markdown('Later snapshot') },
    });
    const apply = await h.materials.prepareApply(next, nextRecord, { replaceRevision: leaf.opId });
    await writeFile(join(h.memory.dir, 'global/synthetic-note.md'), h.markdown('Unsubmitted edit'));
    h.storage.transaction(apply);
    expect((await h.memory.read('global', undefined, 'synthetic-note')).content).toBe(
      'Unsubmitted edit',
    );
    expect(h.storage.sync.entity(h.vault.vaultId, 'memory_synthetic')?.revision).toBe(leaf.opId);
    await h.capture.memory(h.vault, false, false);
    expect(h.storage.sync.drafts(h.vault.vaultId)[0]?.parents).toEqual([leaf.opId]);
  });

  it('does not present an old committed materialization as a newly authored branch', async () => {
    const h = await memoryConflictFixture('Base', 'Local', 'Remote');
    const base = packRecord.parse(
      h.storage.sync.getOperation(h.vault.vaultId, h.base.opId)?.record,
    );
    const markdown = (base.content as { markdown: string }).markdown;
    await writeFile(join(h.memory.dir, 'global/synthetic-note.md'), markdown);
    h.storage.transaction(() => {
      const entity = h.storage.sync.entity(h.vault.vaultId, 'memory_synthetic');
      if (!entity) throw new Error('missing materialized note');
      h.storage.sync.putEntity({ ...entity, revision: h.base.opId });
      h.storage.sync.putFileBaseline({
        vaultId: h.vault.vaultId,
        entityId: entity.entityId,
        entityType: 'memory',
        path: join(h.memory.dir, 'global/synthetic-note.md'),
        fingerprint: sha256(markdown),
        opId: h.base.opId,
      });
    });
    const preview = await h.conflicts.preview('memory_synthetic');
    expect(new Set(preview.expectedHeads)).toEqual(new Set([h.left.opId, h.right.opId]));
    expect(preview.localRevision).toBe(h.base.opId);
    const resolved = await h.conflicts.resolve({
      ...preview,
      markdown: h.markdown('Explicit merge'),
    });
    expect(h.storage.sync.draft(h.vault.vaultId, resolved.opId)?.parents).toEqual(
      preview.expectedHeads,
    );
    expect((await h.memory.read('global', undefined, 'synthetic-note')).content).toBe(
      'Explicit merge',
    );
  });

  it('merges independent memory edits with all causal parents and recovers the same resolution after file promotion rolls back', async () => {
    const h = await memoryConflictFixture(
      'Alpha\n\nMiddle\n\nOmega',
      'Local alpha\n\nMiddle\n\nOmega',
      'Alpha\n\nMiddle\n\nRemote omega',
    );
    const { vault, memory, conflicts, left, right } = h;
    const preview = await conflicts.preview('memory_synthetic');
    expect(preview.mergeState).toBe('clean');
    expect(preview.merged).toContain('Local alpha\n\nMiddle\n\nRemote omega');
    expect(new Set(preview.expectedHeads)).toEqual(new Set([left.opId, right.opId]));
    const putDraft = vi.spyOn(h.storage.sync, 'putDraft').mockImplementationOnce(() => {
      throw new Error('synthetic DB rollback');
    });
    await expect(conflicts.resolve({ ...preview, markdown: preview.merged })).rejects.toThrow(
      'synthetic DB rollback',
    );
    putDraft.mockRestore();
    const [pending] = h.storage.sync.localWrites(vault.vaultId);
    expect(pending).toMatchObject({ resolution: true, parents: preview.expectedHeads });
    expect((await memory.read('global', undefined, 'synthetic-note')).content).toBe(
      'Local alpha\n\nMiddle\n\nRemote omega',
    );
    await h.capture.recoverWrites(vault);
    const [resolution] = h.storage.sync.drafts(vault.vaultId);
    expect(resolution).toMatchObject({
      opId: pending?.id,
      kind: 'resolve',
      parents: preview.expectedHeads,
    });
    expect(h.storage.sync.localWrites(vault.vaultId)).toEqual([]);
    expect(h.storage.sync.getOperation(vault.vaultId, left.opId)?.record).toBeDefined();
    expect(h.storage.sync.getOperation(vault.vaultId, right.opId)?.record).toBeDefined();
    expect(
      h.storage.sync
        .materialJournals(vault.vaultId)
        .filter((journal) => journal.state === 'conflict'),
    ).toEqual([]);
  });

  it('keeps overlapping memory versions and refuses a stale preview after a new local edit', async () => {
    const h = await memoryConflictFixture('Base line', 'Local line', 'Remote line');
    const preview = await h.conflicts.preview('memory_synthetic');
    expect(preview.mergeState).toBe('conflict');
    expect(preview.merged).toBeUndefined();
    const note = await h.memory.read('global', undefined, 'synthetic-note');
    await h.memory.update('global', undefined, 'synthetic-note', note.revision, {
      content: 'New local edit',
    });
    await expect(
      h.conflicts.resolve({ ...preview, markdown: h.markdown('Manual merge') }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect((await h.memory.read('global', undefined, 'synthetic-note')).content).toBe(
      'New local edit',
    );
    expect(h.storage.sync.localWrites(h.vault.vaultId)).toEqual([]);
    expect(h.storage.sync.drafts(h.vault.vaultId).every((draft) => draft.kind !== 'resolve')).toBe(
      true,
    );
  });

  it('resolves deletion versus an edit only on explicit choice while retaining the edited revision', async () => {
    const h = await memoryConflictFixture('Base line', undefined, 'Remote edited line');
    const preview = await h.conflicts.preview('memory_synthetic');
    expect(preview.mergeState).toBe('conflict');
    expect(preview.merged).toBeUndefined();
    const resolved = await h.conflicts.resolve({ ...preview, deleted: true });
    expect(h.storage.sync.draft(h.vault.vaultId, resolved.opId)).toMatchObject({
      kind: 'resolve',
      parents: preview.expectedHeads,
      content: { body: { deleted: true } },
    });
    await expect(h.memory.read('global', undefined, 'synthetic-note')).rejects.toMatchObject({
      code: 'not_found',
    });
    expect(h.storage.sync.getOperation(h.vault.vaultId, h.right.opId)?.record).toMatchObject({
      content: { markdown: expect.stringContaining('Remote edited line') },
    });
  });

  it('keeps both histories when criss-cross resolutions have no unique three-way base', async () => {
    const h = await memoryConflictFixture('Base line', 'Local line', 'Remote line');
    for (const text of ['First cross merge', 'Second cross merge'])
      await h.apply(
        {
          ...draft('memory_synthetic', {
            schema: 'wevir-memory/1',
            scope: 'global',
            name: 'synthetic-note',
            markdown: h.markdown(text),
          }),
          kind: 'resolve',
          parents: [h.left.opId, h.right.opId],
        },
        'memory',
      );
    const preview = await h.conflicts.preview('memory_synthetic');
    expect(preview.mergeState).toBe('unavailable');
    expect(preview.base).toBeUndefined();
    expect(preview.merged).toBeUndefined();
    expect(preview.versions.map((version) => version.markdown)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('First cross merge'),
        expect.stringContaining('Second cross merge'),
      ]),
    );
  });

  it('retains the materialized project name on concurrent edits until a revision resolves both heads', async () => {
    const h = fixture();
    const projectId = 'project_synthetic';
    h.storage.transaction(() => h.storage.sync.bindProject(h.vault.vaultId, projectId));
    const change = (displayName: string, parents: string[] = []) => ({
      ...draft(projectId, { schema: 'wevir-project/1', projectId, displayName }),
      parents,
    });
    const base = await h.apply(change('Synthetic base'), 'project', { projectId });
    const left = await h.apply(change('Synthetic left', [base.opId]), 'project', { projectId });
    const right = await h.apply(change('Synthetic right', [base.opId]), 'project', { projectId });
    expect(h.storage.sync.projectName(h.vault.vaultId, projectId)).toBe('Synthetic left');
    expect(new Set(h.storage.sync.heads(h.vault.vaultId, projectId))).toEqual(
      new Set([left.opId, right.opId]),
    );
    const resolved = await h.apply(
      { ...change('Synthetic right', [left.opId, right.opId]), kind: 'resolve' },
      'project',
      { projectId },
    );
    expect(h.storage.sync.projectName(h.vault.vaultId, projectId)).toBe('Synthetic right');
    expect(h.storage.sync.heads(h.vault.vaultId, projectId)).toEqual([resolved.opId]);
  });

  it('keeps independent source streams as related histories instead of interleaving their events', async () => {
    const h = fixture();
    const at = '2026-11-13T00:00:00.000Z';
    h.storage.workspaces.insert({
      id: 'ws_synthetic',
      rootPath: h.home,
      displayName: 'Synthetic',
      createdAt: at,
      updatedAt: at,
    });
    h.storage.transaction(() =>
      h.storage.sync.bindProject('vault_synthetic', 'project_synthetic', 'ws_synthetic'),
    );
    const receive = async (streamId: string, text: string) => {
      const sessionId = 'ses_original';
      const origin = {
        hostId: 'device_source',
        sessionId,
        streamId,
        fromSeq: '1',
        throughSeq: '2',
      };
      const records = [
        {
          seq: 1,
          sessionId,
          ts: at,
          source: 'host',
          type: 'session.created',
          payload: {
            workspaceId: 'ws_source',
            cwd: '/synthetic/source',
            providerId: 'synthetic-api',
            modelId: 'synthetic-model',
          },
        },
        {
          seq: 2,
          sessionId,
          ts: at,
          source: 'host',
          type: 'user.message',
          payload: {
            turnId: `trn_${streamId.replaceAll('_', '')}`,
            content: [{ type: 'text', text }],
            sentBy: { deviceId: 'device_source', clientId: 'synthetic', clientKind: 'desktop' },
          },
        },
      ];
      for (const record of records) WevirEventSchema.parse(record);
      await h.apply(
        draft(`segment_${streamId}`, {
          schema: 'wevir-event-stream/1',
          sessionId,
          streamId,
          exclusions: [],
        }),
        'event-segment',
        {
          projectId: 'project_synthetic',
          origin,
          events: records.map((event) => ({
            seq: String(event.seq),
            sha256: sha256(jcs(event)),
            content: JSON.parse(jcs(event)),
          })),
        },
      );
    };
    await receive('stream_branchA', 'Synthetic first branch');
    await receive('stream_branchB', 'Synthetic concurrent branch');
    const sources = h.storage.sync.sources('vault_synthetic');
    expect(sources).toHaveLength(2);
    const first = sources.find((value) => value.streamId === 'stream_branchA')?.localSessionId;
    const second = sources.find((value) => value.streamId === 'stream_branchB')?.localSessionId;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    if (!first || !second) throw new Error('missing synthetic source');
    expect(h.storage.sessions.get(second)?.origin).toMatchObject({
      kind: 'synced',
      relatedTo: first,
    });
    expect(h.storage.sessions.get(second)?.forkedFrom).toBeUndefined();
    const usage = async (seq: number, contextUsed: number) => {
      const content = {
        sessionId: 'ses_original',
        seq,
        ts: at,
        source: 'engine',
        type: 'usage.updated',
        payload: { contextUsed, contextSize: 1000 },
      };
      await h.apply(
        draft(`segment_usage_${seq}`, {
          schema: 'wevir-event-stream/1',
          sessionId: 'ses_original',
          streamId: 'stream_branchA',
          exclusions: [],
        }),
        'event-segment',
        {
          projectId: 'project_synthetic',
          origin: {
            hostId: 'device_source',
            sessionId: 'ses_original',
            streamId: 'stream_branchA',
            fromSeq: String(seq),
            throughSeq: String(seq),
          },
          events: [{ seq: String(seq), sha256: sha256(jcs(content)), content }],
        },
      );
    };
    await usage(4, 300);
    expect(h.events.snapshot(first as `ses_${string}`)?.usage?.contextUsed).toBe(300);
    await usage(3, 100);
    expect(h.events.snapshot(first as `ses_${string}`)?.usage?.contextUsed).toBe(300);

    for (const [id, text] of [
      [first, 'Synthetic first branch'],
      [second, 'Synthetic concurrent branch'],
    ] as const) {
      const history = h.events
        .readSince(id as `ses_${string}`, 0)
        .filter((event) => event.type === 'user.message');
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({ payload: { content: [{ text }] } });
      expect(h.events.snapshot(id as `ses_${string}`)?.session.readOnly?.reason).toBe(
        'synchronized',
      );
    }
  });

  it('rejects malformed memory content before replacing a readable local note', async () => {
    const h = fixture();
    const memory = new MemoryStore({ dir: join(h.home, 'memory') });
    await memory.save('global', undefined, {
      name: 'synthetic-note',
      type: 'project',
      description: 'Synthetic',
      content: 'Preserved local note',
    });
    await expect(
      h.apply(
        draft('memory_synthetic', {
          schema: 'wevir-memory/1',
          scope: 'global',
          name: 'synthetic-note',
          markdown: 'Malformed remote frontmatter',
        }),
        'memory',
      ),
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' });
    expect((await memory.read('global', undefined, 'synthetic-note')).content).toBe(
      'Preserved local note',
    );
  });
  it('restores complete skill files and binary chunks without trusting scripts or selecting a concurrent chunk head', async () => {
    const first = fixture();
    const second = fixture();
    const path = join(first.home, 'synthetic-skill');
    await mkdir(join(path, 'scripts'), { recursive: true });
    await writeFile(join(path, 'SKILL.md'), '# Synthetic Skill\n');
    await writeFile(join(path, 'scripts/check.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    await writeFile(join(path, 'asset.bin'), Buffer.from([0, 255, 1, 128]));
    await writeFile(join(path, '.env'), 'SYNTHETIC_EXCLUDED=value');
    await first.capture.bundle(
      first.vault,
      { category: 'skill-bundle', localKey: 'skill:synthetic', name: 'Synthetic', path },
      false,
      true,
    );
    const drafts = first.storage.sync.drafts(first.vault.vaultId);
    const bundle = drafts.find(
      (value) =>
        first.storage.sync.entity(first.vault.vaultId, value.entityId)?.entityType ===
        'skill-bundle',
    );
    if (!bundle) throw new Error('missing captured bundle');
    for (const value of drafts.filter((value) => value !== bundle))
      await second.apply(value, 'artifact');
    const part = drafts.find((value) => value !== bundle);
    if (!part) throw new Error('missing captured chunk');
    const changed = {
      ...((part.content as SyncDraftPayload).body as object),
      data: Buffer.from('Concurrent').toString('base64url'),
      sha256: sha256(Buffer.from('Concurrent')),
    };
    await second.apply(draft(part.entityId, changed), 'artifact');
    await second.apply(bundle, 'skill-bundle');
    const restored = join(
      second.home,
      'sync/materials',
      second.vault.vaultId,
      bundle.entityId,
      bundle.opId,
    );
    expect(await readFile(join(restored, 'SKILL.md'), 'utf8')).toBe('# Synthetic Skill\n');
    expect(await readFile(join(restored, 'asset.bin'))).toEqual(Buffer.from([0, 255, 1, 128]));
    expect((await stat(join(restored, 'scripts/check.sh'))).mode & 0o111).toBe(0);
    expect((bundle.content as SyncDraftPayload).body).toMatchObject({ exclusions: ['.env'] });
    await expect(stat(join(restored, '.env'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects traversal, case collisions and symlink targets before publishing a materialized package', async () => {
    const h = fixture();
    const file = { path: 'safe', bytes: 0, sha256: sha256(Buffer.alloc(0)), parts: [] };
    const body = {
      schema: 'wevir-bundle/1',
      category: 'rule',
      name: 'Synthetic',
      files: [file],
      exclusions: [],
    };
    await expect(
      h.apply(
        draft('bundle_traversal', { ...body, files: [{ ...file, path: '../escape' }] }),
        'rule',
      ),
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' });
    await expect(
      h.apply(
        draft('bundle_collision', { ...body, files: [file, { ...file, path: 'SAFE' }] }),
        'rule',
      ),
    ).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' });
    const value = draft('bundle_symlink', body);
    const outside = join(h.home, 'protected');
    await writeFile(outside, 'Synthetic protected');
    const root = join(h.home, 'sync/materials', h.vault.vaultId, value.entityId, value.opId);
    await mkdir(root, { recursive: true });
    await symlink(outside, join(root, 'safe'));
    await expect(h.apply(value, 'rule')).rejects.toMatchObject({ code: 'INTEGRITY_FAILED' });
    expect(await readFile(outside, 'utf8')).toBe('Synthetic protected');
    expect(h.storage.sync.entity(h.vault.vaultId, value.entityId)).toBeUndefined();
  });
});
