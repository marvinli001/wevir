import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join } from 'node:path';
import { SyncMemoryContentSchema } from '@wevir/protocol';
import { packRecord } from '@wevir/protocol/sync';
import type {
  Storage,
  SyncEntityRecord,
  SyncLocalWriteRecord,
  SyncVaultRecord,
} from '@wevir/storage';
import { newId } from '../ids.js';
import { validMemoryMarkdown } from '../memory.js';
import { ZuvRequestError } from '../zuv/transport.js';
import { sha256 } from './crypto.js';
import type { SyncFilesCapture } from './files-capture.js';
import type { SyncMaterials } from './materials.js';
import type { SyncDraftPayload } from './queue.js';
import { markMemoryResolution, mergeMemoryText } from './text-merge.js';

type Body = typeof SyncMemoryContentSchema._output;
interface MemoryConflictOptions {
  storage: Storage;
  home: string;
  memoryDir: string;
  files: SyncFilesCapture;
  materials: SyncMaterials;
  eligible: () => SyncVaultRecord | undefined;
}
interface Selection {
  entityId: string;
  expectedHeads: string[];
  localRevision: string;
  fileFingerprint: string;
  markdown?: string;
  deleted?: boolean;
}

export class SyncMemoryConflicts {
  readonly #options: MemoryConflictOptions;
  constructor(options: MemoryConflictOptions) {
    this.#options = options;
  }
  list(after?: string) {
    const vault = this.#vault();
    const entries = this.#options.storage.sync.memoryConflictEntities(
      vault.vaultId,
      vault.projectIds,
      after,
    );
    const conflicts = entries.slice(0, 100).flatMap((entity) => {
      let heads: string[];
      try {
        heads = this.#heads(vault, entity);
      } catch (error) {
        if (!(error instanceof ZuvRequestError) || error.code !== 'RECOVERY_REQUIRED') throw error;
        heads = this.#options.storage.sync.heads(vault.vaultId, entity.entityId);
      }
      if (heads.length < 2) return [];
      if (heads.length > 32) throw new ZuvRequestError('QUOTA_EXCEEDED');
      return [
        {
          entityId: entity.entityId,
          name: entity.localKey.split(':').at(-1) as string,
          scope: entity.projectId ? ('project' as const) : ('global' as const),
          ...(entity.projectId && { projectId: entity.projectId }),
          heads,
        },
      ];
    });
    return { conflicts, ...(entries.length > 100 && { next: entries[99]?.entityId }) };
  }

  async preview(entityId: string) {
    const vault = this.#vault();
    await this.#options.files.recoverWrites(vault);
    await this.#options.files.memory(vault, false, false);
    const snapshot = this.#snapshot(vault, entityId);
    const path = this.#path(vault, snapshot.entity, snapshot.versions[0]?.content as Body);
    const fileFingerprint = await this.#fingerprint(path);
    const baseId =
      snapshot.heads.length === 2 ? this.#base(vault, entityId, snapshot.heads) : undefined;
    const base = baseId ? this.#revision(vault.vaultId, entityId, baseId) : undefined;
    let merged: string | undefined;
    if (
      base &&
      !base.content.deleted &&
      snapshot.versions.every((version) => !version.content.deleted)
    ) {
      merged = await mergeMemoryText(
        this.#options.home,
        base.content.markdown as string,
        snapshot.versions[0]?.content.markdown as string,
        snapshot.versions[1]?.content.markdown as string,
      );
      if (
        merged !== undefined &&
        (Buffer.byteLength(merged) > 128 * 1024 ||
          !validMemoryMarkdown(base.content.scope, base.content.name, merged))
      )
        merged = undefined;
    }
    this.#check(vault, snapshot.entity, snapshot.heads, snapshot.entity.revision as string);
    if (fileFingerprint !== (await this.#fingerprint(path)))
      throw new ZuvRequestError('REVISION_CONFLICT');
    return {
      entityId,
      name: snapshot.versions[0]?.content.name as string,
      scope: snapshot.versions[0]?.content.scope as Body['scope'],
      expectedHeads: snapshot.heads,
      localRevision: snapshot.entity.revision as string,
      fileFingerprint,
      versions: snapshot.versions.map(({ content, ...revision }) => ({
        ...revision,
        markdown: content.markdown,
        deleted: content.deleted,
      })),
      ...(base && {
        base: {
          opId: base.opId,
          parents: base.parents,
          markdown: base.content.markdown,
          deleted: base.content.deleted,
        },
      }),
      ...(merged !== undefined && { merged }),
      mergeState:
        merged !== undefined
          ? ('clean' as const)
          : base
            ? ('conflict' as const)
            : ('unavailable' as const),
    };
  }

  async resolve(input: Selection) {
    const vault = this.#vault();
    const { storage, files, materials } = this.#options;
    await files.recoverWrites(vault);
    await files.memory(vault, false, false);
    const snapshot = this.#snapshot(vault, input.entityId);
    this.#check(vault, snapshot.entity, input.expectedHeads, input.localRevision);
    const original = this.#revision(vault.vaultId, input.entityId, input.localRevision).content;
    const content: Body = {
      schema: 'wevir-memory/1',
      scope: original.scope,
      name: original.name,
      ...(input.deleted
        ? { deleted: true }
        : {
            markdown:
              input.markdown === undefined ? undefined : markMemoryResolution(input.markdown),
          }),
    };
    if (
      (input.deleted && input.markdown !== undefined) ||
      (!input.deleted &&
        (content.markdown === undefined ||
          Buffer.byteLength(content.markdown) > 128 * 1024 ||
          !validMemoryMarkdown(content.scope, content.name, content.markdown)))
    )
      throw new ZuvRequestError('INVALID_REQUEST');
    const path = this.#path(vault, snapshot.entity, content);
    if ((await this.#fingerprint(path)) !== input.fileFingerprint)
      throw new ZuvRequestError('REVISION_CONFLICT');
    const intent: SyncLocalWriteRecord = {
      id: newId('sop'),
      vaultId: vault.vaultId,
      entityId: input.entityId,
      entityType: 'memory',
      ...(snapshot.entity.projectId && { projectId: snapshot.entity.projectId }),
      localKey: snapshot.entity.localKey,
      path,
      content,
      kind: input.deleted ? 'delete' : 'put',
      parents: snapshot.heads,
      nextHash: input.deleted ? 'missing' : sha256(Buffer.from(content.markdown as string)),
      state: 'pending',
      resolution: true,
    };
    storage.transaction(() => {
      this.#check(vault, snapshot.entity, input.expectedHeads, input.localRevision);
      storage.sync.putLocalWrite(intent);
    });
    let applying = false;
    try {
      const revision = {
        vaultId: vault.vaultId,
        opId: intent.id,
        entityId: input.entityId,
        entityType: 'memory' as const,
        deviceId: vault.deviceId,
        kind: 'resolve' as const,
        parents: intent.parents,
        clientTime: new Date().toISOString(),
      };
      const apply = await materials.prepareApply(
        revision,
        packRecord.parse({
          opId: intent.id,
          entityId: input.entityId,
          kind: 'resolve',
          parents: intent.parents,
          ...(intent.projectId && { projectId: intent.projectId }),
          content,
        }),
        { replaceRevision: input.localRevision },
      );
      storage.transaction(() => {
        this.#check(vault, snapshot.entity, input.expectedHeads, input.localRevision);
        applying = true;
        apply();
        if (storage.sync.materialJournal(vault.vaultId, intent.id)?.state !== 'applied')
          throw new ZuvRequestError('REVISION_CONFLICT');
        files.finishWrite(intent);
      });
      return { opId: intent.id };
    } catch (error) {
      // A promoted file can outlive a rolled-back DB transaction; its stable intent must survive.
      if (!applying) storage.sync.abandonLocalWrite(intent.id);
      throw error;
    }
  }

  #vault(): SyncVaultRecord {
    const vault = this.#options.eligible();
    if (!vault?.categories.includes('memory')) throw new ZuvRequestError('SCOPE_DISABLED');
    return vault;
  }
  #snapshot(vault: SyncVaultRecord, entityId: string) {
    const entity = this.#options.storage.sync.entity(vault.vaultId, entityId);
    if (
      entity?.entityType !== 'memory' ||
      !entity.revision ||
      !entity.materialized ||
      (entity.projectId && !vault.projectIds.includes(entity.projectId)) ||
      this.#options.storage.sync.owner(entity.localKey) !== vault.vaultId
    )
      throw new ZuvRequestError('SCOPE_DISABLED');
    const heads = this.#heads(vault, entity);
    if (heads.length < 2) throw new ZuvRequestError('REVISION_CONFLICT');
    if (heads.length > 32) throw new ZuvRequestError('QUOTA_EXCEEDED');
    const versions = heads.map((head) => this.#revision(vault.vaultId, entityId, head));
    const first = versions[0]?.content as Body;
    if (
      versions.some(({ content }) => content.name !== first.name || content.scope !== first.scope)
    )
      throw new ZuvRequestError('INTEGRITY_FAILED');
    return { entity, heads, versions };
  }
  #check(vault: SyncVaultRecord, entity: SyncEntityRecord, heads: string[], revision: string) {
    const current = this.#vault();
    const local = this.#options.storage.sync.entity(vault.vaultId, entity.entityId);
    const actual = this.#heads(vault, entity);
    if (
      current.vaultId !== vault.vaultId ||
      current.deviceId !== vault.deviceId ||
      current.revision !== vault.revision ||
      local?.revision !== revision ||
      actual.length !== heads.length ||
      actual.some((head) => !heads.includes(head))
    )
      throw new ZuvRequestError('REVISION_CONFLICT');
  }
  #heads(vault: SyncVaultRecord, entity: SyncEntityRecord): string[] {
    const heads = this.#options.storage.sync.heads(vault.vaultId, entity.entityId);
    if (entity.revision && !heads.includes(entity.revision)) {
      const operation = this.#options.storage.sync.getOperation(vault.vaultId, entity.revision);
      const draft = this.#options.storage.sync.draft(vault.vaultId, entity.revision);
      if (
        !draft &&
        !(operation?.direction === 'outbox' && ['queued', 'pending'].includes(operation.state))
      )
        return heads;
      const ancestors = this.#ancestors(vault.vaultId, entity.entityId, entity.revision);
      if (!ancestors) throw new ZuvRequestError('RECOVERY_REQUIRED');
      return [...heads.filter((head) => !ancestors.has(head)), entity.revision].sort();
    }
    return heads;
  }
  #revision(vaultId: string, entityId: string, opId: string) {
    const { storage } = this.#options;
    const op = storage.sync.getOperation(vaultId, opId);
    const draft = op ? undefined : storage.sync.draft(vaultId, opId);
    if (
      (op && (op.entityId !== entityId || op.state === 'quarantined' || op.record === undefined)) ||
      (draft && draft.entityId !== entityId) ||
      (!op && !draft)
    )
      throw new ZuvRequestError('RECOVERY_REQUIRED');
    if (op) {
      const record = packRecord.parse(op.record);
      return {
        opId,
        parents: record.parents,
        content: SyncMemoryContentSchema.parse(record.content),
      };
    }
    if (!draft) throw new ZuvRequestError('RECOVERY_REQUIRED');
    return {
      opId,
      parents: draft.parents,
      content: SyncMemoryContentSchema.parse((draft.content as SyncDraftPayload).body),
    };
  }
  #ancestors(vaultId: string, entityId: string, start: string): Set<string> | undefined {
    const found = new Set<string>();
    const pending = [start];
    while (pending.length) {
      const id = pending.pop() as string;
      if (found.has(id)) continue;
      if (found.size >= 1024) return undefined;
      found.add(id);
      let revision: { opId: string; parents: string[]; content: Body };
      try {
        revision = this.#revision(vaultId, entityId, id);
      } catch (error) {
        if (error instanceof ZuvRequestError && error.code === 'RECOVERY_REQUIRED')
          return undefined;
        throw error;
      }
      pending.push(...revision.parents);
    }
    return found;
  }
  #base(vault: SyncVaultRecord, entityId: string, heads: string[]): string | undefined {
    const left = this.#ancestors(vault.vaultId, entityId, heads[0] as string);
    const right = this.#ancestors(vault.vaultId, entityId, heads[1] as string);
    if (!left || !right) return undefined;
    const common = [...left].filter((id) => right.has(id));
    const descendants = new Set<string>();
    // The complete intersection is ancestor-closed; direct parents identify every non-maximal base.
    for (const id of common)
      for (const ancestor of this.#revision(vault.vaultId, entityId, id).parents)
        descendants.add(ancestor);
    const candidates = common.filter((id) => !descendants.has(id));
    return candidates.length === 1 ? candidates[0] : undefined;
  }
  #path(vault: SyncVaultRecord, entity: SyncEntityRecord, body: Body): string {
    const workspace = entity.projectId
      ? this.#options.storage.sync
          .projects(vault.vaultId)
          .find((project) => project.projectId === entity.projectId)?.workspaceId
      : undefined;
    if ((body.scope === 'project') !== Boolean(workspace))
      throw new ZuvRequestError('SCOPE_DISABLED');
    const localKey = `memory:${workspace ?? 'global'}:${body.name}`;
    if (entity.localKey !== localKey) throw new ZuvRequestError('INTEGRITY_FAILED');
    return workspace
      ? join(this.#options.memoryDir, 'projects', workspace, `${body.name}.md`)
      : join(this.#options.memoryDir, 'global', `${body.name}.md`);
  }
  async #fingerprint(path: string): Promise<string> {
    const relative = path.slice(this.#options.memoryDir.length + 1);
    let current = this.#options.memoryDir;
    try {
      const root = await lstat(current);
      if (!root.isDirectory() || root.isSymbolicLink())
        throw new ZuvRequestError('INTEGRITY_FAILED');
      const parts = relative.split(/[\\/]/);
      for (const part of parts) {
        current = join(current, part);
        const info = await lstat(current);
        if (
          info.isSymbolicLink() ||
          (current === path ? !info.isFile() || info.size > 128 * 1024 : !info.isDirectory())
        )
          throw new ZuvRequestError('INTEGRITY_FAILED');
      }
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const bytes = Buffer.alloc(128 * 1024 + 1);
        let count = 0;
        while (count < bytes.length) {
          const { bytesRead } = await file.read(bytes, count, bytes.length - count, count);
          if (!bytesRead) break;
          count += bytesRead;
        }
        if (count > 128 * 1024) throw new ZuvRequestError('INTEGRITY_FAILED');
        return sha256(bytes.subarray(0, count));
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw error;
    }
  }
}
