import {
  type HostSettings,
  HostSettingsSchema,
  SyncSettingsContentSchema,
  SyncSettingsValuesSchema,
} from '@wevir/protocol';
import { jcs, type packRecord, type SyncOperation } from '@wevir/protocol/sync';
import type {
  Storage,
  SyncLocalWriteRecord,
  SyncMaterialJournalRecord,
  SyncVaultRecord,
} from '@wevir/storage';
import { newId } from '../ids.js';
import { type HostSettingsStore, SettingsRevisionError } from '../settings.js';
import { ZuvRequestError } from '../zuv/transport.js';
import { sha256 } from './crypto.js';
import { SyncQueue } from './queue.js';

type Values = typeof SyncSettingsValuesSchema._output;
type Key = keyof Values;
const EXCLUSIONS = Object.keys(HostSettingsSchema.shape).filter(
  (key) => !(key in SyncSettingsValuesSchema.shape),
);
export class SyncSettings {
  readonly #storage: Storage;
  readonly #settings: HostSettingsStore;
  readonly #path: string;
  readonly #queue: SyncQueue;
  constructor(options: { storage: Storage; settings: HostSettingsStore; home: string }) {
    this.#storage = options.storage;
    this.#settings = options.settings;
    this.#path = `${options.home}/settings.json`;
    this.#queue = new SyncQueue(options.storage);
  }
  beforeWrite(vault: SyncVaultRecord, next: HostSettings): (() => void) | undefined {
    if (!vault.categories.includes('settings')) return;
    const writes: SyncLocalWriteRecord[] = [];
    const values = this.#values(next);
    const current = this.#values(this.#settings.get());
    this.#storage.transaction(() => {
      for (const key of Object.keys(values) as Key[]) {
        const value = values[key];
        if (jcs(value) === jcs(current[key] ?? null)) continue;
        const localKey = `settings:${key}`;
        if (!this.#storage.sync.claimResource(localKey, vault.vaultId)) continue;
        const nextHash = sha256(jcs(value));
        if (this.#incoming(vault.vaultId, localKey, nextHash)) continue;
        const entity = this.#storage.sync.localEntity(vault.vaultId, localKey);
        const pending: SyncLocalWriteRecord = {
          id: newId('sjr'),
          vaultId: vault.vaultId,
          entityId: `settings_${key}`,
          entityType: 'settings',
          localKey,
          path: this.#path,
          kind: 'put',
          parents: entity?.revision ? [entity.revision] : [],
          content: this.#body(key, value),
          nextHash,
          state: 'pending',
        };
        this.#storage.sync.putLocalWrite(pending);
        writes.push(pending);
      }
    });
    return writes.length
      ? () =>
          this.#storage.transaction(() => {
            for (const write of writes) this.#finish(write);
          })
      : undefined;
  }
  capture(vault: SyncVaultRecord, initialize: boolean, includeHistory: boolean): void {
    if (!vault.categories.includes('settings')) return;
    const values = this.#values(this.#settings.get());
    this.#storage.transaction(() => {
      for (const pending of this.#storage.sync
        .localWrites(vault.vaultId)
        .filter((value) => value.entityType === 'settings' && value.state === 'pending')) {
        const key = pending.localKey.slice('settings:'.length) as Key;
        if (sha256(jcs(values[key] ?? null)) === pending.nextHash) this.#finish(pending);
        else this.#storage.sync.abandonLocalWrite(pending.id);
      }
      for (const key of Object.keys(values) as Key[]) {
        const localKey = `settings:${key}`;
        if (!this.#storage.sync.claimResource(localKey, vault.vaultId)) continue;
        const entityId = `settings_${key}`;
        const entity = this.#storage.sync.entity(vault.vaultId, entityId);
        const hash = sha256(jcs(values[key]));
        const baseline = this.#storage.sync.fileBaseline(vault.vaultId, entityId);
        if (
          this.#incoming(vault.vaultId, localKey, hash) ||
          (hash === baseline?.fingerprint && !(initialize && includeHistory && !entity?.revision))
        )
          continue;
        if (!entity)
          this.#storage.sync.putEntity({
            vaultId: vault.vaultId,
            entityId,
            entityType: 'settings',
            localKey,
            materialized: true,
          });
        const opId =
          initialize && !includeHistory
            ? undefined
            : this.#queue.enqueue({
                vaultId: vault.vaultId,
                entityId,
                entityType: 'settings',
                localKey,
                content: this.#body(key, values[key]),
              });
        this.#storage.sync.putFileBaseline({
          vaultId: vault.vaultId,
          entityId,
          entityType: 'settings',
          path: this.#path,
          fingerprint: hash,
          ...(opId && { opId }),
        });
      }
    });
  }
  async prepare(op: SyncOperation, record: typeof packRecord._output): Promise<() => void> {
    const body = SyncSettingsContentSchema.parse(record.content);
    const keys = Object.keys(body.values) as Key[];
    const key = keys[0];
    if (
      keys.length !== 1 ||
      !key ||
      op.entityId !== `settings_${key}` ||
      record.projectId ||
      op.kind === 'delete'
    )
      throw new ZuvRequestError('INTEGRITY_FAILED');
    const localKey = `settings:${key}`;
    const local = this.#storage.sync.entity(op.vaultId, op.entityId);
    const value = body.values[key];
    const nextHash = sha256(jcs(value));
    let journal: SyncMaterialJournalRecord = this.#storage.sync.materialJournal(
      op.vaultId,
      op.opId,
    ) ?? {
      vaultId: op.vaultId,
      opId: op.opId,
      entityId: op.entityId,
      localKey,
      targetPath: this.#path,
      previousHash: sha256(jcs(this.#values(this.#settings.get())[key] ?? null)),
      nextHash,
      state: 'staged',
    };
    const owner = this.#storage.sync.owner(localKey);
    const conflict =
      (owner && owner !== op.vaultId) ||
      (local?.revision && local.revision !== op.opId && !op.parents.includes(local.revision));
    if (conflict) journal = { ...journal, state: 'conflict' };
    this.#storage.sync.putMaterialJournal(journal);
    if (!conflict && sha256(jcs(this.#values(this.#settings.get())[key] ?? null)) !== nextHash) {
      const expected = { [key]: this.#settings.get()[key] } as Partial<HostSettings>;
      if (sha256(jcs(expected[key] ?? null)) !== journal.previousHash)
        journal = { ...journal, state: 'conflict' };
      else
        try {
          await this.#settings.update(body.values, expected);
        } catch (error) {
          if (error instanceof SettingsRevisionError) journal = { ...journal, state: 'conflict' };
          else throw error;
        }
    }
    return () => {
      const applied =
        journal.state !== 'conflict' &&
        sha256(jcs(this.#values(this.#settings.get())[key] ?? null)) === nextHash;
      this.#storage.sync.putMaterialJournal({
        ...journal,
        state: applied ? 'applied' : 'conflict',
      });
      if (applied) {
        this.#storage.sync.claimResource(localKey, op.vaultId);
        this.#storage.sync.putEntity({
          vaultId: op.vaultId,
          entityId: op.entityId,
          entityType: 'settings',
          localKey,
          revision: op.opId,
          fingerprint: sha256(
            jcs({ kind: op.kind, content: { schema: 'wevir-sync-draft/1', body: record.content } }),
          ),
          materialized: true,
        });
        this.#storage.sync.putFileBaseline({
          vaultId: op.vaultId,
          entityId: op.entityId,
          entityType: 'settings',
          path: this.#path,
          fingerprint: nextHash,
          opId: op.opId,
        });
      }
    };
  }
  #values(settings: HostSettings): Values {
    return SyncSettingsValuesSchema.parse(
      Object.fromEntries(
        Object.keys(SyncSettingsValuesSchema.shape).flatMap((key) =>
          settings[key as Key] === undefined ? [] : [[key, settings[key as Key]]],
        ),
      ),
    );
  }
  #body(key: Key, value: unknown) {
    return { schema: 'wevir-settings/1', values: { [key]: value }, exclusions: EXCLUSIONS };
  }
  #incoming(vaultId: string, key: string, hash: string): boolean {
    return this.#storage.sync
      .materialJournals(vaultId)
      .some(
        (value) => value.localKey === key && value.state === 'staged' && value.nextHash === hash,
      );
  }
  #finish(pending: SyncLocalWriteRecord): void {
    if (!this.#storage.sync.localWrites(pending.vaultId).some((value) => value.id === pending.id))
      return;
    const opId = this.#queue.enqueue({ ...pending, entityType: 'settings' });
    this.#storage.sync.putFileBaseline({
      ...pending,
      fingerprint: pending.nextHash,
      ...(opId && { opId }),
    });
    this.#storage.sync.removeLocalWrite(pending.id);
  }
}
