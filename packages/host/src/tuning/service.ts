// 调优的档案服务（0.85.0，`tuning.*`，domain-model §3.39，ADR-0014）：采集当前档案、在建会话时惰性开版本、列版本与比两版。
//
// 范围：项目（工作区）或全局（不带 `workspaceId`，也是“对话”工作区里的会话用的）。版本只在 `ensure`（建会话、恢复与接力时）里开：
// 当前指纹与这个范围最新的版本不同才开新的，相同就沿用；取当前档案（`tuning.get`）只采集、存文本，不开版本。

import {
  type MethodParams,
  type MethodResult,
  PROFILE_LAYERS,
  PROFILE_VERSION_SESSIONS_MAX,
  PROFILE_VERSIONS_PAGE_MAX,
  type ProfileItem,
  type ProfileItemChange,
  type ProfileLayer,
  type ProfileLayerChange,
  type ProfileLayerDiff,
  type ProfileVersionCause,
  ProfileVersionCauseSchema,
  type ProfileVersionId,
  type ProfileVersionRef,
  type ProfileVersionSummary,
  type SessionId,
  type WorkspaceId,
} from '@wevir/protocol';
import type { ProfileVersionRecord, Storage, WorkspaceRecord } from '@wevir/storage';
import { HostError } from '../errors.js';
import { newId } from '../ids.js';
import type { ProfileBlobStore } from './blobs.js';
import type { CollectedProfile, ProfileCollector, ProfileScopeInput } from './profile.js';

/** 存在 `profile_versions.manifest_json` 里的。 */
interface Manifest {
  layers: ProfileLayer[];
  wevirVersion?: string;
}

/** 当前档案的文本留多久再清（没有版本引用时）。 */
const UNREFERENCED_BLOB_TTL_MS = 24 * 60 * 60 * 1000;

export interface TuningServiceOptions {
  storage: Pick<Storage, 'profileVersions' | 'workspaces'>;
  collector: Pick<ProfileCollector, 'collect'>;
  blobs: ProfileBlobStore;
  wevirVersion?: string;
  /** “对话”工作区：里面的会话用全局档案。 */
  isChats?: (workspace: Pick<WorkspaceRecord, 'rootPath'>) => boolean;
  /**
   * 版本的由来（0.87.0）：`pending` 给出这个项目上一版之后采纳过的建议，开了新版本时记进它的 `cause`，再用 `recorded` 告诉建议
   * 产生了哪一版。指纹没变（不开版本）时建议留到下一次。
   */
  causes?: {
    pending(workspaceId: string): ProfileVersionCause | undefined;
    recorded(versionId: ProfileVersionId, cause: ProfileVersionCause): void;
  };
  now?: () => Date;
}

export class TuningService {
  readonly #storage: TuningServiceOptions['storage'];
  readonly #collector: TuningServiceOptions['collector'];
  readonly #blobs: ProfileBlobStore;
  readonly #wevirVersion: string | undefined;
  readonly #isChats: NonNullable<TuningServiceOptions['isChats']>;
  #causes: TuningServiceOptions['causes'];
  readonly #now: () => Date;
  readonly #listeners = new Set<(workspaceId: WorkspaceId | undefined) => void>();

  constructor(options: TuningServiceOptions) {
    this.#storage = options.storage;
    this.#collector = options.collector;
    this.#blobs = options.blobs;
    this.#wevirVersion = options.wevirVersion;
    this.#isChats = options.isChats ?? (() => false);
    this.#causes = options.causes;
    this.#now = options.now ?? (() => new Date());
  }

  /** 建议服务比档案服务后建（它要用档案服务），之后接上（0.87.0）。 */
  setCauses(causes: TuningServiceOptions['causes']): void {
    this.#causes = causes;
  }

  /** 档案可能变了（`tuning.changed`）。返回退订函数。 */
  watch(listener: (workspaceId: WorkspaceId | undefined) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 通知这个范围（省略是全局或不只一个项目）的档案可能变了：开了新版本，或记忆、设置、审批规则、插件改了。 */
  changed(workspaceId?: string): void {
    for (const listener of this.#listeners) listener(workspaceId as WorkspaceId | undefined);
  }

  /**
   * 建会话、恢复与接力时：采集这个工作区的档案，指纹与最新版本不同就开新版本。“对话”工作区用全局档案。工作区不在了时
   * `undefined`。
   */
  async ensure(workspaceId: string): Promise<ProfileVersionRef | undefined> {
    const workspace = this.#storage.workspaces.get(workspaceId);
    if (workspace === undefined) return undefined;
    const scope = this.#scopeOf(workspace);
    const profile = await this.#collect(scope);
    const manifest: Manifest = {
      layers: profile.layers,
      ...(this.#wevirVersion !== undefined && { wevirVersion: this.#wevirVersion }),
    };
    const cause =
      scope.workspaceId === undefined ? undefined : this.#causes?.pending(scope.workspaceId);
    const { version, created } = this.#storage.profileVersions.ensure({
      id: newId('pfv'),
      ...(scope.workspaceId !== undefined && { workspaceId: scope.workspaceId }),
      fingerprint: profile.fingerprint,
      manifest,
      createdAt: this.#now().toISOString(),
      ...(cause !== undefined && { cause }),
    });
    if (created && cause !== undefined) {
      this.#causes?.recorded(version.id as ProfileVersionId, cause);
    }
    if (created) this.changed(scope.workspaceId);
    return refOf(version);
  }

  async get(params: MethodParams<'tuning.get'>): Promise<MethodResult<'tuning.get'>> {
    const scope = this.#scopeFor(params.workspaceId);
    const profile = await this.#collect(scope);
    const latest = this.#storage.profileVersions.latest(scope.workspaceId);
    const pendingLayers =
      latest === undefined || latest.fingerprint === profile.fingerprint
        ? []
        : changedLayers(manifestOf(latest).layers, profile.layers);
    return {
      profile: {
        fingerprint: profile.fingerprint,
        layers: profile.layers,
        ...(this.#wevirVersion !== undefined && { wevirVersion: this.#wevirVersion }),
      },
      ...(latest !== undefined && { latest: this.#summaries([latest])[0] }),
      pending: latest !== undefined && latest.fingerprint !== profile.fingerprint,
      pendingLayers,
    };
  }

  versions(params: MethodParams<'tuning.versions'>): MethodResult<'tuning.versions'> {
    const scope = this.#scopeFor(params.workspaceId);
    const limit = Math.min(params.limit ?? 50, PROFILE_VERSIONS_PAGE_MAX);
    const before = params.cursor === undefined ? undefined : Number.parseInt(params.cursor, 10);
    const rows = this.#storage.profileVersions.list(scope.workspaceId, {
      ...(before !== undefined && Number.isFinite(before) && { beforeSeq: before }),
      limit: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      versions: this.#summaries(page, rows[limit]),
      ...(rows.length > limit && last !== undefined && { nextCursor: String(last.seq) }),
    };
  }

  version(params: MethodParams<'tuning.version'>): MethodResult<'tuning.version'> {
    const record = this.#version(params.versionId);
    const manifest = manifestOf(record);
    const [summary] = this.#summaries([record]);
    if (summary === undefined) throw new Error('unreachable');
    return {
      version: {
        ...summary,
        layers: manifest.layers,
        ...(manifest.wevirVersion !== undefined && { wevirVersion: manifest.wevirVersion }),
      },
      sessionIds: this.#storage.profileVersions.sessionIds(
        record.id,
        PROFILE_VERSION_SESSIONS_MAX,
      ) as SessionId[],
    };
  }

  async diff(params: MethodParams<'tuning.diff'>): Promise<MethodResult<'tuning.diff'>> {
    const from = this.#version(params.from);
    if (params.to === 'current') {
      const scope =
        from.workspaceId === undefined ? {} : this.#scopeFor(from.workspaceId as WorkspaceId);
      const profile = await this.#collect(scope);
      return {
        from: refOf(from),
        to: { fingerprint: profile.fingerprint },
        layers: diffLayers(manifestOf(from).layers, profile.layers),
      };
    }
    const to = this.#version(params.to);
    return {
      from: refOf(from),
      to: refOf(to),
      layers: diffLayers(manifestOf(from).layers, manifestOf(to).layers),
    };
  }

  async blob(params: MethodParams<'tuning.blob'>): Promise<MethodResult<'tuning.blob'>> {
    const text = await this.#blobs.read(params.hash);
    return text === undefined ? {} : { text };
  }

  /** 删掉没有版本引用、放了一天以上的文本。返回删了几个。 */
  async prune(): Promise<number> {
    const referenced = new Set<string>();
    for (const manifest of this.#storage.profileVersions.manifests()) {
      for (const layer of (manifest as Manifest).layers ?? []) {
        for (const item of layer.items) {
          if (item.text !== true) continue;
          referenced.add(item.textHash ?? item.hash);
        }
      }
    }
    return this.#blobs.prune(referenced, this.#now().getTime() - UNREFERENCED_BLOB_TTL_MS);
  }

  async #collect(scope: ProfileScopeInput): Promise<CollectedProfile> {
    const profile = await this.#collector.collect(scope, (hash) => this.#blobs.has(hash));
    await this.#blobs.write(profile.texts);
    return profile;
  }

  #scopeFor(workspaceId: WorkspaceId | undefined): ProfileScopeInput {
    if (workspaceId === undefined) return {};
    const workspace = this.#storage.workspaces.get(workspaceId);
    if (workspace === undefined || workspace.removedAt !== undefined) {
      throw new HostError('WORKSPACE_NOT_FOUND', `workspace ${workspaceId} not found`);
    }
    return this.#scopeOf(workspace);
  }

  #scopeOf(workspace: WorkspaceRecord): ProfileScopeInput {
    if (this.#isChats(workspace)) return {};
    return {
      workspaceId: workspace.id,
      rootPath: workspace.rootPath,
      ...(workspace.extraFolders !== undefined && { extraFolders: workspace.extraFolders }),
    };
  }

  #version(id: ProfileVersionId): ProfileVersionRecord {
    const record = this.#storage.profileVersions.get(id);
    if (record === undefined) {
      throw new HostError('PROFILE_VERSION_NOT_FOUND', `profile version ${id} not found`);
    }
    return record;
  }

  /** 版本的摘要：会话数与比前一版变了的层。`older` 是列表里最后一个的前一版（省得再查）。 */
  #summaries(
    records: readonly ProfileVersionRecord[],
    older?: ProfileVersionRecord,
  ): ProfileVersionSummary[] {
    const counts = this.#storage.profileVersions.sessionCounts(records.map((record) => record.id));
    return records.map((record, index) => {
      const previous =
        records[index + 1] ??
        (index === records.length - 1 && older !== undefined
          ? older
          : this.#storage.profileVersions.previous(record.workspaceId, record.seq));
      const changes =
        previous === undefined
          ? undefined
          : layerChanges(manifestOf(previous).layers, manifestOf(record).layers);
      const cause = ProfileVersionCauseSchema.safeParse(record.cause);
      return {
        ...refOf(record),
        ...(record.workspaceId !== undefined && {
          workspaceId: record.workspaceId as WorkspaceId,
        }),
        createdAt: record.createdAt,
        sessions: counts.get(record.id) ?? 0,
        ...(changes !== undefined && { changes }),
        ...(cause.success && { cause: cause.data }),
      };
    });
  }
}

function refOf(record: ProfileVersionRecord): ProfileVersionRef {
  return { id: record.id as ProfileVersionId, seq: record.seq, fingerprint: record.fingerprint };
}

function manifestOf(record: ProfileVersionRecord): Manifest {
  const manifest = record.manifest as Partial<Manifest> | null;
  return { ...manifest, layers: Array.isArray(manifest?.layers) ? manifest.layers : [] };
}

/** 层按 `PROFILE_LAYERS` 的先后，认不出的层排在后面。 */
function layerKeys(a: readonly ProfileLayer[], b: readonly ProfileLayer[]): string[] {
  const keys = new Set<string>([...a, ...b].map((layer) => layer.key));
  const known = PROFILE_LAYERS.filter((key) => keys.has(key));
  return [
    ...known,
    ...[...keys].filter((key) => !(PROFILE_LAYERS as readonly string[]).includes(key)),
  ];
}

/** 两版之间变了的层与条目。 */
export function diffLayers(
  before: readonly ProfileLayer[],
  after: readonly ProfileLayer[],
): ProfileLayerDiff[] {
  const out: ProfileLayerDiff[] = [];
  for (const key of layerKeys(before, after)) {
    const a = before.find((layer) => layer.key === key);
    const b = after.find((layer) => layer.key === key);
    if (a?.hash === b?.hash && a !== undefined) continue;
    const items = diffItems(a?.items ?? [], b?.items ?? []);
    if (items.length > 0) out.push({ key, items });
  }
  return out;
}

function diffItems(before: readonly ProfileItem[], after: readonly ProfileItem[]) {
  const old = new Map(before.map((item) => [item.id, item]));
  const changes: ProfileItemChange[] = [];
  for (const item of after) {
    const previous = old.get(item.id);
    old.delete(item.id);
    if (previous === undefined) {
      changes.push({
        id: item.id,
        label: item.label,
        scope: item.scope,
        change: 'added',
        after: item,
      });
    } else if (previous.hash !== item.hash || previous.scope !== item.scope) {
      changes.push({
        id: item.id,
        label: item.label,
        scope: item.scope,
        change: 'modified',
        before: previous,
        after: item,
      });
    }
  }
  for (const item of old.values()) {
    changes.push({
      id: item.id,
      label: item.label,
      scope: item.scope,
      change: 'removed',
      before: item,
    });
  }
  return changes;
}

function layerChanges(
  before: readonly ProfileLayer[],
  after: readonly ProfileLayer[],
): ProfileLayerChange[] {
  return diffLayers(before, after).map(({ key, items }) => ({
    key,
    added: items.filter((item) => item.change === 'added').length,
    removed: items.filter((item) => item.change === 'removed').length,
    modified: items.filter((item) => item.change === 'modified').length,
  }));
}

function changedLayers(before: readonly ProfileLayer[], after: readonly ProfileLayer[]): string[] {
  return diffLayers(before, after).map((layer) => layer.key);
}
