import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { lstat, mkdir, open, readFile, statfs } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  type SessionId,
  SyncBundleContentSchema,
  SyncChunkContentSchema,
  SyncEventStreamContentSchema,
  SyncMemoryContentSchema,
  SyncProjectContentSchema,
  SyncSessionContentSchema,
  type SyncStreamRef,
  UserImagePartSchema,
  type WevirEvent,
  WevirEventSchema,
  type WorkspaceId,
} from '@wevir/protocol';
import { jcs, type packRecord, type SyncOperation } from '@wevir/protocol/sync';
import type {
  SessionRecord,
  Storage,
  SyncMaterialJournalRecord,
  SyncSourceRecord,
  SyncVaultRecord,
} from '@wevir/storage';
import type { EpisodeChange } from '../episodes/service.js';
import type { EventStore } from '../event-store.js';
import { newId } from '../ids.js';
import type { ImageStore } from '../images.js';
import { validMemoryMarkdown } from '../memory.js';
import type { ZuvClient } from '../zuv/client.js';
import { ZuvRequestError } from '../zuv/transport.js';
import { sha256 } from './crypto.js';
import { SyncQueue } from './queue.js';
import { SyncSessionMaterials } from './session-materials.js';
import type { SyncSettings } from './settings.js';

type MaterialRecord = typeof packRecord._output;
const MISSING = 'missing';

export class SyncMaterials {
  readonly #storage: Storage;
  readonly #events: EventStore;
  readonly #home: string;
  readonly #memoryDir: string;
  readonly #images: ImageStore;
  readonly #queue: SyncQueue;
  readonly #settings: SyncSettings;
  readonly sessions: SyncSessionMaterials;
  readonly #changed = new Map<SessionId, number>();
  constructor(options: {
    storage: Storage;
    events: EventStore;
    home: string;
    memoryDir: string;
    images: ImageStore;
    settingsSync: SyncSettings;
    client: ZuvClient;
    eligible: () => SyncVaultRecord | undefined;
    nativeSource: (sessionId: string) => SyncSourceRecord | undefined;
    onEpisodeChanged?: (change: EpisodeChange) => void;
  }) {
    this.#storage = options.storage;
    this.#events = options.events;
    this.#home = options.home;
    this.#memoryDir = options.memoryDir;
    this.#images = options.images;
    this.#queue = new SyncQueue(options.storage);
    this.#settings = options.settingsSync;
    this.sessions = new SyncSessionMaterials({
      ...options,
      ensureSource: (vaultId, source, projectId) => this.#ensureSource(vaultId, source, projectId),
    });
  }

  notify(): void {
    for (const [sessionId, afterSeq] of this.#changed) {
      const events = this.#events.readSince(sessionId, afterSeq);
      if (events.length) this.#events.projectionChanged(events);
    }
    this.#changed.clear();
    this.sessions.notify();
  }

  async prepareApply(op: SyncOperation, record: MaterialRecord): Promise<() => void> {
    try {
      if (op.entityType === 'project') {
        const body = SyncProjectContentSchema.parse(record.content);
        if (body.projectId !== op.entityId || body.projectId !== record.projectId)
          throw new ZuvRequestError('INTEGRITY_FAILED');
        return () => {
          this.#storage.sync.setProjectName(op.vaultId, body.projectId, body.displayName);
          this.#entity(op, `project:${body.projectId}`, record);
        };
      }
      if (op.entityType === 'session') {
        const raw = record.content as { schema?: string; source?: unknown };
        if (raw.source || raw.schema !== 'wevir-session/1')
          return await this.sessions.prepare(op, record);
        const body = SyncSessionContentSchema.parse(record.content);
        return () => {
          this.#entity(op, `remote-session:${op.deviceId}:${body.sessionId}`, record, false);
          for (const source of this.#storage.sync
            .sources(op.vaultId)
            .filter(
              (value) =>
                value.mirrored &&
                value.sessionId === body.sessionId &&
                value.deviceId === op.deviceId,
            )) {
            if (source.localSessionId)
              this.#storage.sessions.update(source.localSessionId, {
                title: body.title,
                titleSource: body.titleSource,
              });
          }
        };
      }
      if (op.entityType === 'event-segment') return this.#prepareEvents(op, record);
      if (op.entityType === 'memory') return await this.#prepareMemory(op, record);
      if (op.entityType === 'settings') return await this.#settings.prepare(op, record);
      const raw = record.content as { schema?: string };
      if (raw?.schema === 'wevir-chunk/1' && op.entityType === 'artifact')
        return await this.#prepareChunk(op, record);
      if (raw?.schema === 'wevir-bundle/1') return await this.#prepareBundle(op, record);
      if (op.kind === 'delete')
        return () => {
          this.#entity(op, `deleted:${op.entityId}`, record, false);
        };
      throw new ZuvRequestError('UPGRADE_REQUIRED');
    } catch (error) {
      if (error instanceof ZuvRequestError) throw error;
      if (error && typeof error === 'object' && 'issues' in error)
        throw new ZuvRequestError('INTEGRITY_FAILED');
      throw error;
    }
  }

  #entity(op: SyncOperation, localKey: string, record: MaterialRecord, materialized = true): void {
    const old = this.#storage.sync.entity(op.vaultId, op.entityId);
    const owner = this.#storage.sync.localEntity(op.vaultId, localKey);
    const canAdvance =
      !old?.revision || op.parents.includes(old.revision) || old.revision === op.opId;
    this.#storage.sync.putEntity({
      vaultId: op.vaultId,
      entityId: op.entityId,
      entityType: op.entityType,
      ...(record.projectId && { projectId: record.projectId }),
      localKey: old?.localKey ?? localKey,
      revision: canAdvance ? op.opId : old?.revision,
      fingerprint: canAdvance
        ? sha256(
            jcs({ kind: op.kind, content: { schema: 'wevir-sync-draft/1', body: record.content } }),
          )
        : old?.fingerprint,
      materialized:
        old?.materialized === true || (materialized && (!owner || owner.entityId === op.entityId)),
    });
  }

  #workspace(vaultId: string, projectId: string | undefined) {
    const mapping = this.#storage.sync
      .projects(vaultId)
      .find((value) => value.projectId === projectId);
    const workspace = mapping?.workspaceId && this.#storage.workspaces.get(mapping.workspaceId);
    if (!workspace || workspace.removedAt) throw new ZuvRequestError('RECOVERY_REQUIRED');
    return workspace;
  }

  #prepareEvents(op: SyncOperation, record: MaterialRecord): () => void {
    const body = SyncEventStreamContentSchema.parse(record.content);
    const origin = op.origin;
    if (
      !origin ||
      body.sessionId !== origin.sessionId ||
      body.streamId !== origin.streamId ||
      !record.events
    )
      throw new ZuvRequestError('INTEGRITY_FAILED');
    const workspace = this.#workspace(op.vaultId, record.projectId);
    const decoded = record.events.map((entry) => {
      const value = entry.content as {
        type?: string;
        payload?: { omitted?: boolean };
        sessionId?: string;
        seq?: number;
      };
      if (value.sessionId !== origin.sessionId || String(value.seq) !== entry.seq)
        throw new ZuvRequestError('INTEGRITY_FAILED');
      const previous = this.#storage.sync.sourceFingerprint(
        op.vaultId,
        origin.hostId,
        origin.sessionId,
        origin.streamId,
        entry.seq,
      );
      if (previous !== undefined && previous !== entry.sha256)
        throw new ZuvRequestError('INTEGRITY_FAILED');
      const event =
        value.type === 'engine.raw' && value.payload?.omitted === true
          ? undefined
          : WevirEventSchema.parse(entry.content);
      return { entry, event, alreadyApplied: previous !== undefined };
    });
    return () => {
      let source = this.#storage.sync
        .sources(op.vaultId)
        .find(
          (value) =>
            value.hostId === origin.hostId &&
            value.sessionId === origin.sessionId &&
            value.streamId === origin.streamId,
        );
      if (source && !source.mirrored) {
        for (const value of decoded)
          this.#storage.sync.sourceEvent(source, value.entry.seq, value.entry.sha256);
        return;
      }
      if (!source) {
        const related = this.#storage.sync
          .sources(op.vaultId)
          .find(
            (value) =>
              value.mirrored &&
              value.sessionId === origin.sessionId &&
              value.deviceId === op.deviceId &&
              value.localSessionId,
          );
        const localSessionId = related?.localSessionId ?? newId('ses');
        source = {
          vaultId: op.vaultId,
          hostId: origin.hostId,
          sessionId: origin.sessionId,
          streamId: origin.streamId,
          localSessionId,
          mirrored: true,
          deviceId: op.deviceId,
        };
        if (!related)
          this.#createMirror(
            source,
            workspace.id,
            workspace.rootPath,
            decoded.find((value) => value.event?.type === 'session.created')?.event,
          );
        this.#storage.sync.putSource(source);
      }
      const localId = source.localSessionId as SessionId;
      for (const { entry, event, alreadyApplied } of decoded) {
        if (
          alreadyApplied ||
          this.#storage.sync.sourceFingerprint(
            op.vaultId,
            origin.hostId,
            origin.sessionId,
            origin.streamId,
            entry.seq,
          ) === entry.sha256
        )
          continue;
        let localSeq: number | undefined;
        if (event?.type === 'session.created') localSeq = 1;
        if (event && event.type !== 'session.created' && event.type !== 'engine.raw') {
          if (
            source.mirrored &&
            !this.#storage.sync.entity(op.vaultId, origin.sessionId)?.revision
          ) {
            if (event.type === 'session.title_changed')
              this.#storage.sessions.update(localId, {
                title: event.payload.title,
                titleSource: event.payload.source,
              });
            if (event.type === 'session.configured')
              this.#storage.sessions.update(localId, { modelId: event.payload.modelId });
          }
          localSeq = this.#storage.events.lastSeq(localId) + 1;
          const local = { ...event, sessionId: localId, seq: localSeq } as WevirEvent;
          this.#storage.events.insert(local);
          this.#mark(local);
        }
        this.#storage.sync.sourceEvent(source, entry.seq, entry.sha256, localSeq);
      }
      this.#storage.sessions.update(localId, {
        state: 'closed',
        lastSeq: this.#storage.events.lastSeq(localId),
        activeTurn: null,
        updatedAt: op.clientTime,
      });
      this.sessions.reconcile(op.vaultId);
      this.#entity(
        op,
        `event-segment:${origin.hostId}:${origin.streamId}:${origin.fromSeq}:${origin.throughSeq}`,
        record,
        false,
      );
    };
  }

  #ensureSource(vaultId: string, ref: SyncStreamRef, projectId: string): SyncSourceRecord {
    if (!this.#storage.db.isTransaction)
      throw new Error('sync source projection requires a transaction');
    const workspace = this.#workspace(vaultId, projectId);
    const existing = this.#storage.sync
      .sources(vaultId)
      .find(
        (value) =>
          value.hostId === ref.hostId &&
          value.sessionId === ref.sessionId &&
          value.streamId === ref.streamId,
      );
    if (existing) {
      const local = existing.localSessionId && this.#storage.sessions.get(existing.localSessionId);
      if (existing.deviceId !== ref.deviceId || (local && local.workspaceId !== workspace.id))
        throw new ZuvRequestError('INTEGRITY_FAILED');
      return existing;
    }
    const related = this.#storage.sync
      .sources(vaultId)
      .find(
        (value) =>
          value.hostId === ref.hostId &&
          value.deviceId === ref.deviceId &&
          value.sessionId === ref.sessionId &&
          value.localSessionId &&
          this.#storage.sessions.get(value.localSessionId),
      );
    const source: SyncSourceRecord = {
      vaultId,
      ...ref,
      localSessionId: related?.localSessionId ?? newId('ses'),
      mirrored: related?.mirrored ?? true,
    };
    if (!related) this.#createMirror(source, workspace.id, workspace.rootPath);
    this.#storage.sync.putSource(source);
    return source;
  }

  #createMirror(
    source: SyncSourceRecord,
    workspaceId: string,
    cwd: string,
    first?: WevirEvent,
  ): void {
    const created = first?.type === 'session.created' ? first.payload : undefined;
    const id = source.localSessionId as SessionId;
    const now = first?.ts ?? new Date().toISOString();
    const session: SessionRecord = {
      id,
      workspaceId,
      cwd,
      engine: 'sync',
      engineSessionId: newId('synce'),
      providerId: created?.providerId ?? 'sync',
      modelId: created?.modelId ?? 'sync',
      title: '',
      titleSource: 'first_prompt',
      ...(created?.side && { side: true as const }),
      state: 'closed',
      lastSeq: 2,
      createdAt: now,
      updatedAt: now,
      origin: {
        kind: 'synced',
        vaultId: source.vaultId,
        hostId: source.hostId,
        sessionId: source.sessionId,
        streamId: source.streamId,
      },
    };
    this.#storage.sessions.insert(session);
    const start: WevirEvent = {
      sessionId: id,
      seq: 1,
      ts: now,
      type: 'session.created',
      source: 'host',
      payload: {
        workspaceId: workspaceId as WorkspaceId,
        cwd,
        providerId: session.providerId,
        modelId: session.modelId,
      },
    };
    const readonly: WevirEvent = {
      sessionId: id,
      seq: 2,
      ts: now,
      type: 'session.read_only',
      source: 'host',
      payload: { reason: 'synchronized', message: 'Synced history' },
    };
    this.#storage.events.insert(start);
    this.#storage.events.insert(readonly);
    this.#mark(start);
    this.#mark(readonly);
    const metadata = this.#storage.sync
      .heads(source.vaultId, source.sessionId)
      .map(
        (opId) =>
          this.#storage.sync.getOperation(source.vaultId, opId)?.record as
            | MaterialRecord
            | undefined,
      )
      .find((value) => (value?.content as { schema?: string })?.schema === 'wevir-session/1');
    if (metadata) {
      const body = SyncSessionContentSchema.parse(metadata.content);
      this.#storage.sessions.update(id, { title: body.title, titleSource: body.titleSource });
    }
  }

  async #prepareMemory(op: SyncOperation, record: MaterialRecord): Promise<() => void> {
    const body = SyncMemoryContentSchema.parse(record.content);
    if (
      !['put', 'delete', 'resolve'].includes(op.kind) ||
      (op.kind === 'delete' && !body.deleted) ||
      (body.deleted
        ? body.markdown !== undefined
        : body.markdown === undefined || !validMemoryMarkdown(body.scope, body.name, body.markdown))
    )
      throw new ZuvRequestError('INTEGRITY_FAILED');
    if ((body.scope === 'project') !== Boolean(record.projectId))
      throw new ZuvRequestError('INTEGRITY_FAILED');
    const workspaceId = record.projectId
      ? this.#workspace(op.vaultId, record.projectId).id
      : undefined;
    const directory = workspaceId
      ? join(this.#memoryDir, 'projects', workspaceId)
      : join(this.#memoryDir, 'global');
    const target = join(directory, `${body.name}.md`);
    const localKey = `memory:${workspaceId ?? 'global'}:${body.name}`;
    await this.#safeDirectory(directory, this.#memoryDir);
    const current = await this.#file(target);
    const currentHash = current === undefined ? MISSING : sha256(current);
    const local = this.#storage.sync.localEntity(op.vaultId, localKey);
    const baseline = local && this.#storage.sync.fileBaseline(op.vaultId, local.entityId);
    if (local && baseline && currentHash !== baseline.fingerprint) {
      this.#storage.transaction(() => {
        const changed = this.#queue.enqueue({
          vaultId: op.vaultId,
          entityId: local.entityId,
          entityType: 'memory',
          localKey,
          ...(record.projectId && { projectId: record.projectId }),
          kind: current === undefined ? 'delete' : 'put',
          content: {
            ...body,
            ...(current === undefined
              ? { markdown: undefined, deleted: true }
              : {
                  markdown: new TextDecoder('utf-8', { fatal: true }).decode(current),
                  deleted: false,
                }),
          },
        });
        this.#storage.sync.putFileBaseline({
          vaultId: op.vaultId,
          entityId: local.entityId,
          entityType: 'memory',
          ...(record.projectId && { projectId: record.projectId }),
          path: target,
          fingerprint: currentHash,
          ...(changed && { opId: changed }),
        });
      });
    }
    const next =
      op.kind === 'delete' || body.deleted ? undefined : Buffer.from(body.markdown ?? '', 'utf8');
    const nextHash = next === undefined ? MISSING : sha256(next);
    const oldJournal = this.#storage.sync.materialJournal(op.vaultId, op.opId);
    const staged =
      oldJournal?.stagedPath ?? (next === undefined ? undefined : await this.#stage(op, next));
    const journal: SyncMaterialJournalRecord = oldJournal ?? {
      vaultId: op.vaultId,
      opId: op.opId,
      entityId: op.entityId,
      localKey,
      targetPath: target,
      ...(staged && { stagedPath: staged }),
      previousHash: currentHash,
      nextHash,
      state: 'staged',
    };
    this.#storage.sync.putMaterialJournal(journal);
    return () => {
      const material = this.#storage.sync.localEntity(op.vaultId, localKey);
      const owner = this.#storage.sync.owner(localKey);
      const parentMatches =
        !material?.revision ||
        material.revision === op.opId ||
        op.parents.includes(material.revision);
      const actual = this.#fileSync(target);
      const actualHash = actual === undefined ? MISSING : sha256(actual);
      const conflict =
        (owner !== undefined && owner !== op.vaultId) ||
        (material && material.entityId !== op.entityId) ||
        !parentMatches ||
        (actualHash !== journal.previousHash && actualHash !== nextHash);
      if (conflict) {
        this.#entity(op, localKey, record, false);
        this.#storage.sync.putMaterialJournal({ ...journal, state: 'conflict' });
        return;
      }
      let backup = journal.backupPath;
      if (actualHash !== nextHash) {
        const backupDir = join(this.#home, 'sync/versions', op.vaultId);
        mkdirSync(backupDir, { recursive: true, mode: 0o700 });
        if (actual !== undefined) {
          backup = join(backupDir, `${op.opId}.bin`);
          if (!existsSync(backup)) copyFileSync(target, backup);
        }
        if (next === undefined) {
          if (actual !== undefined) unlinkSync(target);
        } else renameSync(staged as string, target);
      }
      this.#storage.sync.claimResource(localKey, op.vaultId);
      this.#entity(op, localKey, record);
      this.#storage.sync.putFileBaseline({
        vaultId: op.vaultId,
        entityId: op.entityId,
        entityType: 'memory',
        ...(record.projectId && { projectId: record.projectId }),
        path: target,
        fingerprint: nextHash,
        opId: op.opId,
      });
      this.#storage.sync.putMaterialJournal({
        ...journal,
        ...(backup && { backupPath: backup }),
        state: 'applied',
      });
    };
  }

  #mark(event: WevirEvent): void {
    this.#changed.set(
      event.sessionId,
      Math.min(this.#changed.get(event.sessionId) ?? event.seq - 1, event.seq - 1),
    );
  }

  async #prepareChunk(op: SyncOperation, record: MaterialRecord): Promise<() => void> {
    const body = SyncChunkContentSchema.parse(record.content);
    const bytes = Buffer.from(body.data, 'base64url');
    if (bytes.toString('base64url') !== body.data || sha256(bytes) !== body.sha256)
      throw new ZuvRequestError('INTEGRITY_FAILED');
    await this.#stage(op, bytes);
    return () => this.#entity(op, `chunk:${op.entityId}`, record, false);
  }

  async #prepareBundle(op: SyncOperation, record: MaterialRecord): Promise<() => void> {
    const body = SyncBundleContentSchema.parse(record.content);
    if (body.category !== op.entityType) throw new ZuvRequestError('INTEGRITY_FAILED');
    const root = join(this.#home, 'sync/materials', op.vaultId, op.entityId, op.opId);
    await this.#safeDirectory(root, join(this.#home, 'sync'));
    const disk = await statfs(root, { bigint: true });
    if (
      disk.bavail * disk.bsize <
      BigInt(body.files.reduce((total, file) => total + file.bytes, 16 * 1024 * 1024))
    )
      throw Object.assign(new Error('sync material disk full'), { code: 'ENOSPC' });
    const paths = new Set<string>();
    for (const file of body.files) {
      const target = resolve(root, file.path);
      const localPath = relative(root, target);
      const folded = file.path.normalize('NFC').toLowerCase();
      if (
        isAbsolute(localPath) ||
        localPath === '..' ||
        localPath.startsWith(`..${sep}`) ||
        paths.has(folded)
      )
        throw new ZuvRequestError('INTEGRITY_FAILED');
      paths.add(folded);
      await this.#safeDirectory(dirname(target), root);
      const existing = await lstat(target).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return undefined;
      });
      if (existing && (!existing.isFile() || existing.isSymbolicLink()))
        throw new ZuvRequestError('INTEGRITY_FAILED');
      const output = await open(target, 'w', 0o600);
      const digest = createHash('sha256');
      let length = 0;
      try {
        for (const part of file.parts) {
          const stored = this.#storage.sync.getOperation(op.vaultId, part.opId);
          if (
            !stored ||
            stored.entityId !== part.entityId ||
            stored.projectId !== record.projectId ||
            !['applied', 'committed'].includes(stored.state)
          )
            throw new ZuvRequestError('MISSING_PARENT');
          const chunk = SyncChunkContentSchema.parse((stored.record as MaterialRecord).content);
          if (chunk.ownerId !== op.entityId) throw new ZuvRequestError('INTEGRITY_FAILED');
          const bytes = Buffer.from(chunk.data, 'base64url');
          digest.update(bytes);
          length += bytes.length;
          if (length > file.bytes) throw new ZuvRequestError('INTEGRITY_FAILED');
          await output.writeFile(bytes);
        }
        if (length !== file.bytes || digest.digest('base64url') !== file.sha256)
          throw new ZuvRequestError('INTEGRITY_FAILED');
        await output.sync();
      } finally {
        await output.close();
      }
    }
    const metadata = body.metadata as { schema?: string; part?: unknown } | undefined;
    if (op.entityType === 'artifact' && metadata?.schema === 'wevir-image/1') {
      const part = UserImagePartSchema.parse(metadata.part);
      if (
        body.files.length !== 1 ||
        body.name !== part.imageId ||
        !(await this.#images.importSynced(part, resolve(root, body.files[0]?.path as string)))
      )
        throw new ZuvRequestError('INTEGRITY_FAILED');
    }
    return () => {
      this.#entity(op, `bundle:${op.entityId}`, record, false);
    };
  }

  async #stage(op: SyncOperation, bytes: Uint8Array): Promise<string> {
    const directory = join(this.#home, 'sync/staging', op.vaultId);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const target = join(directory, `${op.opId}.bin`);
    if (existsSync(target)) {
      if (sha256(await readFile(target)) !== sha256(bytes))
        throw new ZuvRequestError('INTEGRITY_FAILED');
      return target;
    }
    const temporary = join(directory, `.${op.opId}.${newId('tmp')}`);
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    renameSync(temporary, target);
    return target;
  }
  async #safeDirectory(path: string, root: string): Promise<void> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const anchor = await lstat(root);
    if (!anchor.isDirectory() || anchor.isSymbolicLink())
      throw new ZuvRequestError('INTEGRITY_FAILED');
    const relative = path.slice(root.length);
    let current = root;
    for (const part of relative.split(/[\\/]/).filter(Boolean)) {
      current = join(current, part);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory())
          throw new ZuvRequestError('INTEGRITY_FAILED');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        await mkdir(current, { mode: 0o700 });
      }
    }
  }
  async #file(path: string): Promise<Buffer | undefined> {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024)
        throw new ZuvRequestError('INTEGRITY_FAILED');
      return await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }
  #fileSync(path: string): Buffer | undefined {
    if (!existsSync(path)) return undefined;
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024)
      throw new ZuvRequestError('INTEGRITY_FAILED');
    return readFileSync(path);
  }
}
