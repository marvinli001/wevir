import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type SessionId,
  type SharedFile,
  SyncBundleContentSchema,
  SyncSharedFilesMetadataSchema,
  type WevirEventOf,
} from '@wevir/protocol';
import { jcs } from '@wevir/protocol/sync';
import type { Storage, SyncSourceRecord, SyncVaultRecord } from '@wevir/storage';
import { statWorkspaceFile } from '../workspace-files.js';
import { ZuvRequestError } from '../zuv/transport.js';
import { sha256 } from './crypto.js';
import type { SyncFilesCapture } from './files-capture.js';

export function sharedFilesKey(
  source: Pick<SyncSourceRecord, 'hostId' | 'sessionId' | 'streamId'> & { deviceId: string },
  seq: string,
): string {
  return `shared-files:${jcs([source.hostId, source.deviceId, source.sessionId, source.streamId, seq])}`;
}

export class SyncArtifacts {
  constructor(
    readonly options: {
      storage: Storage;
      home: string;
      files: SyncFilesCapture;
      eligible: () => SyncVaultRecord | undefined;
      source: (sessionId: string) => SyncSourceRecord | undefined;
    },
  ) {}

  async prepare(sessionId: SessionId, files: readonly SharedFile[]) {
    const vault = this.options.eligible();
    const session = this.options.storage.sessions.get(sessionId);
    const project = vault && session && this.#project(vault, session.workspaceId);
    if (
      !vault ||
      !session ||
      !project ||
      (session.origin !== undefined && session.origin.kind !== 'history') ||
      !vault.categories.includes('artifact') ||
      this.options.storage.sync.foreignSource(vault.vaultId, sessionId)
    )
      return;
    const commit = await this.options.files.prepareBundle(
      vault,
      {
        category: 'artifact',
        localKey: `shared-pending:${sessionId}`,
        path: session.cwd,
        paths: files.map((file) => file.path),
        name: 'Shared files',
        projectId: project.projectId,
      },
      false,
      false,
    );
    return (event: WevirEventOf<'file.shared'>) => {
      const current = this.options.eligible();
      if (
        !commit ||
        current?.vaultId !== vault.vaultId ||
        !current.categories.includes('artifact') ||
        !current.projectIds.includes(project.projectId)
      )
        return;
      const source = this.options.source(sessionId);
      if (!source?.deviceId) return;
      const ref = {
        hostId: source.hostId,
        deviceId: source.deviceId,
        sessionId: source.sessionId,
        streamId: source.streamId,
      };
      commit(sharedFilesKey(ref, String(event.seq)), {
        schema: 'wevir-shared-files/1',
        source: ref,
        seq: String(event.seq),
        capture: 'shared',
      });
    };
  }

  async scan(vault: SyncVaultRecord, initialize: boolean, includeHistory: boolean): Promise<void> {
    if (!vault.categories.includes('artifact')) return;
    this.options.storage.transaction(() => {
      for (const project of this.options.storage.sync.projects(vault.vaultId)) {
        if (!project.workspaceId || !vault.projectIds.includes(project.projectId)) continue;
        for (const session of this.options.storage.sessions.list({
          workspaceId: project.workspaceId,
          includeChildren: true,
          includeSide: true,
          archived: 'include',
        }))
          if (!session.origin || session.origin.kind === 'history') this.options.source(session.id);
      }
    });
    for (const source of this.options.storage.sync.sources(vault.vaultId)) {
      if (source.mirrored || !source.localSessionId || !source.deviceId) continue;
      const session = this.options.storage.sessions.get(source.localSessionId);
      const project = session && this.#project(vault, session.workspaceId);
      if (!session || !project || (session.origin && session.origin.kind !== 'history')) continue;
      const ref = {
        hostId: source.hostId,
        deviceId: source.deviceId,
        sessionId: source.sessionId,
        streamId: source.streamId,
      };
      let afterSeq = 0;
      while (true) {
        const shares = [
          ...this.options.storage.events.iterateTypes(session.id, ['file.shared'], {
            afterSeq,
            limit: 128,
          }),
        ];
        if (shares.length === 0) break;
        for (const event of shares) {
          afterSeq = event.seq;
          const key = sharedFilesKey(ref, String(event.seq));
          const entity = this.options.storage.sync.localEntity(vault.vaultId, key);
          if (entity?.revision || (entity && !(initialize && includeHistory))) continue;
          const files = (event.payload as WevirEventOf<'file.shared'>['payload']).files;
          await this.options.files.bundle(
            vault,
            {
              category: 'artifact',
              localKey: key,
              path: session.cwd,
              paths: files.map((file) => file.path),
              name: 'Shared files',
              projectId: project.projectId,
              metadata: {
                schema: 'wevir-shared-files/1',
                source: ref,
                seq: String(event.seq),
                capture: 'backfill',
              },
            },
            initialize,
            includeHistory,
          );
        }
      }
    }
  }

  async file(sessionId: string, path: string, seq?: number) {
    const { storage } = this.options;
    const session = storage.sessions.get(sessionId);
    if (session?.origin?.kind !== 'synced') return;
    const shares = storage.events.iterateTypes(sessionId, ['file.shared']);
    let selected: { origin: NonNullable<ReturnType<typeof storage.sync.sourceOrigin>> } | undefined;
    for (const event of shares) {
      if (seq !== undefined && event.seq !== seq) continue;
      const files = (event.payload as WevirEventOf<'file.shared'>['payload']).files;
      if (!files.some((file) => file.path === path)) continue;
      const origin = storage.sync.sourceOrigin(sessionId, event.seq);
      if (origin && (!selected || BigInt(origin.seq) > BigInt(selected.origin.seq)))
        selected = { origin };
    }
    if (!selected) return;
    const { origin } = selected;
    const entity = storage.sync.localEntity(origin.vaultId, sharedFilesKey(origin, origin.seq));
    const op = entity?.revision && storage.sync.getOperation(origin.vaultId, entity.revision);
    if (
      !entity ||
      !op ||
      op.state !== 'applied' ||
      op.deviceId !== origin.deviceId ||
      op.entityType !== 'artifact' ||
      op.direction !== 'inbox'
    )
      return;
    const record = op.record as { content: unknown; projectId?: string };
    const bundle = SyncBundleContentSchema.parse(record.content);
    const metadata = SyncSharedFilesMetadataSchema.parse(bundle.metadata);
    const expected = bundle.files.find((file) => file.path === path);
    const project = storage.sync
      .projects(origin.vaultId)
      .find((value) => value.projectId === record.projectId);
    if (
      !expected ||
      bundle.category !== 'artifact' ||
      project?.workspaceId !== session.workspaceId ||
      sharedFilesKey(metadata.source, metadata.seq) !== sharedFilesKey(origin, origin.seq)
    )
      return;
    const root = join(
      this.options.home,
      'sync/materials',
      origin.vaultId,
      entity.entityId,
      op.opId,
    );
    const file = await statWorkspaceFile(root, path);
    if (!file || file.size !== expected.bytes) return;
    if (sha256(await readFile(file.real)) !== expected.sha256)
      throw new ZuvRequestError('INTEGRITY_FAILED');
    return { root, file };
  }

  #project(vault: SyncVaultRecord, workspaceId: string) {
    return this.options.storage.sync
      .projects(vault.vaultId)
      .find(
        (project) =>
          project.workspaceId === workspaceId && vault.projectIds.includes(project.projectId),
      );
  }
}
