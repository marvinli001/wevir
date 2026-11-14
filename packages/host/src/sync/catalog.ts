import { SyncProjectContentSchema } from '@wevir/protocol';
import type { SyncVaultRecord } from '@wevir/storage';
import { ZuvRequestError } from '../zuv/transport.js';
import type { SyncRestoreData } from './restore-data.js';
import type { SyncSnapshots } from './snapshots.js';

interface CatalogOptions {
  snapshots: SyncSnapshots;
  data: SyncRestoreData;
  eligible: () => SyncVaultRecord | undefined;
}
export class SyncProjectCatalog {
  readonly #options: CatalogOptions;
  #controller: AbortController | undefined;
  #running: Promise<Awaited<ReturnType<SyncProjectCatalog['read']>>> | undefined;
  constructor(options: CatalogOptions) {
    this.#options = options;
  }
  get busy(): boolean {
    return this.#running !== undefined;
  }
  stop(): void {
    this.#controller?.abort();
  }
  async drain(): Promise<void> {
    await this.#running?.catch(() => {});
  }
  fetch() {
    const vault = this.#options.eligible();
    if (!vault?.categories.includes('project')) throw new ZuvRequestError('SCOPE_DISABLED');
    if (this.#running) return this.#running;
    this.#controller = new AbortController();
    this.#running = this.read(vault, this.#controller.signal).finally(() => {
      this.#running = undefined;
      this.#controller = undefined;
    });
    return this.#running;
  }
  private async read(vault: SyncVaultRecord, signal: AbortSignal) {
    const { snapshots, data, eligible } = this.#options;
    const plan = await snapshots.prepare(vault, signal);
    const projects = new Map<
      string,
      {
        versions: Map<
          string,
          {
            opId: string;
            deviceId?: string;
            clientTime?: string;
            displayName?: string;
            repoUrl?: string;
            deleted: boolean;
          }
        >;
        parents: Set<string>;
      }
    >();
    for await (const entry of data.records(
      plan.jobId,
      vault,
      { categories: ['project'], projectIds: plan.projectIds },
      signal,
    )) {
      const op = entry.operation;
      const project = projects.get(op.entityId) ?? { versions: new Map(), parents: new Set() };
      if (op.kind === 'delete')
        project.versions.set(op.opId, {
          opId: op.opId,
          deviceId: op.deviceId,
          clientTime: op.clientTime,
          deleted: true,
        });
      else {
        if ((entry.record.content as { schema?: string })?.schema !== 'wevir-project/1')
          throw new ZuvRequestError('UPGRADE_REQUIRED');
        const body = SyncProjectContentSchema.safeParse(entry.record.content);
        if (!body.success || body.data.projectId !== op.entityId)
          throw new ZuvRequestError('INTEGRITY_FAILED');
        project.versions.set(op.opId, {
          opId: op.opId,
          deviceId: op.deviceId,
          clientTime: op.clientTime,
          displayName: body.data.displayName,
          ...(body.data.repoUrl && { repoUrl: body.data.repoUrl }),
          deleted: false,
        });
      }
      for (const parent of op.parents) project.parents.add(parent);
      projects.set(op.entityId, project);
      if (projects.size > 1000) throw new ZuvRequestError('QUOTA_EXCEEDED');
    }
    const current = eligible();
    if (
      signal.aborted ||
      current?.vaultId !== vault.vaultId ||
      current.deviceId !== vault.deviceId ||
      current.revision !== vault.revision
    )
      throw new ZuvRequestError('SCOPE_DISABLED');
    const result = [...projects].map(([projectId, value]) => {
      const versions = [...value.versions.values()]
        .filter((version) => !value.parents.has(version.opId))
        .sort((a, b) => a.opId.localeCompare(b.opId));
      if (!versions.length) throw new ZuvRequestError('INTEGRITY_FAILED');
      if (versions.length > 32) throw new ZuvRequestError('QUOTA_EXCEEDED');
      return { projectId, versions };
    });
    return {
      projects: result
        .filter((value) => value.versions.some((version) => !version.deleted))
        .sort((a, b) => a.projectId.localeCompare(b.projectId)),
    };
  }
}
