import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import type {
  ClientCapabilities,
  ClientIdentity,
  Environment,
  EnvironmentFolder,
  EnvironmentId,
  ErrorData,
  MethodName,
  MethodParams,
  MethodResult,
  ProviderProfile,
  Session,
  SessionId,
  Workspace,
  WorkspaceId,
} from '@wevir/protocol';
import type { AgentRuntimeAdapter, ProviderConfig } from '@wevir/runtime-adapter';
import type {
  EnvironmentRecord,
  ProviderProfileRecord,
  SecretStore,
  Storage,
  WorkspaceRecord,
} from '@wevir/storage';
import { CHATGPT_PROVIDER_ID, type HostAccounts } from './accounts.js';
import type { ChatFolders } from './chats.js';
import type { TurnCheckpoints } from './checkpoints.js';
import { HostError } from './errors.js';
import type { EventStore } from './event-store.js';
import { type FileUrls, isServablePath } from './file-urls.js';
import { isSafeRelativePath, readBranch, readDiffFile, readUncommitted } from './git-diff.js';
import { readGitStatus } from './git-status.js';
import { newId } from './ids.js';
import type { ImageStore } from './images.js';
import { discoverOllamaModels, ollamaOrigin } from './ollama-models.js';
import type { PluginRegistry } from './plugins.js';
import type { SessionManager } from './session-manager.js';
import { HostSettingsStore } from './settings.js';
import type { WebService } from './web/service.js';
import {
  DEFAULT_FILES_LIMIT,
  FileIndex,
  listDirectory,
  readWorkspaceFile,
  searchIndex,
  statWorkspaceFile,
  WriteRejected,
  writeWorkspaceFile,
} from './workspace-files.js';

/** 一次请求的上下文：发起请求的连接在 `host.hello` 里给出的身份与能力位。 */
export interface RequestContext {
  readonly client: ClientIdentity;
  readonly capabilities: ClientCapabilities;
}

export type MethodHandler<M extends MethodName> = (
  params: MethodParams<M>,
  context: RequestContext,
) => MethodResult<M> | Promise<MethodResult<M>>;

/** 由 RPC 连接自己处理的方法：握手、心跳、退出、订阅与浏览器提供方（0.33.0，登记的是这条连接）。 */
export type ConnectionMethodName =
  | 'host.hello'
  | 'host.ping'
  | 'host.shutdown'
  | 'events.subscribe'
  | 'events.unsubscribe'
  | 'browser.register'
  | 'browser.unregister'
  | 'browser.respond';

/** 其余方法的实现表，RPC 层按方法注册表校验参数后分发到这里（host-api.md §3）。 */
export type HostMethodName = Exclude<MethodName, ConnectionMethodName>;
export type HostMethods = { [M in HostMethodName]: MethodHandler<M> };

export interface HostMethodsOptions {
  plugins?: PluginRegistry;
  storage: Storage;
  events: EventStore;
  sessions: SessionManager;
  /** Provider 的 Key 只进这里，以 Provider ID 为键（domain-model §3.2）。 */
  secrets: SecretStore;
  /**
   * 引擎侧的 Provider 桥接（T3.4，`AgentRuntimeAdapter` 的可选方法）：写库前检查配置、每次变更后换上整套
   * Provider（含 Key）、`provider.test` 的探测。适配器没实现的部分跳过；没有 `testProvider` 时
   * `provider.test` 回 `ok: false`。
   */
  providers?: ProviderBridge;
  /** 引擎的账号（R6，`account.*`）；引擎没有账号时省略，`account.*` 回 `ENGINE_ERROR`。 */
  accounts?: HostAccounts;
  /** Provider 写操作的串行锁；与 `HostAccounts` 共用，默认新建一个。 */
  providerLock?: ProviderLock;
  /** Host 设置（R11，`settings.*`）；省略时只在内存里（测试）。 */
  settings?: HostSettingsStore;
  /** 回合快照（0.20.0）；省略时 `workspace.diff` 的 `turn` 回 `unavailable`，`session.checkpoints` 为空（测试）。 */
  checkpoints?: TurnCheckpoints;
  /** 消息里的图片（0.28.0）；省略时 `image.*` 回 `INVALID_PARAMS`（测试）。 */
  images?: ImageStore;
  /** 文件预览的流式地址（0.32.0）；省略时 `workspace.fileUrl` 回 `unavailable: 'not_found'`（测试）。 */
  fileUrls?: FileUrls;
  /** 联网服务（0.34.0，`web.*`）；省略时 `web.*` 回 `INVALID_PARAMS`，Host 也不声明 `web_tools`。 */
  web?: WebService;
  /** 不在项目里的会话（0.39.0）：认出“对话”工作区（`kind: 'chats'`）；与 SessionManager 用同一个。 */
  chats?: ChatFolders;
}

/** Provider 的写操作要跨 await（先写 Key 再写行），串行执行，避免同一 ID 的两次写入交错。 */
export type ProviderLock = <T>(op: () => Promise<T>) => Promise<T>;

export function createProviderLock(): ProviderLock {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(op: () => Promise<T>): Promise<T> => {
    const result = tail.then(op);
    tail = result.catch(() => {});
    return result;
  };
}

export type ProviderBridge = Pick<
  AgentRuntimeAdapter,
  'validateProvider' | 'configureProviders' | 'testProvider' | 'googleVertex'
>;

/**
 * 把存储里的全部 Provider（含 Key）交给引擎（`configureProviders`）。Host 启动时调用一次，之后每次
 * `provider.upsert` / `provider.remove` 写库后调用（`createHostMethods` 内部）。
 */
export async function syncProviders(
  storage: Storage,
  secrets: SecretStore,
  bridge: ProviderBridge | undefined,
): Promise<void> {
  if (bridge?.configureProviders === undefined) return;
  const configs = await Promise.all(
    storage.providers
      .list()
      .map(async (record) => toProviderConfig(record, await secretOf(secrets, record))),
  );
  await bridge.configureProviders(configs);
}

/**
 * Host API 的业务方法（host-api.md §3.1）。会话与审批交给 `SessionManager`，工作区与 Provider 直接
 * 读写存储。参数已经过方法注册表校验；返回值由 RPC 层按注册表校验后再发出。
 */
export function createHostMethods(options: HostMethodsOptions): HostMethods {
  const plugins = (): PluginRegistry => {
    if (!options.plugins)
      throw new HostError('INVALID_PARAMS', 'This Host has no plugin registry', { issues: [] });
    return options.plugins;
  };
  const { storage, events, sessions, secrets, providers: bridge, accounts } = options;
  const settings = options.settings ?? new HostSettingsStore();
  const webService = (): WebService => {
    if (options.web === undefined) throw invalidParams([], 'this host has no web service');
    return options.web;
  };
  const imageStore = (): ImageStore => {
    if (options.images === undefined) throw invalidParams([], 'this host does not store images');
    return options.images;
  };
  /**
   * `workspace.git` / `workspace.diff*` 读的目录：工作区目录，给了会话时是会话的目录（0.15.0 起环境会话的 worktree）。工作区
   * 不在或已移除回 WORKSPACE_NOT_FOUND，会话不属于它回 SESSION_NOT_FOUND。
   */
  const diffDirectory = (workspaceId: string, sessionId: string | undefined): string => {
    const workspace = storage.workspaces.get(workspaceId);
    if (!workspace || workspace.removedAt !== undefined) {
      throw new HostError('WORKSPACE_NOT_FOUND', `workspace ${workspaceId} not found`);
    }
    if (sessionId === undefined) {
      // “对话”工作区下是各个会话的文件夹，只能按会话读。
      if (options.chats?.isChats(workspace) === true) {
        throw invalidParams(['sessionId'], 'the chats workspace is read per session');
      }
      return workspace.rootPath;
    }
    const session = storage.sessions.get(sessionId);
    if (!session || session.workspaceId !== workspaceId) throw sessionNotFound(sessionId);
    return session.cwd;
  };
  // 写库成功之后才调用；引擎没能用上新配置时 Profile 仍已保存，报 ENGINE_ERROR 说明这一点。
  const applyProviders = async () => {
    try {
      await syncProviders(storage, secrets, bridge);
    } catch (error) {
      const message = `provider saved, but the engine could not apply it: ${errorText(error)}`;
      throw new HostError('ENGINE_ERROR', message, { category: 'unknown', message });
    }
  };
  const serialProvider = options.providerLock ?? createProviderLock();
  const toWorkspace = (record: WorkspaceRecord): Workspace => ({
    id: record.id as WorkspaceId,
    rootPath: record.rootPath,
    displayName: record.displayName,
    ...(options.chats?.isChats(record) === true && { kind: 'chats' as const }),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
  /** 会话加上存储里的归档时刻（0.23.0，不是事件推导的）。 */
  const withArchive = (session: Session): Session => {
    const archivedAt = storage.sessions.get(session.id)?.archivedAt;
    return archivedAt === undefined ? session : { ...session, archivedAt };
  };
  // 0.22.0：@ 提及与文件窗格的名字搜索，按目录缓存几秒。
  const fileIndex = new FileIndex();
  const requireAccounts = (): HostAccounts => {
    if (accounts === undefined) {
      const message = 'this host has no engine with accounts (use the Codex engine)';
      throw new HostError('ENGINE_ERROR', message, { category: 'unknown', message });
    }
    return accounts;
  };

  /**
   * `provider.upsert` 的 `chatgpt`（R6）：模型列表向引擎要，客户端只改显示名与默认模型。引擎没有账号时与引擎不接受的配置
   * 一样回 `INVALID_PARAMS`。
   */
  const upsertChatgpt = async (
    params: Extract<MethodParams<'provider.upsert'>, { kind: 'chatgpt' }>,
  ): Promise<MethodResult<'provider.upsert'>> => {
    if (accounts === undefined) {
      const message = 'the engine does not accept this provider: no ChatGPT account in this host';
      throw new HostError('INVALID_PARAMS', message, { issues: [{ path: ['kind'], message }] });
    }
    const { models } = await accounts.models('chatgpt');
    if (!models.some((model) => model.id === params.defaultModelId)) {
      throw invalidParams(['defaultModelId'], 'defaultModelId must be one of the account models');
    }
    return serialProvider(async () => {
      const existing = storage.providers.get(CHATGPT_PROVIDER_ID);
      if (existing && existing.kind !== 'chatgpt') {
        throw invalidParams(['kind'], `kind of provider ${CHATGPT_PROVIDER_ID} cannot be changed`);
      }
      const now = isoNow();
      const record: ProviderProfileRecord = {
        id: CHATGPT_PROVIDER_ID,
        kind: 'chatgpt',
        displayName: params.displayName,
        models,
        defaultModelId: params.defaultModelId,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      if (existing?.enabled === false) record.enabled = false;
      if (existing) storage.providers.update(record);
      else storage.providers.insert(record);
      await applyProviders();
      return { provider: toProviderProfile(record), created: !existing };
    });
  };

  return {
    'plugins.list': () => plugins().list(),
    'connector.add': async ({ name, config, enabled }) => ({
      connector: await plugins().add(name, config, enabled),
    }),
    'connector.update': async ({ id, ...patch }) => ({
      connector: await plugins().update(id, patch),
    }),
    'connector.remove': async ({ id }) => {
      await plugins().removeConnector(id);
      return {};
    },
    'connector.setEnabled': async ({ id, enabled }) => ({
      connector: await plugins().update(id, { enabled }),
    }),
    'skill.install': ({ path }) => plugins().install(path),
    'skill.remove': async ({ id }) => {
      await plugins().removeSkill(id);
      return {};
    },
    'skill.setEnabled': async ({ id, enabled }) => ({
      skill: await plugins().setSkillEnabled(id, enabled),
    }),
    'workspace.list': () => ({ workspaces: storage.workspaces.list().map(toWorkspace) }),

    'workspace.add': async ({ rootPath, displayName }) => {
      const real = await resolveWorkspacePath(rootPath);
      if (options.chats?.owns(real) === true) {
        throw invalidParams(['rootPath'], 'this folder holds Wevir chats');
      }
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
      if (options.chats?.isChats(workspace) === true) {
        throw invalidParams(['workspaceId'], 'the chats workspace cannot be removed');
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

    // 0.15.0（U22.1，domain-model §3.10）：保存的环境。
    'environment.list': () => ({
      environments: storage.environments.list().map(toEnvironment),
    }),

    'environment.create': ({ name, folders }) => {
      const now = isoNow();
      const record: EnvironmentRecord = {
        id: newId('env'),
        name: environmentName(name),
        location: { kind: 'local' },
        folders: checkEnvironmentFolders(storage, folders, options.chats),
        createdAt: now,
        updatedAt: now,
      };
      storage.environments.insert(record);
      return { environment: toEnvironment(record) };
    },

    'environment.update': ({ environmentId, name, folders }) => {
      const current = storage.environments.get(environmentId);
      if (!current) {
        throw new HostError('ENVIRONMENT_NOT_FOUND', `environment ${environmentId} not found`);
      }
      const record: EnvironmentRecord = {
        ...current,
        ...(name !== undefined && { name: environmentName(name) }),
        ...(folders !== undefined && {
          folders: checkEnvironmentFolders(storage, folders, options.chats),
        }),
        updatedAt: isoNow(),
      };
      storage.environments.update(record);
      return { environment: toEnvironment(record) };
    },

    'environment.remove': ({ environmentId }) => {
      if (!storage.environments.remove(environmentId)) {
        throw new HostError('ENVIRONMENT_NOT_FOUND', `environment ${environmentId} not found`);
      }
      return {};
    },

    // 0.13.0（U18）：每次现读，目录已不存在时同 workspace.add 回 WORKSPACE_PATH_INVALID。
    'workspace.git': async ({ workspaceId, sessionId }) =>
      readGitStatus(await resolveWorkspacePath(diffDirectory(workspaceId, sessionId))),

    // 0.20.0：改动的 diff。`turn` 要给会话，读这个会话目录里的快照。
    'workspace.diff': async ({ workspaceId, sessionId, source }) => {
      if (source.kind === 'turn' && sessionId === undefined) {
        throw invalidParams(['sessionId'], 'a turn diff needs sessionId');
      }
      const dir = await resolveWorkspacePath(diffDirectory(workspaceId, sessionId));
      if (source.kind === 'uncommitted') return readUncommitted(dir);
      if (source.kind === 'branch') return readBranch(dir);
      if (!options.checkpoints || sessionId === undefined) {
        return { repo: true, unavailable: 'no_checkpoint' };
      }
      return options.checkpoints.diff(sessionId, dir, source.turnId);
    },

    'workspace.diffFile': async ({ workspaceId, sessionId, oldRev, oldPath, newRev, newPath }) => {
      for (const [key, value] of [
        ['oldPath', oldPath],
        ['newPath', newPath],
      ] as const) {
        if (value !== undefined && !isSafeRelativePath(value)) {
          throw invalidParams([key], `${key} must be a relative path inside the directory`);
        }
      }
      if (oldPath !== undefined && oldRev === undefined) {
        throw invalidParams(['oldRev'], 'oldPath needs oldRev');
      }
      const dir = await resolveWorkspacePath(diffDirectory(workspaceId, sessionId));
      return (
        (await readDiffFile(dir, {
          ...(oldRev !== undefined && { oldRev }),
          ...(oldPath !== undefined && { oldPath }),
          ...(newRev !== undefined && { newRev }),
          ...(newPath !== undefined && { newPath }),
        })) ?? { unavailable: 'not_found' }
      );
    },

    // 0.22.0：工作区的文件。路径相对会话目录（或工作区根目录），不能往上走。
    'workspace.files': async ({ workspaceId, sessionId, query, limit, kind }) => {
      const dir = await resolveWorkspacePath(diffDirectory(workspaceId, sessionId));
      return searchIndex(await fileIndex.snapshot(dir), query, limit ?? DEFAULT_FILES_LIMIT, kind);
    },

    'workspace.listDir': async ({ workspaceId, sessionId, path }) => {
      if (path !== '' && !isSafeRelativePath(path)) {
        throw invalidParams(['path'], 'path must be a relative path inside the directory');
      }
      return listDirectory(await resolveWorkspacePath(diffDirectory(workspaceId, sessionId)), path);
    },

    'workspace.readFile': async ({ workspaceId, sessionId, path }) => {
      if (!isSafeRelativePath(path)) {
        throw invalidParams(['path'], 'path must be a relative path inside the directory');
      }
      return readWorkspaceFile(
        await resolveWorkspacePath(diffDirectory(workspaceId, sessionId)),
        path,
      );
    },

    // 0.32.0：文件预览的流式地址与编辑的写回。
    'workspace.fileUrl': async ({ workspaceId, sessionId, path }) => {
      if (!isSafeRelativePath(path)) {
        throw invalidParams(['path'], 'path must be a relative path inside the directory');
      }
      const root = await resolveWorkspacePath(diffDirectory(workspaceId, sessionId));
      const file = await statWorkspaceFile(root, path);
      if (!file || !options.fileUrls) return { path, unavailable: 'not_found' };
      // 令牌下只读得到能预览的类型（file-urls.ts），其余的文件不发地址。
      if (!isServablePath(path)) return { path, unavailable: 'unsupported' };
      const { url, expiresAt } = options.fileUrls.issue(root, path);
      return { path, url, size: file.size, mtimeMs: file.mtimeMs, expiresAt };
    },

    'workspace.writeFile': async ({ workspaceId, sessionId, path, text, expectedMtimeMs }) => {
      if (!isSafeRelativePath(path)) {
        throw invalidParams(['path'], 'path must be a relative path inside the directory');
      }
      const root = await resolveWorkspacePath(diffDirectory(workspaceId, sessionId));
      try {
        return await writeWorkspaceFile(root, path, text, expectedMtimeMs);
      } catch (error) {
        if (error instanceof WriteRejected) throw invalidParams(['path'], error.message);
        throw error;
      }
    },

    'session.checkpoints': async ({ sessionId }) => {
      const session = storage.sessions.get(sessionId);
      if (!session) throw sessionNotFound(sessionId);
      if (!options.checkpoints) return { repo: false, turns: [] };
      return options.checkpoints.list(sessionId, await resolveWorkspacePath(session.cwd));
    },

    'provider.list': () => ({ providers: storage.providers.list().map(toProviderProfile) }),

    'provider.upsert': async (params) => {
      if (params.kind === 'chatgpt') return upsertChatgpt(params);
      if (params.kind === 'google-vertex' && bridge?.googleVertex !== true)
        throw invalidParams(['kind'], 'this engine does not support Google Vertex');
      return serialProvider(async () => {
        const existing = storage.providers.get(params.id);
        if (existing && existing.kind !== params.kind) {
          throw invalidParams(['kind'], `kind of provider ${params.id} cannot be changed`);
        }
        if (
          (params.kind === 'openai-compatible' || params.kind === 'google-vertex') &&
          !params.models.some((model) => model.id === params.defaultModelId)
        ) {
          throw invalidParams(['defaultModelId'], 'defaultModelId must be one of models');
        }

        const candidate: ProviderConfig = toProviderConfig(
          {
            id: params.id,
            kind: params.kind,
            displayName: params.displayName,
            models: params.models,
            defaultModelId: params.defaultModelId,
            createdAt: '',
            updatedAt: '',
            ...('baseURL' in params && params.baseURL !== undefined && { baseURL: params.baseURL }),
            ...(params.kind !== 'deepseek-official' && {
              api: params.api,
              ...(params.kind === 'google-vertex' &&
                params.vertex !== undefined && { vertex: params.vertex }),
              ...(params.compat !== undefined && { compat: params.compat }),
            }),
          },
          undefined,
        );
        const issues = bridge?.validateProvider?.(candidate) ?? [];
        if (issues.length > 0) {
          throw new HostError(
            'INVALID_PARAMS',
            `the engine does not accept this provider: ${issues.map((i) => i.message).join('; ')}`,
            { issues },
          );
        }

        let secretRef = existing?.secretRef;
        const secret = params.kind === 'google-vertex' ? params.serviceAccountJson : params.apiKey;
        if (typeof secret === 'string') {
          secretRef = params.id;
          await secrets.set(secretRef, secret);
        } else if (secret === null) {
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
        if ('baseURL' in params && params.baseURL !== undefined) record.baseURL = params.baseURL;
        if (params.kind === 'google-vertex' && params.vertex !== undefined)
          record.vertex = params.vertex;
        if (params.kind !== 'deepseek-official') {
          record.api = params.api;
          if (params.compat !== undefined) record.compat = params.compat;
        }
        if (secretRef !== undefined) record.secretRef = secretRef;
        if (existing?.enabled === false) record.enabled = false;
        if (existing) storage.providers.update(record);
        else storage.providers.insert(record);
        await applyProviders();
        return { provider: toProviderProfile(record), created: !existing };
      });
    },

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
        await applyProviders();
        return {};
      }),

    'provider.test': async ({ providerId, modelId }) => {
      const provider = storage.providers.get(providerId);
      if (!provider) {
        throw new HostError('PROVIDER_NOT_FOUND', `provider ${providerId} not found`);
      }
      if (bridge?.testProvider === undefined) {
        return {
          ok: false,
          error: { category: 'unknown', message: 'provider test is not available in this host' },
          reason: 'unknown',
        };
      }
      const config = toProviderConfig(provider, await secretOf(secrets, provider));
      return bridge.testProvider(config, modelId ?? provider.defaultModelId);
    },

    'provider.discoverModels': async ({ providerId, baseURL, apiKey, modelId }) => {
      if ((providerId === undefined) === (baseURL === undefined) || (providerId && apiKey))
        throw invalidParams(
          ['providerId'],
          'provide a stored providerId or an unsaved baseURL and key',
        );
      if (providerId !== undefined) {
        const target = await serialProvider(async () => {
          const provider = storage.providers.get(providerId);
          if (!provider)
            throw new HostError('PROVIDER_NOT_FOUND', `provider ${providerId} not found`);
          if (provider.kind !== 'openai-compatible')
            throw invalidParams(
              ['providerId'],
              'Ollama discovery requires an OpenAI-compatible provider',
            );
          // Snapshot endpoint and credential under the same lock as provider.upsert.
          ollamaOrigin(provider.baseURL ?? '');
          return {
            baseURL: provider.baseURL ?? '',
            apiKey: await secretOf(secrets, provider),
            modelId,
          };
        });
        return discoverOllamaModels(target);
      }
      return discoverOllamaModels({ baseURL: baseURL ?? '', apiKey, modelId });
    },

    'provider.setEnabled': ({ providerId, enabled }) =>
      serialProvider(async () => {
        const provider = storage.providers.get(providerId);
        if (!provider) {
          throw new HostError('PROVIDER_NOT_FOUND', `provider ${providerId} not found`);
        }
        const { enabled: _was, ...rest } = provider;
        const record: ProviderProfileRecord = enabled ? rest : { ...rest, enabled: false };
        if ((provider.enabled !== false) !== enabled) {
          record.updatedAt = isoNow();
          storage.providers.update(record);
        }
        return { provider: toProviderProfile(record) };
      }),

    'account.list': async () => ({ accounts: await requireAccounts().list() }),

    'account.get': async ({ kind, refresh }) => ({
      account: await requireAccounts().read(kind, refresh === true ? { refresh } : undefined),
    }),

    'account.setPath': async ({ kind, path }) => ({
      account: await requireAccounts().setPath(kind, path),
    }),

    'account.install': async ({ kind }) => ({ account: await requireAccounts().install(kind) }),

    'account.login': async ({ kind, method }) => ({
      account: await requireAccounts().login(kind, method),
    }),

    'account.cancelLogin': async ({ kind, loginId }) => ({
      account: await requireAccounts().cancelLogin(kind, loginId),
    }),

    'account.logout': async ({ kind }) => ({ account: await requireAccounts().logout(kind) }),

    'session.create': async (params) => ({ session: await sessions.create(params) }),

    'session.list': ({ workspaceId, parentSessionId, archived }) => {
      if (workspaceId !== undefined) {
        const workspace = storage.workspaces.get(workspaceId);
        if (!workspace || workspace.removedAt !== undefined) {
          throw new HostError('WORKSPACE_NOT_FOUND', `workspace ${workspaceId} not found`);
        }
      }
      // 默认不含子会话；给了 parentSessionId 只列它的子会话（domain-model §3.3.1）。
      if (parentSessionId !== undefined) assertSessionVisible(storage, parentSessionId);
      // 0.23.0：默认不含已归档的会话，archived 时只列它们。
      const records = storage.sessions.list({
        ...(workspaceId !== undefined && { workspaceId }),
        ...(parentSessionId !== undefined && { parentSessionId }),
        ...(archived === true && { archived: 'only' as const }),
      });
      return {
        sessions: records.flatMap((record) => {
          const snapshot = events.snapshot(record.id as SessionId);
          return snapshot ? [withArchive(snapshot.session)] : [];
        }),
      };
    },

    'session.get': ({ sessionId }) => {
      assertSessionVisible(storage, sessionId);
      const snapshot = events.snapshot(sessionId);
      if (!snapshot) throw sessionNotFound(sessionId);
      return { ...snapshot, session: withArchive(snapshot.session) };
    },

    // 0.23.0：用户改名，标题去掉首尾空白后不能是空的。
    'session.rename': async ({ sessionId, title }) => {
      assertSessionVisible(storage, sessionId);
      const trimmed = title.trim();
      if (trimmed === '') throw invalidParams(['title'], 'title must not be blank');
      return { session: withArchive(await sessions.rename(sessionId, trimmed)) };
    },

    // 0.23.0：归档前先关闭会话；只有顶层、不是支线的会话能归档。已归档时不改时刻。
    'session.archive': async ({ sessionId, archived }) => {
      assertSessionVisible(storage, sessionId);
      const record = storage.sessions.get(sessionId);
      if (!record) throw sessionNotFound(sessionId);
      if (record.parentSessionId !== undefined || record.side) {
        throw invalidParams(['sessionId'], 'only top-level sessions can be archived');
      }
      if (archived) {
        await sessions.close(sessionId);
        if (record.archivedAt === undefined) storage.sessions.setArchived(sessionId, isoNow());
      } else {
        storage.sessions.setArchived(sessionId, undefined);
      }
      const snapshot = events.snapshot(sessionId);
      if (!snapshot) throw sessionNotFound(sessionId);
      return { session: withArchive(snapshot.session) };
    },

    'session.configure': async (params) => ({ session: await sessions.configure(params) }),

    'session.send': (params, { client }) => sessions.send(params, client),

    'session.cancel': async ({ sessionId }) => {
      await sessions.cancel(sessionId);
      return {};
    },

    'session.close': async ({ sessionId }) => {
      await sessions.close(sessionId);
      return {};
    },

    // 恢复一个已归档的会话（在它里面接着发消息）即取消归档（0.23.0）。
    'session.resume': async ({ sessionId }) => {
      const session = await sessions.resume(sessionId);
      if (storage.sessions.get(sessionId)?.archivedAt !== undefined) {
        storage.sessions.setArchived(sessionId, undefined);
      }
      return { session };
    },

    'session.fork': async (params) => ({ session: await sessions.fork(params) }),
    'session.rewind': (params) => sessions.rewind(params),

    // 0.24.0：由命令开始的回合，没有 user.message（domain-model §4.7）。
    'session.compact': ({ sessionId }) => sessions.compact(sessionId),

    'session.review': ({ sessionId, target }) => sessions.review(sessionId, target),

    // 0.35.0：会话目标。
    'session.setGoal': (params, { client }) => sessions.setGoal(params, client),

    'session.updateGoal': ({ sessionId, status }) => sessions.updateGoal(sessionId, status),

    'session.clearGoal': ({ sessionId }) => sessions.clearGoal(sessionId),

    'pending.update': async (params) => ({ pending: await sessions.updatePending(params) }),

    'pending.cancel': (params) => ({ pending: sessions.cancelPending(params) }),

    'pending.resume': async ({ sessionId }) => ({
      pendingMessages: await sessions.resumePending(sessionId),
    }),

    'image.upload': async (params) => ({ image: await imageStore().upload(params) }),

    'image.read': (params) => imageStore().read(params),

    'settings.get': () => ({ settings: settings.get() }),

    'settings.update': async (params) => ({ settings: await settings.update(params.settings) }),

    'web.get': async () => ({ web: webService().settings() }),
    'web.update': async (params) => ({ web: await webService().update(params) }),
    'web.test': (params) => webService().test(params),

    'question.respond': (params, { client }) => sessions.respondToQuestion(params, client),

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
    ...(record.vertex !== undefined && { vertex: record.vertex }),
    ...(record.enabled === false && { enabled: false }),
  };
  // 记录里的枚举与 JSON 列是 string / unknown；形状由写入时的参数校验保证，发出前再按注册表校验。
  return profile as ProviderProfile;
}

/** 存储的一行 + Key → 交给引擎的 Provider。`models`、`compat` 是写入时已校验过的 protocol 形状。 */
function toProviderConfig(
  record: ProviderProfileRecord,
  apiKey: string | undefined,
): ProviderConfig {
  const config: ProviderConfig = {
    id: record.id,
    kind: record.kind as ProviderConfig['kind'],
    displayName: record.displayName,
    models: record.models as ProviderConfig['models'],
    defaultModelId: record.defaultModelId,
  };
  if (record.api !== undefined) config.api = record.api;
  if (record.baseURL !== undefined) config.baseURL = record.baseURL;
  if (record.compat !== undefined) config.compat = record.compat as ProviderConfig['compat'];
  if (record.vertex !== undefined) config.vertex = record.vertex;
  if (apiKey !== undefined) {
    if (record.kind === 'google-vertex') config.serviceAccountJson = apiKey;
    else config.apiKey = apiKey;
  }
  return config;
}

async function secretOf(
  secrets: SecretStore,
  record: ProviderProfileRecord,
): Promise<string | undefined> {
  return record.secretRef === undefined ? undefined : await secrets.get(record.secretRef);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 环境的名字：去掉首尾空白后 1–60 字。 */
function environmentName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.length > 60) {
    throw invalidParams(['name'], 'environment name must be 1–60 characters');
  }
  return trimmed;
}

/** 环境的文件夹：工作区都在、没被移除，不重复。 */
function checkEnvironmentFolders(
  storage: Storage,
  folders: readonly EnvironmentFolder[],
  chats: ChatFolders | undefined,
): EnvironmentRecord['folders'] {
  const seen = new Set<string>();
  for (const folder of folders) {
    if (seen.has(folder.workspaceId)) {
      throw invalidParams(['folders'], `workspace ${folder.workspaceId} is listed twice`);
    }
    seen.add(folder.workspaceId);
    const workspace = storage.workspaces.get(folder.workspaceId);
    if (!workspace || workspace.removedAt !== undefined) {
      throw new HostError('WORKSPACE_NOT_FOUND', `workspace ${folder.workspaceId} not found`);
    }
    if (chats?.isChats(workspace) === true) {
      throw invalidParams(['folders'], 'the chats workspace cannot be in an environment');
    }
  }
  return folders.map((folder) => ({ workspaceId: folder.workspaceId, worktree: folder.worktree }));
}

function toEnvironment(record: EnvironmentRecord): Environment {
  return {
    id: record.id as EnvironmentId,
    name: record.name,
    location: { kind: 'local' },
    folders: record.folders.map((folder) => ({
      workspaceId: folder.workspaceId as WorkspaceId,
      worktree: folder.worktree === 'new' ? 'new' : 'none',
    })),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
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
