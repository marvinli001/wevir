import {
  NOTIFICATION_KINDS,
  SyncSettingsContentSchema,
  SyncSettingsValuesSchema,
} from '@wevir/protocol';
import { jcs, packRecord } from '@wevir/protocol/sync';
import type { Storage, SyncEntityRecord, SyncVaultRecord } from '@wevir/storage';
import type { HostSettingsStore } from '../settings.js';
import { ZuvRequestError } from '../zuv/transport.js';
import { sha256 } from './crypto.js';
import type { SyncDraftPayload } from './queue.js';
import type { SyncSettings } from './settings.js';
import { mergeSyncText } from './text-merge.js';

type Values = typeof SyncSettingsValuesSchema._output;
type Key = keyof Values;
interface Options {
  storage: Storage;
  settings: HostSettingsStore;
  settingsSync: SyncSettings;
  home: string;
  eligible: () => SyncVaultRecord | undefined;
}
export class SyncSettingsConflicts {
  constructor(readonly options: Options) {}
  list(after?: string) {
    const vault = this.#vault();
    const entries = this.options.storage.sync.settingsConflictEntities(vault.vaultId, after);
    const conflicts = entries.slice(0, 100).flatMap((entity) => {
      const heads = this.#heads(vault, entity);
      if (heads.length < 2) return [];
      if (heads.length > 32) throw new ZuvRequestError('QUOTA_EXCEEDED');
      return [{ entityId: entity.entityId, key: this.#key(entity.entityId), heads }];
    });
    return { conflicts, ...(entries.length > 100 && { next: entries[99]?.entityId }) };
  }
  async preview(entityId: string, historical = false) {
    const vault = this.#vault();
    this.options.settingsSync.capture(vault, false, false);
    const snapshot = this.#snapshot(vault, entityId, historical);
    const valueFingerprint = this.#fingerprint(snapshot.key);
    const baseId =
      snapshot.heads.length === 2 ? this.#base(vault, entityId, snapshot.heads) : undefined;
    const base = baseId ? this.#revision(vault.vaultId, entityId, baseId) : undefined;
    let merged: Values | undefined;
    if (snapshot.key === 'agentInstructions' && base) {
      const values = [base, ...snapshot.versions].map(
        (version) => version.values.agentInstructions,
      );
      if (values.every((value) => typeof value === 'string')) {
        const text = await mergeSyncText(
          this.options.home,
          values[0] as string,
          values[1] as string,
          values[2] as string,
        );
        const result = SyncSettingsValuesSchema.safeParse({ agentInstructions: text });
        if (text !== undefined && result.success) merged = result.data;
      }
    }
    if (snapshot.key === 'notifications' && base) {
      const before = base.values.notifications,
        left = snapshot.versions[0]?.values.notifications,
        right = snapshot.versions[1]?.values.notifications;
      if (before && left && right)
        merged = {
          notifications: Object.fromEntries(
            NOTIFICATION_KINDS.map((kind) => {
              const original = before[kind] ?? true,
                a = left[kind] ?? true,
                b = right[kind] ?? true;
              return [kind, a === b ? a : a === original ? b : a];
            }),
          ),
        };
    }
    this.#check(vault, snapshot.entity, snapshot.heads, snapshot.entity.revision as string);
    if (this.#fingerprint(snapshot.key) !== valueFingerprint)
      throw new ZuvRequestError('REVISION_CONFLICT');
    return {
      entityId,
      key: snapshot.key,
      expectedHeads: snapshot.heads,
      localRevision: snapshot.entity.revision as string,
      valueFingerprint,
      localValues: SyncSettingsValuesSchema.parse({
        [snapshot.key]: this.options.settings.get()[snapshot.key],
      }),
      versions: snapshot.versions,
      ...(base && { base }),
      ...(merged && { merged }),
      mergeState: merged
        ? ('clean' as const)
        : base
          ? ('conflict' as const)
          : ('unavailable' as const),
    };
  }
  async resolve(
    input: {
      entityId: string;
      expectedHeads: string[];
      localRevision: string;
      valueFingerprint: string;
      values: Values;
    },
    historical = false,
  ) {
    const vault = this.#vault();
    this.options.settingsSync.capture(vault, false, false);
    const snapshot = this.#snapshot(vault, input.entityId, historical);
    this.#check(vault, snapshot.entity, input.expectedHeads, input.localRevision);
    if (this.#fingerprint(snapshot.key) !== input.valueFingerprint)
      throw new ZuvRequestError('REVISION_CONFLICT');
    if (Object.keys(input.values).length !== 1 || !(snapshot.key in input.values))
      throw new ZuvRequestError('INVALID_REQUEST');
    return this.options.settingsSync.resolve(vault, input, () =>
      this.#check(vault, snapshot.entity, input.expectedHeads, input.localRevision),
    );
  }
  #vault() {
    const vault = this.options.eligible();
    if (!vault?.categories.includes('settings')) throw new ZuvRequestError('SCOPE_DISABLED');
    return vault;
  }
  #key(entityId: string): Key {
    const key = entityId.slice('settings_'.length);
    if (!entityId.startsWith('settings_') || !Object.hasOwn(SyncSettingsValuesSchema.shape, key))
      throw new ZuvRequestError('INTEGRITY_FAILED');
    return key as Key;
  }
  #fingerprint(key: Key) {
    return sha256(jcs(this.options.settings.get()[key] ?? null));
  }
  #snapshot(vault: SyncVaultRecord, entityId: string, historical = false) {
    const entity = this.options.storage.sync.entity(vault.vaultId, entityId);
    const key = this.#key(entityId);
    if (
      entity?.entityType !== 'settings' ||
      !entity.materialized ||
      !entity.revision ||
      entity.projectId ||
      entity.localKey !== `settings:${key}` ||
      this.options.storage.sync.owner(entity.localKey) !== vault.vaultId
    )
      throw new ZuvRequestError('SCOPE_DISABLED');
    const heads = this.#heads(vault, entity);
    if (heads.length < (historical ? 1 : 2)) throw new ZuvRequestError('REVISION_CONFLICT');
    if (heads.length > 32) throw new ZuvRequestError('QUOTA_EXCEEDED');
    return {
      entity,
      key,
      heads,
      versions: heads.map((head) => this.#revision(vault.vaultId, entityId, head)),
    };
  }
  #check(vault: SyncVaultRecord, entity: SyncEntityRecord, heads: string[], revision: string) {
    const current = this.#vault();
    const local = this.options.storage.sync.entity(vault.vaultId, entity.entityId);
    const actual = this.#heads(vault, local ?? entity);
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
  #revision(vaultId: string, entityId: string, opId: string) {
    const operation = this.options.storage.sync.getOperation(vaultId, opId);
    const draft = operation ? undefined : this.options.storage.sync.draft(vaultId, opId);
    if (
      (operation &&
        (operation.entityId !== entityId ||
          operation.entityType !== 'settings' ||
          operation.state === 'quarantined' ||
          !operation.record)) ||
      (draft && draft.entityId !== entityId) ||
      (!operation && !draft)
    )
      throw new ZuvRequestError('RECOVERY_REQUIRED');
    const record = operation ? packRecord.parse(operation.record) : undefined;
    if (!record && !draft) throw new ZuvRequestError('RECOVERY_REQUIRED');
    const content = SyncSettingsContentSchema.parse(
      record
        ? record.content
        : ((draft as NonNullable<typeof draft>).content as SyncDraftPayload).body,
    );
    const key = this.#key(entityId);
    if (Object.keys(content.values).length !== 1 || !(key in content.values) || record?.projectId)
      throw new ZuvRequestError('INTEGRITY_FAILED');
    return {
      opId,
      parents: record?.parents ?? draft?.parents ?? [],
      values: content.values,
      deviceId: operation?.deviceId ?? this.options.storage.sync.getVault(vaultId)?.deviceId,
      clientTime:
        (operation?.envelope as { clientTime?: string } | undefined)?.clientTime ??
        draft?.createdAt,
    };
  }
  #heads(vault: SyncVaultRecord, entity: SyncEntityRecord): string[] {
    const heads = this.options.storage.sync.heads(vault.vaultId, entity.entityId);
    if (entity.revision && !heads.includes(entity.revision)) {
      const operation = this.options.storage.sync.getOperation(vault.vaultId, entity.revision);
      const draft = this.options.storage.sync.draft(vault.vaultId, entity.revision);
      if (
        draft ||
        (operation?.direction === 'outbox' && ['queued', 'pending'].includes(operation.state))
      ) {
        const ancestors = this.#ancestors(vault.vaultId, entity.entityId, entity.revision);
        return [...heads.filter((head) => !ancestors?.has(head)), entity.revision].sort();
      }
    }
    return heads;
  }
  #ancestors(vaultId: string, entityId: string, start: string): Set<string> | undefined {
    const found = new Set<string>(),
      pending = [start];
    while (pending.length) {
      const id = pending.pop() as string;
      if (found.has(id)) continue;
      if (found.size >= 1024) return;
      found.add(id);
      try {
        pending.push(...this.#revision(vaultId, entityId, id).parents);
      } catch (error) {
        if (error instanceof ZuvRequestError && error.code === 'RECOVERY_REQUIRED') return;
        throw error;
      }
    }
    return found;
  }
  #base(vault: SyncVaultRecord, entityId: string, heads: string[]): string | undefined {
    const left = this.#ancestors(vault.vaultId, entityId, heads[0] as string),
      right = this.#ancestors(vault.vaultId, entityId, heads[1] as string);
    if (!left || !right) return;
    const common = [...left].filter((id) => right.has(id)),
      parents = new Set<string>();
    for (const id of common)
      for (const parent of this.#revision(vault.vaultId, entityId, id).parents) parents.add(parent);
    const candidates = common.filter((id) => !parents.has(id));
    return candidates.length === 1 ? candidates[0] : undefined;
  }
}
