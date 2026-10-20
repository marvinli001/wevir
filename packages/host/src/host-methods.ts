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
  MemorySource as ProtocolMemorySource,
  ProviderProfile,
  Session,
  SessionId,
  WevirEvent,
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
import type { AutomationService } from './automations/service.js';
import type { ChatFolders } from './chats.js';
import type { TurnCheckpoints } from './checkpoints.js';
import { HostError } from './errors.js';
import type { EventStore } from './event-store.js';
import { type FileUrls, isServablePath } from './file-urls.js';
import type { GitService } from './git/service.js';
import {
  isSafeRelativePath,
  readBranch,
  readDiffFile,
  readStaged,
  readUncommitted,
} from './git-diff.js';
import { readGitStatus } from './git-status.js';
import { newId } from './ids.js';
import type { ImageStore } from './images.js';
import type { LspStatusService } from './lsp/service.js';
import {
  MemoryError,
  type MemoryNote,
  type MemoryScope,
  type MemorySource,
  type MemoryStore,
} from './memory.js';
import { discoverOllamaModels, ollamaOrigin } from './ollama-models.js';
import type { PluginRegistry } from './plugins.js';
import type { ProcessOutputService } from './process-output.js';
import type { ReadinessService } from './readiness/service.js';
import type { ReviewService } from './review/service.js';
import type { SessionManager } from './session-manager.js';
import { HostSettingsStore } from './settings.js';
import type { TerminalService } from './terminals.js';
import type { PricingStore } from './usage/pricing.js';
import type { UsageService } from './usage/usage-service.js';
import type { VerificationService } from './verification/service.js';
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

/** 由 RPC 连接自己处理的方法：握手、心跳、退出、订阅、浏览器提供方（0.33.0）与终端的 attach（0.69.0），登记的都是这条连接。 */
export type ConnectionMethodName =
  | 'host.hello'
  | 'host.ping'
  | 'host.shutdown'
  | 'events.subscribe'
  | 'events.unsubscribe'
  | 'browser.register'
  | 'browser.unregister'
  | 'browser.respond'
  | 'terminal.attach'
  | 'terminal.detach';

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
  /** 跨会话记忆（0.57.0，`memory.*`）；省略时 `memory.*` 回 `INVALID_PARAMS`（测试）。 */
  memory?: MemoryStore;
  /** 工具预设的清单（0.61.0，`tools.presets`，AppTools 的 `presets`）；没有应用级工具时省略，方法回 `INVALID_PARAMS`。 */
  toolPresets?: () => MethodResult<'tools.presets'>;
  /** 用量统计（0.62.0，`usage.*`）；省略时 `usage.*` 回 `INVALID_PARAMS`（测试）。 */
  usage?: { service: UsageService; pricing: PricingStore };
  /** 回合后验证（0.65.0，`checks.*`、`verification.*`）；省略时这些方法回 `INVALID_PARAMS`（测试）。 */
  verification?: VerificationService;
  /** 自动化（0.66.0，`automation.*`）；省略时 `automation.*` 回 `INVALID_PARAMS`（测试）。 */
  automations?: AutomationService;
  /** 行级批注（0.67.0，`review.*`）；省略时 `review.*` 回 `INVALID_PARAMS`（测试）。 */
  review?: ReviewService;
  /** 暂存与提交（0.67.0，`git.*`）；省略时 `git.*` 回 `INVALID_PARAMS`（测试）。 */
  git?: GitService;
  /** 项目环境就绪（0.70.0，`readiness.*`）；省略时这些方法回 `INVALID_PARAMS`（测试）。 */
  readiness?: ReadinessService;
  /** 语言服务器的状态与安装（0.71.0，`lsp.*`）；省略时这些方法回 `INVALID_PARAMS`。 */
  lsp?: LspStatusService;
  /** 进程输出（0.69.0，`process.*`）；省略时这些方法回 `INVALID_PARAMS`（测试）。 */
  processes?: ProcessOutputService;
  /** 用户的交互终端（0.69.0，`terminal.*`）；node-pty 加载不了时省略，这些方法回 `INVALID_PARAMS`。 */
  terminals?: TerminalService;
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
    ...(record.extraFolders !== undefined &&
      record.extraFolders.length > 0 && { extraFolders: record.extraFolders }),
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
  const verification = (): VerificationService => {
    if (options.verification === undefined) {
      throw invalidParams([], 'this host has no verification service');
    }
    return options.verification;
  };
  const review = (): ReviewService => {
    if (options.review === undefined) throw invalidParams([], 'this host has no review comments');
    return options.review;
  };
  /** 批注所在的目录（同 `workspace.diff`）：realpath，目录相同的会话共用一组批注。 */
  const reviewDirectory = async (workspaceId: WorkspaceId, sessionId: SessionId | undefined) => ({
    workspaceId,
    dir: await resolveWorkspacePath(diffDirectory(workspaceId, sessionId)),
  });
  const gitService = (): GitService => {
    if (options.git === undefined) throw invalidParams([], 'this host has no git staging');
    return options.git;
  };
  const gitDirectory = (workspaceId: WorkspaceId, sessionId: SessionId | undefined) =>
    resolveWorkspacePath(diffDirectory(workspaceId, sessionId));
  const usageStats = (): NonNullable<HostMethodsOptions['usage']> => {
    if (options.usage === undefined) throw invalidParams([], 'this host has no usage statistics');
    return options.usage;
  };
  const lspStatus = (): LspStatusService => {
    if (options.lsp === undefined) throw invalidParams([], 'this host has no language servers');
    return options.lsp;
  };
  const processOutput = (): ProcessOutputService => {
    if (options.processes === undefined) throw invalidParams([], 'this host has no process output');
    return options.processes;
  };
  const terminals = (): TerminalService => {
    if (options.terminals === undefined) throw invalidParams([], 'this host has no user terminal');
    return options.terminals;
  };
  const readiness = (): ReadinessService => {
    if (options.readiness === undefined)
      throw invalidParams([], 'this host has no readiness checks');
    return options.readiness;
  };
  const automations = (): AutomationService => {
    if (options.automations === undefined) throw invalidParams([], 'this host has no automations');
    return options.automations;
  };
  const memoryStore = (): MemoryStore => {
    if (options.memory === undefined) throw invalidParams([], 'this host has no memory store');
    return options.memory;
  };
  /**
   * `memory.*` 的范围：`project` 要有 `workspaceId`，工作区要在、没被移除（“对话”工作区也算）；`global` 不看 `workspaceId`。
   * 返回交给 MemoryStore 的工作区 ID。
   */
  const memoryWorkspace = (
    scope: MemoryScope,
    workspaceId: string | undefined,
  ): string | undefined => {
    if (scope === 'global') return undefined;
    if (workspaceId === undefined) {
      throw invalidParams(['workspaceId'], 'project memory needs workspaceId');
    }
    const workspace = storage.workspaces.get(workspaceId);
    if (!workspace || workspace.removedAt !== undefined) {
      throw new HostError('WORKSPACE_NOT_FOUND', `workspace ${workspaceId} not found`);
    }
    return workspaceId;
  };
  /**
   * `memory.read` 里来源会话现在怎样（0.58.0）：会话删了是 `deleted`；写下笔记的回合被撤回、或撤销了还没重做是 `withdrawn`。用户在设置里
   * 改的（没有会话）不加。
   */
  const withSourceStatus = (source: MemorySource | undefined): ProtocolMemorySource | undefined => {
    if (source?.sessionId === undefined) return source;
    const sessionId = source.sessionId;
    if (storage.sessions.get(sessionId) === undefined) return { ...source, status: 'deleted' };
    const withdrawn =
      source.turnId !== undefined && turnWithdrawn(events.readSince(sessionId, 0), source.turnId);
    return { ...source, status: withdrawn ? 'withdrawn' : 'available' };
  };
  /** MemoryStore 的错误换成 Host API 的：找不到是 `MEMORY_NOT_FOUND`，其余（不合规、超出上限）是 `INVALID_PARAMS`。 */
  const memoryCall = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof MemoryError)) throw error;
      if (error.code === 'not_found') throw new HostError('MEMORY_NOT_FOUND', error.message);
      throw invalidParams([], error.message);
    }
  };
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
    // 0.63.0：`id` 可以是添加的 ChatGPT 账号。
    const id = params.id;
    if (id !== CHATGPT_PROVIDER_ID && accounts.kindOf(id) !== 'chatgpt') {
      throw invalidParams(['id'], `${id} is not a ChatGPT account`);
    }
    const { models } = await accounts.models({ kind: 'chatgpt', id });
    if (!models.some((model) => model.id === params.defaultModelId)) {
      throw invalidParams(['defaultModelId'], 'defaultModelId must be one of the account models');
    }
    return serialProvider(async () => {
      const existing = storage.providers.get(id);
      if (existing && existing.kind !== 'chatgpt') {
        throw invalidParams(['kind'], `kind of provider ${id} cannot be changed`);
      }
      const now = isoNow();
      const record: ProviderProfileRecord = {
        id,
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
    'plugin.install': ({ path, inputs, replace }) =>
      plugins().installPlugin(path, {
        ...(inputs !== undefined && { inputs }),
        ...(replace !== undefined && { replace }),
      }),
    'plugin.remove': async ({ id }) => {
      await plugins().removePlugin(id);
      return {};
    },
    'plugin.setEnabled': async ({ id, enabled }) => ({
      plugin: await plugins().setPluginEnabled(id, enabled),
    }),
    'plugin.setInputs': async ({ id, values }) => ({
      plugin: await plugins().setPluginInputs(id, values),
    }),
    'workspace.list': () => ({ workspaces: storage.workspaces.list().map(toWorkspace) }),

    'workspace.add': async ({ rootPath, displayName, extraFolders }) => {
      const real = await resolveWorkspacePath(rootPath);
      if (options.chats?.owns(real) === true) {
        throw invalidParams(['rootPath'], 'this folder holds Wevir chats');
      }
      const extra =
        extraFolders === undefined
          ? []
          : await resolveExtraFolders(real, extraFolders, options.chats);
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
        ...(extra.length > 0 && { extraFolders: extra }),
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
      // 不属于会话的用户终端也随项目结束（0.69.0）。
      options.terminals?.removeWorkspace(workspaceId);
      void options.readiness?.removeWorkspace(workspaceId as WorkspaceId);
      storage.workspaces.markRemoved(workspaceId, isoNow());
      return {};
    },

    // 0.49.0：改显示名（去掉首尾空白后不能是空的），rootPath 不可改；“对话”工作区不能改。0.64.0 起也能整组换掉其他源文件夹。
    'workspace.update': ({ workspaceId, displayName, extraFolders }) => {
      const workspace = storage.workspaces.get(workspaceId);
      if (!workspace || workspace.removedAt !== undefined) {
        throw new HostError('WORKSPACE_NOT_FOUND', `workspace ${workspaceId} not found`);
      }
      if (options.chats?.isChats(workspace) === true) {
        throw invalidParams(['workspaceId'], 'the chats workspace cannot be renamed');
      }
      const name = displayName?.trim();
      if (name === '') throw invalidParams(['displayName'], 'displayName must not be blank');
      // 先查完文件夹再写，任何一项不对都什么都不改；只改名时同步返回。
      const apply = (extra: string[] | undefined) => {
        const current = mustGetWorkspace(storage, workspaceId);
        if (current.removedAt !== undefined) {
          throw new HostError('WORKSPACE_NOT_FOUND', `workspace ${workspaceId} not found`);
        }
        if (name !== undefined && name !== current.displayName) {
          storage.workspaces.rename(workspaceId, name, isoNow());
        }
        if (extra !== undefined && !sameFolders(extra, current.extraFolders ?? [])) {
          storage.workspaces.setExtraFolders(workspaceId, extra, isoNow());
        }
        return { workspace: toWorkspace(mustGetWorkspace(storage, workspaceId)) };
      };
      if (extraFolders === undefined) return apply(undefined);
      return resolveExtraFolders(workspace.rootPath, extraFolders, options.chats).then(apply);
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
      if (source.kind === 'staged') return readStaged(dir);
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
        // 用量记录归属于 Provider（0.62.0 的用量统计），随它一起删。
        if (storage.usage.deleteProvider(providerId) > 0) options.usage?.service.recordsChanged();
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

    // 客户端读账号（连上、回到前台）时顺带让过期的用量在后台重读，结果经 account.updated 到（usage-refresh.ts）。
    'account.list': async () => {
      const accounts = requireAccounts();
      const list = await accounts.list();
      accounts.usage.nudge();
      return { accounts: list };
    },

    'account.get': async ({ kind, id, refresh }) => {
      const accounts = requireAccounts();
      const account = await accounts.read({ kind, id }, refresh === true ? { refresh } : undefined);
      if (refresh !== true) accounts.usage.nudge(id ?? kind);
      return { account };
    },

    'account.setPath': async ({ kind, path }) => ({
      account: await requireAccounts().setPath(kind, path),
    }),

    'account.install': async ({ kind }) => ({ account: await requireAccounts().install(kind) }),

    'account.login': async ({ kind, id, method, upstream, option, apiKey }) => ({
      account: await requireAccounts().login({ kind, id }, method, {
        ...(upstream !== undefined && { upstream }),
        ...(option !== undefined && { option }),
        ...(apiKey !== undefined && { apiKey }),
      }),
    }),

    'account.upstreams': async ({ kind }) => ({
      upstreams: await requireAccounts().upstreams(kind),
    }),

    'account.cancelLogin': async ({ kind, id, loginId }) => ({
      account: await requireAccounts().cancelLogin({ kind, id }, loginId),
    }),

    'account.logout': async ({ kind, id, upstream }) => ({
      account: await requireAccounts().logout(
        { kind, id },
        upstream === undefined ? {} : { upstream },
      ),
    }),

    // 0.63.0：同一来源的多个账号。
    'account.add': async ({ kind, label }) => ({
      account: await requireAccounts().add(kind, label),
    }),

    'account.remove': async ({ id }) => {
      await requireAccounts().remove(id, () =>
        storage.sessions
          .list({ includeRemovedWorkspaces: true })
          .filter((session) => session.providerId === id && session.state !== 'closed')
          .map((session) => session.id),
      );
      return {};
    },

    'account.setLabel': async ({ id, label }) => ({
      account: await requireAccounts().setLabel(id, label),
    }),

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

    // 0.43.0：永久删掉已归档的会话（domain-model §3.20）。
    'session.delete': async ({ sessionId, force }) => {
      assertSessionVisible(storage, sessionId);
      return sessions.delete(sessionId, { ...(force !== undefined && { force }) });
    },

    'session.usage': async ({ archived }) => ({
      sessions: await sessions.usage(archived === true),
    }),

    'session.configure': async (params) => ({ session: await sessions.configure(params) }),
    'session.handoffPreview': (params) => sessions.handoffPreview(params),

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
    'session.undo': (params) => sessions.undo(params),
    'session.recap': (params) => sessions.recap(params),
    'session.redo': (params) => sessions.redo(params),

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

    // 0.57.0：用户管理跨会话记忆（domain-model §3.21）。
    'memory.list': async ({ workspaceId }) => {
      const memory = memoryStore();
      return memoryCall(() =>
        memory.listAll(
          workspaceId === undefined ? undefined : memoryWorkspace('project', workspaceId),
        ),
      );
    },

    'memory.read': async ({ scope, workspaceId, name }) => {
      const memory = memoryStore();
      const workspace = memoryWorkspace(scope, workspaceId);
      const note = toMemoryNote(
        await memoryCall(() => memory.read(scope, workspace, name, { includeDisabled: true })),
      );
      const origin = withSourceStatus(note.origin);
      const lastEdit = withSourceStatus(note.lastEdit);
      return {
        note: {
          ...note,
          ...(origin !== undefined && { origin }),
          ...(lastEdit !== undefined && { lastEdit }),
        },
      };
    },

    'memory.update': async ({ scope, workspaceId, name, revision, type, description, content }) => {
      const memory = memoryStore();
      const workspace = memoryWorkspace(scope, workspaceId);
      const result = await memoryCall(() =>
        memory.update(scope, workspace, name, revision, {
          ...(type !== undefined && { type }),
          ...(description !== undefined && { description }),
          ...(content !== undefined && { content }),
        }),
      );
      return {
        note: toMemoryNote(result.note),
        ...(result.conflict === true && { conflict: true as const }),
      };
    },

    'memory.setEnabled': async ({ scope, workspaceId, name, enabled }) => {
      const memory = memoryStore();
      const workspace = memoryWorkspace(scope, workspaceId);
      return {
        note: toMemoryNote(
          await memoryCall(() => memory.setEnabled(scope, workspace, name, enabled)),
        ),
      };
    },

    'memory.delete': async ({ scope, workspaceId, name, revision }) => {
      const memory = memoryStore();
      const workspace = memoryWorkspace(scope, workspaceId);
      const result = await memoryCall(() =>
        memory.delete(scope, workspace, name, {
          includeDisabled: true,
          ...(revision !== undefined && { revision }),
        }),
      );
      return result.conflict === undefined
        ? {}
        : { conflict: true as const, note: toMemoryNote(result.conflict) };
    },

    'usage.summary': async ({ edges, filter }) => usageStats().service.summary(edges, filter),
    'usage.records': async (params) => {
      if (params.to < params.from) throw invalidParams(['to'], 'to must not be before from');
      return usageStats().service.records(params);
    },
    'usage.pricing': async ({ refresh }) => {
      const { pricing } = usageStats();
      if (refresh === true) await pricing.refresh();
      return { pricing: pricing.status() };
    },
    'checks.list': ({ workspaceId }) => verification().listChecks(workspaceId),
    'checks.candidates': async ({ workspaceId }) => ({
      candidates: await verification().candidates(workspaceId),
    }),
    'checks.save': async ({ workspaceId, check }) => ({
      check: await verification().saveCheck(workspaceId, check),
    }),
    'checks.remove': async ({ workspaceId, checkId }) => ({
      removed: await verification().removeCheck(workspaceId, checkId),
    }),
    'checks.setRepair': async ({ workspaceId, repair }) => ({
      repair: await verification().setRepair(workspaceId, repair),
    }),
    'verification.run': ({ sessionId, checkIds }) => verification().run(sessionId, checkIds),
    'verification.cancel': ({ sessionId }) => verification().cancel(sessionId),
    'verification.status': ({ sessionId }) => verification().status(sessionId),
    'verification.output': ({ sessionId, runId, offset }) =>
      verification().output(sessionId, runId, offset),

    // 0.67.0：行级批注（ADR-0009）。目录的选法同 workspace.diff。
    'review.list': async ({ workspaceId, sessionId, status }) => ({
      comments: await review().list(await reviewDirectory(workspaceId, sessionId), status),
    }),
    'review.add': async ({ workspaceId, sessionId, ...input }) => ({
      comment: await review().add(await reviewDirectory(workspaceId, sessionId), {
        ...input,
        ...(sessionId !== undefined && { sessionId }),
      }),
    }),
    'review.update': async ({ commentId, body }) => ({
      comment: await review().update(commentId, body),
    }),
    'review.remove': ({ commentIds }) => ({ removed: review().remove(commentIds) }),
    'review.send': async ({ workspaceId, sessionId, ...params }, { client }) =>
      review().send(await reviewDirectory(workspaceId, sessionId), params, client),

    // 0.67.0：暂存与提交（ADR-0009）。只由用户在“变更”窗格发起，目录的选法同 workspace.diff。
    'git.status': async ({ workspaceId, sessionId }) =>
      gitService().status(await gitDirectory(workspaceId, sessionId), sessionId),
    'git.stage': async ({ workspaceId, sessionId, paths, expected }) => ({
      status: await gitService().stage(
        await gitDirectory(workspaceId, sessionId),
        paths,
        expected,
        sessionId,
      ),
    }),
    'git.unstage': async ({ workspaceId, sessionId, paths, expected }) => ({
      status: await gitService().unstage(
        await gitDirectory(workspaceId, sessionId),
        paths,
        expected,
        sessionId,
      ),
    }),
    'git.commit': async ({ workspaceId, sessionId, message, expected, includeExternal }) =>
      gitService().commit(
        await gitDirectory(workspaceId, sessionId),
        { message, expected, ...(includeExternal !== undefined && { includeExternal }) },
        sessionId,
      ),
    'lsp.status': async ({ workspaceId, sessionId, refresh }) =>
      lspStatus().status(await gitDirectory(workspaceId, sessionId), refresh === true),
    'lsp.restart': async ({ workspaceId, sessionId, serverId, root }) => ({
      server: await lspStatus().restart(await gitDirectory(workspaceId, sessionId), serverId, root),
    }),
    'lsp.log': async ({ workspaceId, sessionId, serverId, root }) => ({
      log: await lspStatus().log(await gitDirectory(workspaceId, sessionId), serverId, root),
    }),
    'lsp.install': async ({ workspaceId, sessionId, serverId, root, planId, confirmGlobal }) => ({
      run: await lspStatus().install(
        await gitDirectory(workspaceId, sessionId),
        serverId,
        root,
        planId,
        confirmGlobal === true,
      ),
    }),
    'lsp.cancelInstall': async ({ installId }) => ({ run: lspStatus().cancel(installId) }),
    'process.list': ({ workspaceId, sessionId }) => ({
      processes: processOutput().list({
        ...(workspaceId !== undefined && { workspaceId }),
        ...(sessionId !== undefined && { sessionId }),
      }),
    }),
    'process.output': ({ processId, offset, until }) =>
      processOutput().output(processId, offset, until),
    'process.stop': ({ processId, signal }) => ({
      process: processOutput().stop(processId, signal),
    }),
    'readiness.get': async ({ workspaceId, sessionId, refresh }) => ({
      report: await readiness().get({
        workspaceId,
        ...(sessionId !== undefined && { sessionId }),
        ...(refresh !== undefined && { refresh }),
      }),
    }),
    'readiness.install': async ({ workspaceId, sessionId, planId, timeoutMs }) => ({
      run: await readiness().install({
        workspaceId,
        ...(sessionId !== undefined && { sessionId }),
        planId,
        ...(timeoutMs !== undefined && { timeoutMs }),
      }),
    }),
    'readiness.cancel': async ({ runId }) => ({ run: readiness().cancel(runId) }),
    'readiness.output': ({ runId, offset }) => readiness().output(runId, offset),
    'readiness.setCredential': ({ workspaceId, name, value }) =>
      readiness().setCredential({ workspaceId, name, ...(value !== undefined && { value }) }),
    'terminal.create': async (params) => ({ terminal: await terminals().create(params) }),
    'terminal.list': (params) => ({ terminals: terminals().list(params) }),
    'terminal.input': (params) => {
      terminals().input(params);
      return {};
    },
    'terminal.resize': (params) => {
      terminals().resize(params);
      return {};
    },
    'terminal.close': (params) => {
      terminals().close(params);
      return {};
    },
    'automation.list': async () => ({ automations: automations().list() }),
    'automation.get': async ({ automationId }) => automations().get(automationId),
    'automation.create': async (params) => ({
      automation: await automations().create(params, { kind: 'user' }),
    }),
    'automation.update': async (params) => ({ automation: await automations().update(params) }),
    'automation.delete': async ({ automationId }) => {
      await automations().delete(automationId);
      return {};
    },
    'automation.run': async ({ automationId }) => ({
      run: await automations().runNow(automationId),
    }),
    'automation.testCheck': async (params) => ({
      result: await automations().testCheck(params),
    }),
    'tools.presets': async () => {
      if (options.toolPresets === undefined) {
        throw invalidParams([], 'this host has no Wevir app tools');
      }
      return options.toolPresets();
    },

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

/**
 * 项目的其他源文件夹（0.64.0）：每个都按 `workspace.add` 的规矩查（错误带出问题的那个路径），取 realpath；不能是主文件夹、
 * 不能重复、不能是放对话的目录。
 */
async function resolveExtraFolders(
  rootPath: string,
  folders: readonly string[],
  chats: ChatFolders | undefined,
): Promise<string[]> {
  const resolved: string[] = [];
  for (const folder of folders) {
    const real = await resolveWorkspacePath(folder);
    if (real === rootPath) {
      throw invalidParams(['extraFolders'], `${folder} is the project's main folder`);
    }
    if (resolved.includes(real)) throw invalidParams(['extraFolders'], `${folder} is listed twice`);
    if (chats?.owns(real) === true) {
      throw invalidParams(['extraFolders'], 'this folder holds Wevir chats');
    }
    resolved.push(real);
  }
  return resolved;
}

function sameFolders(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((folder, index) => folder === b[index]);
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

/** 线缆上的笔记：只有协议里的字段。 */
function toMemoryNote(note: MemoryNote): MemoryNote {
  const { scope, name, type, description, content, updatedAt, enabled, revision } = note;
  return {
    scope,
    name,
    type,
    description,
    content,
    updatedAt,
    enabled,
    revision,
    ...(note.origin !== undefined && { origin: note.origin }),
    ...(note.lastEdit !== undefined && { lastEdit: note.lastEdit }),
  };
}

/** 回合现在看不看得见：被撤回（`turn.rewound`）就不在了；撤销（`turn.undone`）了要看之后有没有重做（`turn.redone`）。 */
function turnWithdrawn(sessionEvents: readonly WevirEvent[], turnId: string): boolean {
  let withdrawn = false;
  for (const event of sessionEvents) {
    if (event.type === 'turn.rewound' && event.payload.turnId === turnId) return true;
    if (event.type === 'turn.undone' && event.payload.turnId === turnId) withdrawn = true;
    if (event.type === 'turn.redone' && event.payload.turnId === turnId) withdrawn = false;
  }
  return withdrawn;
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
