import { type MethodParams, SyncBundleContentSchema } from '@wevir/protocol';
import { type EntityType, id } from '@wevir/protocol/sync';
import type { Storage, SyncVaultRecord } from '@wevir/storage';
import type { ZuvClient } from '../zuv/client.js';
import { ZuvRequestError } from '../zuv/transport.js';
import type { SyncPortable } from './portable.js';
import type { SyncRestoreData } from './restore-data.js';
import type { SyncSnapshots } from './snapshots.js';

export class SyncRecoveryFiles {
  constructor(
    readonly options: {
      client: ZuvClient;
      snapshots: SyncSnapshots;
      data: SyncRestoreData;
      portable: SyncPortable;
      storage: Storage;
    },
  ) {}
  async snapshot(vaultId: string, jobId?: string) {
    const vault = this.#vault(vaultId);
    const signal = new AbortController().signal;
    const plan = jobId
      ? await this.options.snapshots.resume(jobId, vault, signal)
      : await this.options.snapshots.prepare(vault, signal);
    const descriptor = await this.options.snapshots.describe(plan.jobId);
    return {
      jobId: plan.jobId,
      restoreId: descriptor.exported.restoreId,
      projectIds: plan.projectIds,
      operations: plan.operations,
      expiresAt: descriptor.exported.expiresAt,
    };
  }
  async download(input: MethodParams<'sync.recoveryDownload'>) {
    const vault = this.#vault(input.vaultId);
    const descriptor = await this.options.snapshots.describe(input.jobId);
    if (
      descriptor.vaultId !== vault.vaultId ||
      descriptor.accountId !== vault.accountId ||
      descriptor.deviceId !== vault.deviceId ||
      descriptor.origin !== this.options.client.transport.origin
    )
      throw new ZuvRequestError('AUTH_REQUIRED');
    this.options.storage.transaction(() => this.options.storage.sync.rememberRecoveryVault(vault));
    const categories: EntityType[] = [...new Set(input.categories)];
    const data = this.options.data;
    const signal = new AbortController().signal;
    async function* versions() {
      const seen = new Set<string>();
      const refs = new Map<string, string>();
      const addRef = (ref: { opId: string; entityId: string }) => {
        id.parse(ref.opId);
        id.parse(ref.entityId);
        const prior = refs.get(ref.opId);
        if (prior && prior !== ref.entityId) throw new ZuvRequestError('INTEGRITY_FAILED');
        refs.set(ref.opId, ref.entityId);
        if (refs.size > 50000) throw new ZuvRequestError('QUOTA_EXCEEDED');
      };
      const pages = (selected: EntityType[], operationIds?: ReadonlySet<string>) =>
        data.records(
          input.jobId,
          vault,
          { categories: selected, projectIds: input.projectIds },
          signal,
          operationIds,
        );
      for (let depth = 0; depth < 4; depth++) {
        const wanted = depth
          ? new Set([...refs.keys()].filter((opId) => !seen.has(opId)))
          : undefined;
        if (depth && !wanted?.size) return;
        let added = 0;
        for await (const entry of pages(depth ? ['artifact', 'rule'] : categories, wanted)) {
          if (seen.has(entry.operation.opId)) continue;
          if (wanted && refs.get(entry.operation.opId) !== entry.operation.entityId)
            throw new ZuvRequestError('INTEGRITY_FAILED');
          seen.add(entry.operation.opId);
          added++;
          if ((entry.record.content as { schema?: string } | null)?.schema === 'wevir-bundle/1') {
            const bundle = SyncBundleContentSchema.parse(entry.record.content);
            for (const file of bundle.files) for (const ref of file.parts) addRef(ref);
            const metadata = bundle.metadata as
              | { schema?: string; ruleVersions?: Array<{ opId: string; entityId: string }> }
              | undefined;
            if (metadata?.schema === 'wevir-workspace-snapshot/1') {
              if (!Array.isArray(metadata.ruleVersions))
                throw new ZuvRequestError('INTEGRITY_FAILED');
              for (const ref of metadata.ruleVersions) addRef(ref);
            }
          }
          yield {
            vaultId: vault.vaultId,
            entityId: entry.operation.entityId,
            opId: entry.operation.opId,
            entityType: entry.operation.entityType,
            operation: entry.operation,
            manifest: entry.recordManifest,
            record: entry.record,
          };
        }
        if (wanted?.size && !added) throw new ZuvRequestError('MISSING_PARENT');
      }
      if ([...refs.keys()].some((opId) => !seen.has(opId)))
        throw new ZuvRequestError('MISSING_PARENT');
    }
    return this.options.portable.stageRecords(versions(), {
      schema: 'wevir-portable-snapshot/1',
      exported: descriptor.exported,
      selection: { categories, projectIds: input.projectIds, includeReferencedMaterials: true },
    });
  }
  #vault(vaultId: string): SyncVaultRecord {
    const client = this.options.client;
    const identity = client.entitlements;
    if (
      !client.signedIn ||
      client.requiresLogin ||
      client.changingIdentity ||
      client.enrollment ||
      identity?.vault?.vaultId !== vaultId
    )
      throw new ZuvRequestError('AUTH_REQUIRED');
    return {
      vaultId,
      accountId: identity.identity.userId,
      deviceId: identity.identity.deviceId,
      originHostId: identity.identity.deviceId,
      deviceSeq: '0',
      active: false,
      enabled: false,
      revision: '0',
      categories: [],
      projectIds: [],
      appliedCursor: '',
    };
  }
}
