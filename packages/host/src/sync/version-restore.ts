import {
  type MethodParams,
  type MethodResult,
  type PortableVersionSchema,
  SyncBundleContentSchema,
  SyncMemoryContentSchema,
  SyncProjectContentSchema,
  SyncSessionConflictContentSchema,
  SyncSettingsContentSchema,
  SyncWorkspaceMetadataSchema,
} from '@wevir/protocol';
import { jcs } from '@wevir/protocol/sync';
import type { Storage, SyncEntityRecord, SyncVaultRecord } from '@wevir/storage';
import { newId } from '../ids.js';
import { ZuvRequestError } from '../zuv/transport.js';
import type { BundleFile } from './bundle-snapshot.js';
import type { SyncBundles } from './bundles.js';
import { sha256 } from './crypto.js';
import type { SyncMaterials } from './materials.js';
import type { SyncMemoryConflicts } from './memory-conflicts.js';
import type { SyncPortable } from './portable.js';
import { SyncQueue } from './queue.js';
import type { SyncSessionConflicts } from './session-conflicts.js';
import type { SyncSettingsConflicts } from './settings-conflicts.js';
import type { SyncWorkspaces } from './workspaces.js';

type Version = typeof PortableVersionSchema._output;
type Preview = MethodResult<'sync.importRestorePreview'>;
interface Options {
  storage: Storage;
  portable: SyncPortable;
  materials: SyncMaterials;
  memory: SyncMemoryConflicts;
  settings: SyncSettingsConflicts;
  sessions: SyncSessionConflicts;
  bundles: SyncBundles;
  workspaces: SyncWorkspaces;
  eligible: () => SyncVaultRecord | undefined;
  captureProject: (vault: SyncVaultRecord, entityId: string) => void;
  captureBundleTarget: (
    vault: SyncVaultRecord,
    entity: SyncEntityRecord,
    targetId: string,
  ) => Promise<{ files: BundleFile[]; deleted: boolean | undefined } | undefined>;
}
const text = (content: unknown): string => {
  if (!content || typeof content !== 'object') return '';
  const body = content as {
    schema?: string;
    markdown?: string;
    values?: unknown;
    displayName?: string;
    title?: string;
    archivedAt?: string;
    episode?: { title: string };
    summary?: { points: Array<{ text: string }> };
    files?: Array<{ path: string }>;
  };
  return (
    body.markdown ??
    body.displayName ??
    body.title ??
    body.episode?.title ??
    body.summary?.points.map((point) => point.text).join('\n\n') ??
    (body.values ? JSON.stringify(body.values, null, 2) : undefined) ??
    body.files?.map((file) => file.path).join('\n') ??
    ''
  );
};

const fileMetadata = (
  files: ReadonlyArray<{ path: string; bytes: number; sha256: string; executable?: boolean }>,
): string =>
  files
    .map(
      (file) => `${file.path}${file.executable ? ' (+x)' : ''}\n${file.bytes} B · ${file.sha256}`,
    )
    .join('\n');
const fileText = (files: readonly BundleFile[]): string => {
  if (
    files.length === 1 &&
    files[0] &&
    files[0].bytes.length <= 128 * 1024 &&
    !files[0].bytes.includes(0)
  )
    try {
      return `${fileMetadata([{ ...files[0], bytes: files[0].bytes.length }])}\n${new TextDecoder('utf-8', { fatal: true }).decode(files[0].bytes)}`;
    } catch {}
  return fileMetadata(files.map((file) => ({ ...file, bytes: file.bytes.length })));
};
const bounded = (view: Preview): Preview => ({
  ...view,
  truncated:
    view.truncated || view.selectedText.length > 160000 || view.currentText.length > 160000,
  selectedText: view.selectedText.slice(0, 160000),
  currentText: view.currentText.slice(0, 160000),
});

export class SyncVersionRestore {
  constructor(readonly options: Options) {}
  async preview(input: MethodParams<'sync.importRestorePreview'>): Promise<Preview> {
    const version = await this.options.portable.version(input.importId, input.entryId);
    const kind = this.#kind(version);
    let view: Preview = {
      ...input,
      vaultId: version.vaultId,
      entityId: version.entityId,
      entityType: version.entityType,
      versionFingerprint: sha256(jcs(version)),
      kind,
      canRestore: false,
      reason: 'read_only',
      selectedText: text(version.record.content),
      selectedDeleted:
        version.record.kind === 'delete' ||
        (version.record.content as { deleted?: boolean } | null)?.deleted === true ||
        (version.record.content as { schema?: string } | null)?.schema ===
          'wevir-session-deleted/1',
      currentText: '',
      expectedHeads: [],
    };
    if (kind === 'history') return bounded(view);
    const vault = this.options.eligible();
    if (!vault) return bounded({ ...view, reason: 'scope_disabled' });
    if (vault.vaultId !== version.vaultId) return bounded({ ...view, reason: 'different_vault' });
    if (this.options.storage.sync.activeBootstrapJob(vault.vaultId))
      return bounded({ ...view, reason: 'reset_required' });
    let entity = this.options.storage.sync.entity(vault.vaultId, version.entityId);
    if (!entity?.revision || entity.entityType !== version.entityType)
      return bounded({ ...view, reason: 'unmapped' });
    this.#scope(vault, entity, version);
    if (kind === 'project') {
      this.options.captureProject(vault, entity.entityId);
      entity = this.options.storage.sync.entity(
        vault.vaultId,
        version.entityId,
      ) as SyncEntityRecord;
    }
    if (kind === 'memory') {
      const p = await this.options.memory.preview(entity.entityId, true);
      const body = SyncMemoryContentSchema.parse(version.record.content);
      if (body.name !== p.name || body.scope !== p.scope)
        throw new ZuvRequestError('INTEGRITY_FAILED');
      view = {
        ...view,
        expectedHeads: p.expectedHeads,
        localRevision: p.localRevision,
        localFingerprint: p.fileFingerprint,
        currentText: p.versions.find((item) => item.opId === p.localRevision)?.markdown ?? '',
        currentDeleted: p.versions.find((item) => item.opId === p.localRevision)?.deleted,
      };
    } else if (kind === 'settings') {
      const p = await this.options.settings.preview(entity.entityId, true),
        body = SyncSettingsContentSchema.parse(version.record.content);
      if (Object.keys(body.values).length !== 1 || !(p.key in body.values))
        throw new ZuvRequestError('INTEGRITY_FAILED');
      view = {
        ...view,
        expectedHeads: p.expectedHeads,
        localRevision: p.localRevision,
        localFingerprint: p.valueFingerprint,
        currentText: JSON.stringify(p.localValues, null, 2),
      };
    } else if (kind === 'session') {
      this.options.materials.sessions.captureLocal(vault, entity.entityId);
      const p = this.options.sessions.preview(entity.entityId, true);
      view = {
        ...view,
        expectedHeads: p.expectedHeads,
        localRevision: p.localRevision,
        localFingerprint: p.localFingerprint,
        currentText: text(p.versions.find((item) => item.opId === p.localRevision)?.content),
        sessionId: p.sessionId,
      };
    } else if (kind === 'bundle') {
      const data = await this.options.portable.material(input.importId, input.entryId);
      await this.options.bundles.capture(entity, vault);
      let p = await this.options.bundles.preview(vault.vaultId, entity.entityId);
      let targets = (await this.options.bundles.targets(vault.vaultId, entity.entityId)).targets;
      if (input.targetId && !targets.some((value) => value.targetId === input.targetId))
        throw new ZuvRequestError('SCOPE_DISABLED');
      let target =
        targets.find((value) => value.targetId === (input.targetId ?? p.binding?.targetId)) ??
        targets.find((value) => value.managed);
      if (!target) return bounded({ ...view, reason: 'unmapped' });
      const current = await this.options.captureBundleTarget(vault, entity, target.targetId);
      p = await this.options.bundles.preview(vault.vaultId, entity.entityId);
      targets = (await this.options.bundles.targets(vault.vaultId, entity.entityId)).targets;
      target = targets.find((value) => value.targetId === target?.targetId);
      if (!target) throw new ZuvRequestError('SCOPE_DISABLED');
      const currentVersion = p.versions.find(
        (value) => value.opId === (p.binding?.revision ?? entity.revision),
      );
      let currentText = current
        ? fileText(current.files)
        : currentVersion
          ? fileMetadata(currentVersion.files)
          : '';
      let fileTruncated = false;
      if (!current && currentVersion?.files.length === 1 && currentVersion.files[0]) {
        const file = await this.options.bundles.file({
          vaultId: vault.vaultId,
          entityId: entity.entityId,
          opId: currentVersion.opId,
          path: currentVersion.files[0].path,
        });
        if (!file.binary && file.text !== undefined)
          currentText = `${file.path} · ${file.bytes} B · ${file.sha256}\n${file.text}`;
        fileTruncated = file.truncated;
      }
      view = {
        ...view,
        versionFingerprint: data.fingerprint,
        expectedHeads: p.heads,
        localRevision: p.binding?.revision,
        localFingerprint: target.fingerprint,
        targetId: target.targetId,
        expectedTargetId: p.binding?.targetId,
        targetPath: target.path,
        targets,
        selectedText: fileText(data.files),
        truncated: fileTruncated,
        currentText,
        currentDeleted: current?.deleted ?? currentVersion?.deleted,
      };
    } else {
      const heads = this.#heads(vault, entity);
      view = {
        ...view,
        expectedHeads: heads,
        localRevision: entity.revision,
        localFingerprint: sha256(jcs({ revision: entity.revision, heads })),
      };
      if (kind === 'project')
        view.currentText =
          this.options.storage.sync.projectName(vault.vaultId, entity.entityId) ?? '';
      else {
        const data = await this.options.portable.material(input.importId, input.entryId);
        if (data.rules.length && !vault.categories.includes('rule'))
          return bounded({ ...view, reason: 'scope_disabled' });
        const metadata = SyncWorkspaceMetadataSchema.parse(data.body.metadata);
        const reference = data.body.recoveredFrom?.source ?? metadata.source;
        const source = this.options.storage.sync
          .sources(vault.vaultId)
          .find(
            (value) =>
              value.hostId === reference.hostId &&
              value.deviceId === reference.deviceId &&
              value.sessionId === reference.sessionId &&
              value.streamId === reference.streamId,
          );
        const own =
          metadata.source.hostId === vault.originHostId &&
          metadata.source.deviceId === vault.deviceId
            ? this.options.storage.sessions.get(metadata.source.sessionId)
            : undefined;
        const session =
          own ??
          (source?.localSessionId
            ? this.options.storage.sessions.get(source.localSessionId)
            : undefined);
        if (!session) return bounded({ ...view, reason: 'unmapped' });
        view = {
          ...view,
          versionFingerprint: data.fingerprint,
          sessionId: session.id as Preview['sessionId'],
          localSeq: session.lastSeq,
          localFingerprint: sha256(
            jcs({ revision: entity.revision, heads, sessionId: session.id, seq: session.lastSeq }),
          ),
          currentText: session.title,
          selectedText: `${metadata.sourceHead ?? ''}\n${fileText(data.files)}`,
        };
      }
    }
    this.#sameVault(vault);
    return bounded({ ...view, reason: undefined, canRestore: true });
  }

  async restore(input: MethodParams<'sync.importRestore'>) {
    const vault = this.options.eligible();
    if (!vault) throw new ZuvRequestError('SCOPE_DISABLED');
    const view = await this.preview(input);
    if (!view.canRestore) throw new ZuvRequestError('SCOPE_DISABLED');
    if (
      input.vaultId !== view.vaultId ||
      input.entityId !== view.entityId ||
      input.versionFingerprint !== view.versionFingerprint ||
      input.localRevision !== view.localRevision ||
      input.localFingerprint !== view.localFingerprint ||
      input.targetId !== view.targetId ||
      input.expectedTargetId !== view.expectedTargetId ||
      input.sessionId !== view.sessionId ||
      input.localSeq !== view.localSeq ||
      input.expectedHeads.length !== view.expectedHeads.length ||
      input.expectedHeads.some((head) => !view.expectedHeads.includes(head))
    )
      throw new ZuvRequestError('REVISION_CONFLICT');
    const version = await this.options.portable.version(input.importId, input.entryId);
    this.#sameVault(vault);
    if (
      view.kind !== 'bundle' &&
      view.kind !== 'workspace' &&
      sha256(jcs(version)) !== input.versionFingerprint
    )
      throw new ZuvRequestError('REVISION_CONFLICT');
    let result: { opId: string; entityId?: string };
    if (view.kind === 'memory') {
      const body = SyncMemoryContentSchema.parse(version.record.content);
      result = await this.options.memory.resolve(
        {
          entityId: input.entityId,
          expectedHeads: input.expectedHeads,
          localRevision: input.localRevision as string,
          fileFingerprint: input.localFingerprint as string,
          ...(body.deleted ? { deleted: true } : { markdown: body.markdown }),
        },
        true,
      );
    } else if (view.kind === 'settings') {
      const body = SyncSettingsContentSchema.parse(version.record.content);
      result = await this.options.settings.resolve(
        {
          entityId: input.entityId,
          expectedHeads: input.expectedHeads,
          localRevision: input.localRevision as string,
          valueFingerprint: input.localFingerprint as string,
          values: body.values,
        },
        true,
      );
    } else if (view.kind === 'session')
      result = await this.options.sessions.resolve(
        {
          vaultId: input.vaultId,
          entityId: input.entityId,
          expectedHeads: input.expectedHeads,
          localRevision: input.localRevision as string,
          localFingerprint: input.localFingerprint as string,
          selection: { kind: 'version', opId: version.opId },
        },
        SyncSessionConflictContentSchema.parse(version.record.content),
      );
    else if (view.kind === 'bundle') {
      const data = await this.options.portable.material(input.importId, input.entryId);
      if (data.fingerprint !== input.versionFingerprint)
        throw new ZuvRequestError('REVISION_CONFLICT');
      result = await this.options.bundles.restoreVersion(
        {
          vaultId: input.vaultId,
          entityId: input.entityId,
          expectedHeads: input.expectedHeads,
          localRevision: input.localRevision,
          targetId: input.targetId as string,
          fingerprint: input.localFingerprint as string,
          selectedOpId: version.opId,
          expectedTargetId: input.expectedTargetId,
        },
        {
          body: data.body,
          files: data.files,
          kind:
            version.record.kind === 'delete'
              ? 'delete'
              : version.record.kind === 'resolve'
                ? 'resolve'
                : 'put',
        },
        new AbortController().signal,
      );
    } else if (view.kind === 'workspace') {
      const data = await this.options.portable.material(input.importId, input.entryId);
      if (data.fingerprint !== input.versionFingerprint)
        throw new ZuvRequestError('REVISION_CONFLICT');
      const references = this.#ruleCopies(vault, data.rules);
      const body = {
        ...data.body,
        metadata: {
          ...SyncWorkspaceMetadataSchema.parse(data.body.metadata),
          ruleVersions: references.refs,
        },
      };
      const restored = this.options.workspaces.restoreVersion(
        {
          sessionId: input.sessionId as NonNullable<Preview['sessionId']>,
          expectedLocalSeq: input.localSeq as number,
        },
        {
          vaultId: version.vaultId,
          opId: version.opId,
          deviceId:
            version.operation?.deviceId ??
            SyncWorkspaceMetadataSchema.parse(data.body.metadata).source.deviceId,
          body,
          files: data.files,
          enqueueReferences: references.commit,
        },
      );
      result = { opId: restored.snapshot.opId, entityId: restored.snapshot.entityId };
    } else if (view.kind === 'project') {
      const body = SyncProjectContentSchema.parse(version.record.content),
        storage = this.options.storage;
      result = storage.transaction(() => {
        this.#sameVault(vault);
        const entity = storage.sync.entity(vault.vaultId, input.entityId);
        if (
          !entity ||
          entity.revision !== input.localRevision ||
          body.projectId !== entity.entityId ||
          jcs(this.#heads(vault, entity)) !== jcs([...input.expectedHeads].sort()) ||
          (storage.sync.projectName(vault.vaultId, input.entityId) ?? '') !== view.currentText
        )
          throw new ZuvRequestError('REVISION_CONFLICT');
        const opId = new SyncQueue(storage).enqueue({
          vaultId: vault.vaultId,
          entityId: entity.entityId,
          entityType: 'project',
          opId: newId('sop'),
          projectId: entity.projectId,
          localKey: entity.localKey,
          kind: input.expectedHeads.length > 1 ? 'resolve' : 'put',
          parents: input.expectedHeads,
          content: body,
        });
        if (!opId) throw new ZuvRequestError('SCOPE_DISABLED');
        storage.sync.setProjectName(vault.vaultId, entity.entityId, body.displayName);
        return { opId };
      });
    } else throw new ZuvRequestError('INVALID_REQUEST');
    this.options.materials.notify();
    return { opId: result.opId, entityId: result.entityId ?? input.entityId };
  }
  #kind(version: Version): Preview['kind'] {
    const schema = (version.record.content as { schema?: string } | null)?.schema;
    if (version.entityType === 'memory' && schema === 'wevir-memory/1') return 'memory';
    if (version.entityType === 'settings' && schema === 'wevir-settings/1') return 'settings';
    if (version.entityType === 'project' && schema === 'wevir-project/1') return 'project';
    if (
      version.entityType === 'session' &&
      [
        'wevir-session/1',
        'wevir-session-state/1',
        'wevir-session-deleted/1',
        'wevir-episode/1',
        'wevir-retro-summary/1',
      ].includes(schema ?? '')
    )
      return 'session';
    if (schema === 'wevir-bundle/1') {
      const body = SyncBundleContentSchema.parse(version.record.content);
      if (body.category !== version.entityType) throw new ZuvRequestError('INTEGRITY_FAILED');
      if (body.category === 'workspace-snapshot') return 'workspace';
      if (
        ['wevir-shared-files/1', 'wevir-image/1'].includes(
          (body.metadata as { schema?: string } | null)?.schema ?? '',
        )
      )
        return 'history';
      return 'bundle';
    }
    return 'history';
  }
  #scope(vault: SyncVaultRecord, entity: SyncEntityRecord, version: Version) {
    if (
      !vault.categories.includes(entity.entityType) ||
      entity.projectId !== version.record.projectId ||
      (entity.projectId && !vault.projectIds.includes(entity.projectId)) ||
      (['bundle', 'workspace'].includes(this.#kind(version)) &&
        !vault.categories.includes('artifact'))
    )
      throw new ZuvRequestError('SCOPE_DISABLED');
  }
  #sameVault(vault: SyncVaultRecord) {
    const current = this.options.eligible();
    if (
      current?.vaultId !== vault.vaultId ||
      current.deviceId !== vault.deviceId ||
      current.originHostId !== vault.originHostId ||
      current.accountId !== vault.accountId ||
      current.revision !== vault.revision
    )
      throw new ZuvRequestError('REVISION_CONFLICT');
  }
  #heads(vault: SyncVaultRecord, entity: SyncEntityRecord) {
    const heads = this.options.storage.sync.heads(vault.vaultId, entity.entityId);
    if (entity.revision && !heads.includes(entity.revision)) heads.push(entity.revision);
    if (!heads.length || heads.length > 32) throw new ZuvRequestError('QUOTA_EXCEEDED');
    return heads.sort();
  }
  #ruleCopies(
    vault: SyncVaultRecord,
    rules: Awaited<ReturnType<SyncPortable['material']>>['rules'],
  ) {
    if (rules.length && !vault.categories.includes('rule'))
      throw new ZuvRequestError('SCOPE_DISABLED');
    const copies = rules.map((rule) => ({ rule, entityId: newId('sen'), opId: newId('sop') }));
    return {
      refs: copies.map(({ entityId, opId }) => ({ entityId, opId })),
      commit: () => {
        this.#sameVault(vault);
        const queue = new SyncQueue(this.options.storage);
        for (const { rule, entityId, opId } of copies) {
          const files = rule.files.map((file) => {
            const parts: Array<{ entityId: string; opId: string }> = [];
            for (
              let offset = 0, index = 0;
              offset < file.bytes.length;
              offset += 64 * 1024, index++
            ) {
              const chunkId = newId('spart'),
                bytes = file.bytes.subarray(offset, offset + 64 * 1024);
              const part = queue.enqueue({
                vaultId: vault.vaultId,
                entityId: chunkId,
                entityType: 'artifact',
                projectId: rule.version.record.projectId,
                localKey: `chunk:${chunkId}`,
                content: {
                  schema: 'wevir-chunk/1',
                  ownerId: entityId,
                  index,
                  data: bytes.toString('base64url'),
                  sha256: sha256(bytes),
                },
              });
              if (!part) throw new ZuvRequestError('SCOPE_DISABLED');
              parts.push({ entityId: chunkId, opId: part });
            }
            return {
              path: file.path,
              bytes: file.bytes.length,
              sha256: file.sha256,
              executable: file.executable,
              parts,
            };
          });
          const id = queue.enqueue({
            vaultId: vault.vaultId,
            entityId,
            entityType: 'rule',
            projectId: rule.version.record.projectId,
            localKey: `restored-rule:${entityId}`,
            opId,
            parents: [],
            kind: rule.version.record.kind === 'delete' ? 'delete' : 'put',
            content: {
              ...rule.body,
              files,
              recoveredFrom: {
                vaultId: vault.vaultId,
                deviceId: rule.version.operation?.deviceId ?? vault.deviceId,
                opId: rule.version.opId,
              },
            },
          });
          if (id !== opId) throw new ZuvRequestError('SCOPE_DISABLED');
        }
      },
    };
  }
}
