import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import type {
  ClientCapabilities,
  ClientIdentity,
  ErrorData,
  MethodName,
  MethodParams,
  MethodResult,
  ProviderProfile,
  SessionId,
  Workspace,
  WorkspaceId,
} from '@wevir/protocol';
import type { ProviderProfileRecord, SecretStore, Storage, WorkspaceRecord } from '@wevir/storage';
import { HostError } from './errors.js';
import type { EventStore } from './event-store.js';
import { newId } from './ids.js';
import type { SessionManager } from './session-manager.js';

/** 一次请求的上下文：发起请求的连接在 `host.hello` 里给出的身份与能力位。 */
export interface RequestContext {
  readonly client: ClientIdentity;
  readonly capabilities: ClientCapabilities;
}

export type MethodHandler<M extends MethodName> = (
  params: MethodParams<M>,
  context: RequestContext,
) => MethodResult<M> | Promise<MethodResult<M>>;

/** 由 RPC 连接自己处理的方法：握手、心跳、退出与订阅。 */
export type ConnectionMethodName =
  | 'host.hello'
  | 'host.ping'
  | 'host.shutdown'
  | 'events.subscribe'
  | 'events.unsubscribe';

/** 其余方法的实现表，RPC 层按方法注册表校验参数后分发到这里（host-api.md §3）。 */
export type HostMethodName = Exclude<MethodName, ConnectionMethodName>;
export type HostMethods = { [M in HostMethodName]: MethodHandler<M> };

export interface HostMethodsOptions {
  storage: Storage;
  events: EventStore;
  sessions: SessionManager;
  /** Provider 的 Key 只进这里，以 Provider ID 为键（domain-model §3.2）。 */
  secrets: SecretStore;
  /**
   * `provider.test` 的实际探测：用该 Provider 发一次最小请求。由引擎侧提供（T3.4）；没有时
   * `provider.test` 回 `ok: false`。
   */
  testProvider?: (
    provider: ProviderProfile,
    modelId: string,
  ) => Promise<MethodResult<'provider.test'>>;
}

/**
 * Host API 的业务方法（host-api.md §3.1）。会话与审批交给 `SessionManager`，工作区与 Provider 直接
 * 读写存储。参数已经过方法注册表校验；返回值由 RPC 层按注册表校验后再发出。
 */
export function createHostMethods(options: HostMethodsOptions): HostMethods {
  const { storage, events, sessions, secrets } = options;
  // Provider 的写操作要跨 await（先写 Key 再写行），串行执行，避免同一 ID 的两次 upsert 交错。
  let providerTail: Promise<unknown> = Promise.resolve();
  const serialProvider = <T>(op: () => Promise<T>): Promise<T> => {
    const result = providerTail.then(op);
    providerTail = result.catch(() => {});
    return result;
  };

  return {
    'workspace.list': () => ({ workspaces: storage.workspaces.list().map(toWorkspace) }),

    'workspace.add': async ({ rootPath, displayName }) => {
      const real = await resolveWorkspacePath(rootPath);
      // 查重与插入在同一个同步段里，两个并发的 add 不会都插入。
      const existing = storage.workspaces.getByRootPath(real);
      if (existing) {
        if (existing.removedAt !== undefined) storage.workspaces.restore(existing.id, isoNow());
        return { workspace: toWorkspace(mustGetWorkspace(storage, existing.id)), created: false };
      }
      const now = isoNow();
      const record: WorkspaceRecord = {
        id: newId('ws'),
        rootPath: real,
        displayName: displayName ?? (basename(real) || real),
        createdAt: now,
        updatedAt: now,
      };
      storage.workspaces.insert(record);
      return { workspace: toWorkspace(record), created: true };
    },

    'workspace.remove': ({ workspaceId }) => {
      const workspace = storage.workspaces.get(workspaceId);
      if (!workspace || workspace.removedAt !== undefined) {
        throw new HostError('WORKSPACE_NOT_FOUND', `workspace ${workspaceId} not found`);
      }
      const open = storage.sessions
        .list({ workspaceId })
        .filter((session) => session.state !== 'closed');
      if (open.length > 0) {
        throw new HostError('RESOURCE_IN_USE', `workspace ${workspaceId} has open sessions`, {
          sessionIds: open.map((session) => session.id as SessionId),
        });
      }
      storage.workspaces.markRemoved(workspaceId, isoNow());
      return {};
    },

    'provider.list': () => ({ providers: storage.providers.list().map(toProviderProfile) }),

    'provider.upsert': (params) =>
      serialProvider(async () => {
        const existing = storage.providers.get(params.id);
        if (existing && existing.kind !== params.kind) {
          throw invalidParams(['kind'], `kind of provider ${params.id} cannot be changed`);
        }
        if (
          params.kind === 'openai-compatible' &&
          !params.models.some((model) => model.id === params.defaultModelId)
        ) {
          throw invalidParams(['defaultModelId'], 'defaultModelId must be one of models');
        }

        let secretRef = existing?.secretRef;
        if (typeof params.apiKey === 'string') {
          secretRef = params.id;
          await secrets.set(secretRef, params.apiKey);
        } else if (params.apiKey === null) {
          if (secretRef !== undefined) await secrets.delete(secretRef);
          secretRef = undefined;
        }

        const now = isoNow();
        const record: ProviderProfileRecord = {
          id: params.id,
          kind: params.kind,
          displayName: params.displayName,
          models: params.models,
          defaultModelId: params.defaultModelId,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        if (params.baseURL !== undefined) record.baseURL = params.baseURL;
        if (params.kind === 'openai-compatible') {
          record.api = params.api;
          if (params.compat !== undefined) record.compat = params.compat;
        }
        if (secretRef !== undefined) record.secretRef = secretRef;
        if (existing) storage.providers.update(record);
        else storage.providers.insert(record);
        return { provider: toProviderProfile(record), created: !existing };
      }),

    'provider.remove': ({ providerId }) =>
      serialProvider(async () => {
        const provider = storage.providers.get(providerId);
        if (!provider) {
          throw new HostError('PROVIDER_NOT_FOUND', `provider ${providerId} not found`);
        }
        const open = storage.sessions
          .list({ includeRemovedWorkspaces: true })
          .filter((session) => session.providerId === providerId && session.state !== 'closed');
        if (open.length > 0) {
          throw new HostError(
            'RESOURCE_IN_USE',
            `provider ${providerId} is used by open sessions`,
            {
              sessionIds: open.map((session) => session.id as SessionId),
            },
          );
        }
        if (provider.secretRef !== undefined) await secrets.delete(provider.secretRef);
        storage.providers.delete(providerId);
        return {};
      }),

    'provider.test': async ({ providerId, modelId }) => {
      const provider = storage.providers.get(providerId);
      if (!provider) {
        throw new HostError('PROVIDER_NOT_FOUND', `provider ${providerId} not found`);
      }
      if (!options.testProvider) {
        return {
          ok: false,
          error: { category: 'unknown', message: 'provider test is not available in this host' },
        };
      }
      return options.testProvider(toProviderProfile(provider), modelId ?? provider.defaultModelId);
    },

    'session.create': async (params) => ({ session: await sessions.create(params) }),

    'session.list': ({ workspaceId }) => {
      if (workspaceId !== undefined) {
        const workspace = storage.workspaces.get(workspaceId);
        if (!workspace || workspace.removedAt !== undefined) {
          throw new HostError('WORKSPACE_NOT_FOUND', `workspace ${workspaceId} not found`);
        }
      }
      const records = storage.sessions.list(workspaceId === undefined ? {} : { workspaceId });
      return {
        sessions: records.flatMap((record) => {
          const snapshot = events.snapshot(record.id as SessionId);
          return snapshot ? [snapshot.session] : [];
        }),
      };
    },

    'session.get': ({ sessionId }) => {
      assertSessionVisible(storage, sessionId);
      const snapshot = events.snapshot(sessionId);
      if (!snapshot) throw sessionNotFound(sessionId);
      return snapshot;
    },

    'session.send': (params, { client }) => sessions.send(params, client),

    'session.cancel': async ({ sessionId }) => {
      await sessions.cancel(sessionId);
      return {};
    },

    'session.close': async ({ sessionId }) => {
      await sessions.close(sessionId);
      return {};
    },

    'session.resume': async ({ sessionId }) => ({ session: await sessions.resume(sessionId) }),

    'approval.respond': (params, { client }) => sessions.respondToApproval(params, client),
  };
}

/**
 * 会话存在且所属工作区未被移除，否则抛 `SESSION_NOT_FOUND`（host-api.md §7）。与
 * `SessionManager` 判断会话是否存在的口径一致。
 */
export function assertSessionVisible(storage: Storage, sessionId: SessionId): void {
  const record = storage.sessions.get(sessionId);
  const workspace = record && storage.workspaces.get(record.workspaceId);
  if (!record || !workspace || workspace.removedAt !== undefined) {
    throw sessionNotFound(sessionId);
  }
}

/** `workspace.add` 的路径检查：绝对路径、存在、是目录、可读可进入；返回 realpath。 */
async function resolveWorkspacePath(rootPath: string): Promise<string> {
  type Reason = ErrorData<'WORKSPACE_PATH_INVALID'>['reason'];
  const invalid = (reason: Reason) =>
    new HostError('WORKSPACE_PATH_INVALID', `workspace path is invalid: ${reason}`, {
      path: rootPath,
      reason,
    });
  if (!isAbsolute(rootPath)) throw invalid('not_absolute');
  let real: string;
  try {
    real = await realpath(rootPath);
    if (!(await stat(real)).isDirectory()) throw invalid('not_directory');
    await access(real, constants.R_OK | constants.X_OK);
  } catch (error) {
    if (error instanceof HostError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw invalid('not_found');
    if (code === 'ENOTDIR') throw invalid('not_directory');
    if (code === 'EACCES' || code === 'EPERM') throw invalid('not_accessible');
    throw error;
  }
  return real;
}

function mustGetWorkspace(storage: Storage, id: string): WorkspaceRecord {
  const record = storage.workspaces.get(id);
  if (!record) throw new Error(`工作区 ${id} 不存在`);
  return record;
}

function toWorkspace(record: WorkspaceRecord): Workspace {
  return {
    id: record.id as WorkspaceId,
    rootPath: record.rootPath,
    displayName: record.displayName,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/** 线缆上只暴露是否有 Key（`hasSecret`），不暴露 `secretRef`。 */
function toProviderProfile(record: ProviderProfileRecord): ProviderProfile {
  const profile = {
    id: record.id,
    kind: record.kind,
    displayName: record.displayName,
    models: record.models,
    defaultModelId: record.defaultModelId,
    hasSecret: record.secretRef !== undefined,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.api !== undefined && { api: record.api }),
    ...(record.baseURL !== undefined && { baseURL: record.baseURL }),
    ...(record.compat !== undefined && { compat: record.compat }),
  };
  // 记录里的枚举与 JSON 列是 string / unknown；形状由写入时的参数校验保证，发出前再按注册表校验。
  return profile as ProviderProfile;
}

function invalidParams(path: string[], message: string): HostError<'INVALID_PARAMS'> {
  return new HostError('INVALID_PARAMS', message, { issues: [{ path, message }] });
}

function sessionNotFound(sessionId: string): HostError<'SESSION_NOT_FOUND'> {
  return new HostError('SESSION_NOT_FOUND', `session ${sessionId} not found`);
}

function isoNow(): string {
  return new Date().toISOString();
}
