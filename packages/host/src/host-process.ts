import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ClientIdentity,
  DESKTOP_RENDERER_ORIGINS,
  type EngineFeatures,
  type HostId,
  HostIdSchema,
  PROTOCOL_VERSION,
  ProviderKindSchema,
} from '@wevir/protocol';
import type { AgentRuntimeAdapter } from '@wevir/runtime-adapter';
import { FileSecretStore, openStorage, type Storage } from '@wevir/storage';
import packageJson from '../package.json' with { type: 'json' };
import { HostAccounts } from './accounts.js';
import { AppMcpServer } from './app-mcp.js';
import { APP_TOOLS_INSTRUCTIONS, AppTools, engineSessionResolver } from './app-tools.js';
import { BrowserBroker } from './browser-broker.js';
import { ChatFolders } from './chats.js';
import { TurnCheckpoints } from './checkpoints.js';
import { EnginePathStore } from './engine-paths.js';
import { EngineRouter, engineFeaturesOf } from './engine-router.js';
import { EventStore } from './event-store.js';
import { FileUrls } from './file-urls.js';
import { homePath } from './home.js';
import { createHostMethods, createProviderLock, syncProviders } from './host-methods.js';
import { newId } from './ids.js';
import { ImageStore } from './images.js';
import type { Logger } from './logger.js';
import { LspManager } from './lsp/manager.js';
import { MemoryStore } from './memory.js';
import { instructionsWithMemory } from './memory-tools.js';
import { PluginRegistry } from './plugins.js';
import { ProcessManager } from './processes.js';
import { loadSuggestionInstructions } from './prompt-suggestion.js';
import { loadRecapInstructions } from './recap.js';
import { RoleStore } from './roles.js';
import { HostRpcServer } from './rpc-server.js';
import { RuntimeFile } from './runtime-file.js';
import { SessionManager } from './session-manager.js';
import { HostSettingsStore } from './settings.js';
import { boardEventRecorder, TaskBoardStore } from './task-board.js';
import { loadTitleInstructions } from './title.js';
import { ToolOutputStore } from './tool-output.js';
import type { WebService } from './web/service.js';

/** Host 软件版本（`@wevir/host` 的 version），写进 hello 结果与 `host.json`。 */
export const HOST_VERSION: string = packageJson.version;

/** 优雅退出的整体上限，超过就强制退出（ADR-0002 §6）。 */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * 退出流程里可能卡住的三步（等在途请求、取消回合、dispose 适配器）共用的时间预算。超出的那一步记日志
 * 后跳过，后面的刷写 SQLite、关闭连接（自带 2 s 关闭握手时限）、删除 `host.json` 照常执行，合起来仍在
 * `SHUTDOWN_TIMEOUT_MS` 之内；引擎卡住也不会让数据库没关、`host.json` 没删。
 */
export const SHUTDOWN_BUDGET_MS = 7000;

/** 谁触发了退出，记进日志。 */
export type ShutdownTrigger =
  | { kind: 'rpc'; client: ClientIdentity }
  | { kind: 'signal'; signal: NodeJS.Signals }
  | { kind: 'stdin_eof' }
  | { kind: 'fatal'; error: unknown }
  | { kind: 'api' };

export interface StartHostOptions {
  /** 测试时与隔离的引擎 HOME 一致；产品默认 os.homedir()。 */
  pluginUserHome?: string;
  /** 数据目录（绝对路径），见 `resolveHome`。 */
  home: string;
  /** 引擎适配器，由 Host 独占，退出时 `dispose`。 */
  adapter: AgentRuntimeAdapter;
  /** 写进 `sessions.engine` 列与会话快照的 `engine.kind`，例如 `codex`、`echo`。 */
  engine: string;
  logger: Logger;
  /** 仅调试用，默认 0（系统分配）。 */
  port?: number;
  /**
   * 收到 `host.shutdown` 时调用。默认直接 `shutdown()`；进程入口用它把 RPC 也接到统一的退出流程上
   * （10 s 上限、退出码）。
   */
  onShutdownRequest?: (trigger: ShutdownTrigger) => void;
  /** 默认 `SHUTDOWN_BUDGET_MS`。 */
  shutdownBudgetMs?: number;
  /**
   * Wevir 提示词目录（会话标题用 `thread-title.md`），默认仓库的 `prompts/`。wevir-host 传 adapter-codex 的
   * `resolvePromptsDir`（安装包里是资源目录的 `prompts/`）。
   */
  promptsDir?: string;
  /**
   * 联网服务（0.34.0，web/service.ts）：Host 用自己的密钥存储启动它、提供 `web.*` 并声明 `web_tools`，退出时关掉。省略时没有
   * 联网工具。
   */
  web?: WebService;
}

export interface RunningHost {
  readonly home: string;
  readonly hostId: HostId;
  readonly url: string;
  readonly runtimeFile: RuntimeFile;
  /**
   * 按 ADR-0002 §6 的顺序优雅退出：停止接受新连接 → 取消运行中的回合、未决审批结为 `cancelled` →
   * dispose 适配器（回收引擎进程树）→ 刷写 SQLite → 关闭 WebSocket 连接 → 删除 `host.json`。
   * 每一步失败只记日志、继续下一步；前三步共用 `shutdownBudgetMs` 的预算，超出的跳过。可重复调用，
   * 返回同一个 Promise。10 s 的硬上限由调用方兜底（进程入口超时后调用 `releaseRuntimeFileSync()`
   * 再强制退出）。
   */
  shutdown(trigger?: ShutdownTrigger): Promise<void>;
  /** 强制退出前同步删除自己的 `host.json`，返回是否删除。 */
  releaseRuntimeFileSync(): boolean;
}

/**
 * 把 Host 组装起来并开始服务（T2.5）：
 *
 * 1. 占住 `run/host.json`（排他创建；已有活着的 Host 抛 `HostAlreadyRunningError`）。在打开数据库
 *    之前做，同一个数据目录不会有两个 Host 同时迁移、写库。
 * 2. 读取或生成 `hostId`；打开存储，建事件库与会话管理器，启动对账（`recover()`）。
 * 3. 生成本次启动的令牌（32 字节随机数，base64url），只在内存与 `host.json` 里。
 * 4. 监听 127.0.0.1，就绪后原子地把 `url` 与令牌写进 `host.json`。
 *
 * 任何一步失败都回收已建好的部分（含 `host.json`）后再抛出。
 */
export async function startHost(options: StartHostOptions): Promise<RunningHost> {
  const { home, adapter, logger } = options;
  await mkdir(home, { recursive: true, mode: 0o700 });
  const runtimeFile = await RuntimeFile.acquire({
    home,
    protocolVersion: PROTOCOL_VERSION,
    hostVersion: HOST_VERSION,
  });
  if (runtimeFile.reclaimed) {
    logger.warn('reclaimed stale runtime file', {
      path: runtimeFile.path,
      stalePid: runtimeFile.reclaimed.pid,
      staleStartedAt: runtimeFile.reclaimed.startedAt,
    });
  }

  let storage: Storage | undefined;
  let events: EventStore | undefined;
  let sessions: SessionManager | undefined;
  let rpc: HostRpcServer | undefined;
  let backgroundProcesses: ProcessManager | undefined;
  let accounts: HostAccounts | undefined;
  let turnCheckpoints: TurnCheckpoints | undefined;
  try {
    const hostId = await loadHostId(home, logger);
    storage = openStorage({ dataDir: home });
    const store = new EventStore({
      storage,
      onError: (error) => logger.error('event store error', { error }),
    });
    events = store;
    // 适配器能生成标题时才读提示词；读不到只是没有模型生成的标题，不阻止 Host 启动。
    let titleInstructions: string | undefined;
    if (adapter.generateTitle !== undefined) {
      try {
        titleInstructions = loadTitleInstructions(options.promptsDir);
      } catch (error) {
        logger.warn('failed to load the session title prompt; titles stay truncated', { error });
      }
    }
    // 输入建议（0.53.0）：同样要适配器能发一次不带工具的请求，读不到提示词就没有这个功能，不阻止 Host 启动。
    let suggestionInstructions: string | undefined;
    if (adapter.generateTitle !== undefined) {
      try {
        suggestionInstructions = loadSuggestionInstructions(options.promptsDir);
      } catch (error) {
        logger.warn('failed to load the prompt suggestion prompt; no input suggestions', { error });
      }
    }
    // 离开后摘要（0.54.0）：同标题，适配器能生成才读提示词；读不到只是没有这个功能。
    let recapInstructions: string | undefined;
    if (adapter.generateTitle !== undefined) {
      try {
        recapInstructions = loadRecapInstructions(options.promptsDir);
      } catch (error) {
        logger.warn('failed to load the session recap prompt; recaps are unavailable', { error });
      }
    }
    // Host 设置（R11，domain-model §3.7）：文件有问题时用默认值并告警。
    const settings = new HostSettingsStore({
      path: homePath(home, 'settingsFile'),
      onWarning: (message, fields) => logger.warn(message, fields),
    });
    await settings.load();
    // 回合快照（0.20.0）：只认还开着的会话，清理时删掉别的会话留下的 ref。
    const sessionsDb = storage;
    const plugins = new PluginRegistry({
      home,
      ...(options.pluginUserHome !== undefined && { userHome: options.pluginUserHome }),
      roots: () => sessionsDb.workspaces.list().map((workspace) => workspace.rootPath),
      adapter,
      onWarning: (message) => logger.warn(message),
    });
    await plugins.load();
    const checkpoints = new TurnCheckpoints({
      isOpen: (sessionId) => {
        const record = sessionsDb.sessions.get(sessionId);
        return record !== undefined && record.state !== 'closed';
      },
      onWarning: (message, fields) => logger.warn(message, fields),
    });
    turnCheckpoints = checkpoints;
    // 每种 Provider 的引擎能做什么（0.25.0，接力）：hello 里告诉客户端，接力时按它挑权限模式、提不提读历史的工具。
    const engineFeatures = hostEngineFeatures(adapter, options.engine);
    // 消息里的图片（0.28.0）：没发出去的过一天删掉，启动时先清一遍。
    const images = new ImageStore({ dir: homePath(home, 'imagesDir') });
    await images
      .sweep()
      .catch((error: unknown) => logger.warn('failed to sweep staged images', { error }));
    // 应用级工具（0.30.0，app-mcp.ts / app-tools.ts）：MCP 端点开在 RPC 的同一个端口上，监听之后才发令牌；工具要用会话管理器
    // 与 Host 设置，下面建好之后再接上。
    let appMcp: AppMcpServer | undefined;
    let appTools: AppTools | undefined;
    // 大输出落盘与后台进程（tool-output.ts、processes.ts）：过期的文件启动时在后台清掉。
    const toolOutput = new ToolOutputStore(homePath(home, 'toolOutputDir'));
    void toolOutput
      .prune()
      .catch((error: unknown) => logger.warn('failed to prune tool output', { error }));
    const processes =
      adapter.appTools === true
        ? new ProcessManager({
            output: toolOutput,
            onNotice: (notice) => appTools?.onProcessNotice(notice),
            onWarning: (message, fields) => logger.warn(message, fields),
          })
        : undefined;
    backgroundProcesses = processes;
    // 不在项目里的会话（0.39.0）：“对话”工作区与每个会话的文件夹。
    const chats = new ChatFolders({ dir: homePath(home, 'chatsDir') });
    await chats.load();
    // 跨会话记忆（memory.ts）：全局一份、每个项目一份，会话开始时索引放进应用级工具的说明。
    const memory = new MemoryStore({ dir: homePath(home, 'memoryDir') });
    // 预设角色（roles.ts）：内置的加上用户与项目里的 .md。
    const roles = new RoleStore({ dir: homePath(home, 'rolesDir') });
    // 共享任务清单（task-board.ts）：根会话已经不在的清单启动时清掉。
    // 改动写进根会话的事件流（0.52.0 的 tasks.board_updated），桌面端据此显示清单。
    const taskBoards = new TaskBoardStore({
      dir: homePath(home, 'tasksDir'),
      onChange: boardEventRecorder(store, (message, fields) => logger.warn(message, fields)),
    });
    void taskBoards
      .sweep((sessionId) => sessionsDb.sessions.get(sessionId) !== undefined)
      .catch((error: unknown) => logger.warn('task board sweep failed', { error }));
    const manager = new SessionManager({
      storage,
      events: store,
      adapter,
      appTools: {
        grant: (sessionId) => appMcp?.grant(sessionId),
        prepareEvent: (sessionId, event) => {
          // 代码智能：记下引擎改过的文件（不改事件）。
          appTools?.lsp?.observe(sessionId, event);
          return appTools?.plugins?.prepareEvent(sessionId, event) ?? Promise.resolve(event);
        },
        resolved: (sessionId, toolCallId, approved) =>
          appTools?.plugins?.resolved(sessionId, toolCallId, approved),
        forget: (sessionIds) => void processes?.removeSessions(sessionIds),
        dispose: () => appTools?.plugins?.close(),
      },
      onTurnFinished: (info) => appTools?.onTurnFinished(info),
      engine: options.engine,
      onError: (error) => logger.error('session manager error', { error }),
      onWarning: (message, fields) => logger.warn(message, fields),
      ...(titleInstructions !== undefined && { titleInstructions }),
      ...(suggestionInstructions !== undefined && {
        suggestion: {
          instructions: suggestionInstructions,
          enabled: () => settings.get().promptSuggestions !== false,
        },
      }),
      ...(recapInstructions !== undefined && { recapInstructions }),
      recapEnabled: () => settings.get().sessionRecap !== false,
      // 环境会话新开的 worktree（0.15.0，domain-model §3.10）。
      worktreesDir: join(home, 'worktrees'),
      chats,
      checkpoints,
      engineFeatures,
      historyDir: homePath(home, 'historyDir'),
      toolOutputDir: toolOutput.dir,
      images,
    });
    sessions = manager;
    const recovery = manager.recover();
    if (
      recovery.expiredApprovals > 0 ||
      recovery.interruptedSessions.length > 0 ||
      recovery.unknownSends > 0
    ) {
      logger.warn('recovered from unclean shutdown', { ...recovery });
    }

    // 把已存的 Provider（含 Key）交给引擎（T3.4）。失败不阻止 Host 启动：会话建不起来时报引擎错误。
    const secrets = new FileSecretStore(home);
    await syncProviders(storage, secrets, adapter).catch((error: unknown) =>
      logger.error('failed to apply providers to the engine', { error }),
    );
    // 联网服务（0.34.0）：引擎第一次启动时要它的端点，所以在开始服务之前就监听。
    await options.web?.start(secrets);

    // 账号（R6 的 ChatGPT，0.19.0 起还有订阅来源）：引擎有账号时才有，Host 据此声明 chatgpt_account 与 subscription_sources。
    const providerLock = createProviderLock();
    const db = storage;
    accounts =
      adapter.accounts === undefined
        ? undefined
        : new HostAccounts({
            accounts: adapter.accounts,
            storage: db,
            providerLock,
            applyProviders: () => syncProviders(db, secrets, adapter),
            onWarning: (message, fields) => logger.warn(message, fields),
            paths: new EnginePathStore({
              path: homePath(home, 'enginesFile'),
              onWarning: (message, fields) => logger.warn(message, fields),
            }),
          });
    if (accounts?.hasSubscriptions === true) {
      // 用户指定的可执行文件先交给引擎，再在后台检测一遍订阅来源：已登录的种类建好 Provider，模型选择里才看得到。
      // ChatGPT 不在这里读（它的进程第一次用到时才启动，R6）。
      const subscriptions = accounts;
      await subscriptions.applySavedPaths();
      void Promise.all(
        subscriptions.kinds
          .filter((kind) => kind !== 'chatgpt')
          .map((kind) => subscriptions.read(kind).catch(() => undefined)),
      );
    }

    // 内置浏览器（0.33.0）：桌面端登记为浏览器提供方，应用级工具的 browser_* 经它交给桌面端的浏览器。
    const browsers = adapter.appTools === true ? new BrowserBroker() : undefined;
    // 代码智能（lsp_* 工具）：语言服务器按需启动，空闲关闭，Host 退出时回收。
    const lsp =
      adapter.appTools === true
        ? new LspManager({ onWarning: (message, fields) => logger.warn(message, fields) })
        : undefined;
    if (adapter.appTools === true) {
      appTools = new AppTools({
        plugins,
        storage,
        events: store,
        sessions: manager,
        hostId,
        sendWhileBusy: () => settings.get().sendWhileBusy,
        ...(browsers !== undefined && { browser: browsers }),
        ...(processes !== undefined && { processes }),
        ...(lsp !== undefined && { lsp }),
        memory,
        roles,
        tasks: taskBoards,
        onWarning: (message, fields) => logger.warn(message, fields),
      });
      const tools = appTools;
      appMcp = new AppMcpServer({
        tools: appTools.tools,
        filterTools: (sessionId, list) => tools.filterTools(sessionId, list),
        version: HOST_VERSION,
        instructions: instructionsWithMemory({
          base: APP_TOOLS_INSTRUCTIONS,
          memory,
          workspaceOf: (sessionId) => manager.workspaceOf(sessionId),
          onWarning: (message, fields) => logger.warn(message, fields),
        }),
        onError: (error) => logger.error('app tools error', { error }),
        engineSession: engineSessionResolver(storage, options.engine),
        spill: (sessionId, toolName, result) => toolOutput.spill(sessionId, toolName, result),
      });
    }
    const mcp = appMcp;
    // 文件预览的流式地址（0.32.0，file-urls.ts）：与 MCP 端点同在 RPC 的 HTTP 服务上，监听之后才知道端口。
    const fileUrls = new FileUrls({
      onError: (error) => logger.warn('file preview request failed', { error }),
    });

    const token = randomBytes(32).toString('base64url');
    logger.addSecret(token);
    let requestShutdown: (trigger: ShutdownTrigger) => void = () => {};
    const server = new HostRpcServer({
      token,
      hostId,
      hostVersion: HOST_VERSION,
      storage,
      events: store,
      methods: createHostMethods({
        plugins,
        storage,
        events: store,
        sessions: manager,
        secrets,
        checkpoints,
        providers: adapter,
        providerLock,
        ...(accounts !== undefined && { accounts }),
        settings,
        images,
        fileUrls,
        chats,
        ...(options.web !== undefined && { web: options.web }),
      }),
      // 待发消息与设置（R11）、工作区的 git 状态（U18）、改动的 diff（0.20.0）与文件（0.22.0）不依赖引擎：引擎不能插话时 Host 一律排队。
      features: {
        plugins: true,
        plugin_packages: true,
        provider_model_discovery: true,
        pending_messages: true,
        host_settings: true,
        workspace_git: true,
        workspace_diff: true,
        workspace_files: true,
        workspace_update: true,
        file_preview: true,
        session_rename: true,
        session_archive: true,
        session_delete: true,
        session_handoff: true,
        subagent_cancel: true,
        environments: true,
        session_worktree: true,
        provider_enabled: true,
        chat_sessions: true,
        ...(adapter.googleVertex === true && { google_vertex: true }),
        ...(accounts?.kinds.includes('chatgpt') === true && { chatgpt_account: true }),
        ...(accounts?.hasSubscriptions === true && { subscription_sources: true }),
        ...(accounts?.hasUpstreams === true && { subscription_upstreams: true }),
        ...(adapter.configureSession !== undefined && { session_configure: true }),
        ...(adapter.respondToQuestion !== undefined && { user_questions: true }),
        ...(adapter.permissionModes !== undefined && { permission_modes: true }),
        ...(adapter.suggestedTasks === true && { suggested_tasks: true }),
        ...(adapter.fork !== undefined && { side_sessions: true }),
        ...(adapter.compact !== undefined && { session_compact: true }),
        ...(adapter.review !== undefined && { session_review: true }),
        ...(adapter.startGoal !== undefined && { session_goals: true }),
        ...(adapter.acceptsImages !== undefined && { user_images: true }),
        ...(mcp !== undefined && { app_tools: true }),
        ...(mcp !== undefined && { shared_files: true }),
        ...(mcp !== undefined && { task_board: true }),
        ...(suggestionInstructions !== undefined && { prompt_suggestions: true }),
        ...(browsers !== undefined && { browser_tools: true }),
        ...(options.web !== undefined && { web_tools: true }),
        ...(adapter.planMode === true && { plan_mode: true }),
        ...(adapter.fork !== undefined && adapter.branches === true && { session_branches: true }),
        ...(adapter.rewind !== undefined && { session_rewind: true }),
        ...(adapter.injectNote !== undefined && { session_undo: true }),
        ...(recapInstructions !== undefined && { session_recap: true }),
      },
      engineFeatures,
      plugins,
      ...(accounts !== undefined && { accounts }),
      settings,
      ...(browsers !== undefined && { browsers }),
      ...(options.port !== undefined && { port: options.port }),
      // 桌面渲染进程的 WebSocket 带 Origin 头（host-api.md §1）。
      allowedOrigins: DESKTOP_RENDERER_ORIGINS,
      onShutdownRequest: (client) => requestShutdown({ kind: 'rpc', client }),
      httpHandler: (req, res) => fileUrls.handle(req, res) || (mcp?.handle(req, res) ?? false),
      onError: (error) => logger.error('rpc error', { error }),
    });
    rpc = server;
    const url = await server.listen();
    mcp?.setPort(server.port);
    fileUrls.setPort(server.port);
    // 一个进程服务所有会话的引擎（OpenCode）拿引擎令牌；它的服务器下次起来时挂上。
    if (mcp !== undefined) adapter.bindEngineAppTools?.((kinds) => mcp.grantEngine(kinds));
    await runtimeFile.publish(url, token);

    let stopping: Promise<void> | undefined;
    const host: RunningHost = {
      home,
      hostId,
      url,
      runtimeFile,
      shutdown: (trigger = { kind: 'api' }) => {
        stopping ??= shutdownSequence({
          trigger,
          budgetMs: options.shutdownBudgetMs ?? SHUTDOWN_BUDGET_MS,
          logger,
          rpc: server,
          appMcp: mcp,
          processes,
          lsp,
          sessions: manager,
          adapter,
          accounts,
          checkpoints,
          events: store,
          storage: db,
          runtimeFile,
          ...(options.web !== undefined && { web: options.web }),
        });
        return stopping;
      },
      releaseRuntimeFileSync: () => runtimeFile.releaseSync(),
    };
    requestShutdown = options.onShutdownRequest ?? ((trigger) => void host.shutdown(trigger));
    logger.info('host ready', {
      url,
      hostId,
      hostVersion: HOST_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      engine: options.engine,
      home,
    });
    return host;
  } catch (error) {
    // 回收已建好的部分；这里的失败不掩盖原始错误。
    await rpc?.close().catch(() => {});
    await backgroundProcesses?.close().catch(() => {});
    accounts?.dispose();
    await turnCheckpoints?.dispose();
    await sessions?.dispose().catch(() => {});
    await adapter.dispose().catch(() => {});
    await options.web?.close().catch(() => {});
    try {
      events?.close();
      storage?.close();
    } catch {
      // 同上。
    }
    runtimeFile.releaseSync();
    throw error;
  }
}

interface ShutdownParts {
  trigger: ShutdownTrigger;
  budgetMs: number;
  logger: Logger;
  rpc: HostRpcServer;
  /** 应用级工具的 MCP 端点（0.30.0）；引擎挂不上时没有。 */
  appMcp: AppMcpServer | undefined;
  /** 后台进程（processes.ts）；没有应用级工具时没有。 */
  processes: ProcessManager | undefined;
  /** 代码智能的语言服务器；引擎挂不上应用级工具时没有。 */
  lsp: LspManager | undefined;
  sessions: SessionManager;
  adapter: AgentRuntimeAdapter;
  accounts: HostAccounts | undefined;
  checkpoints: TurnCheckpoints;
  events: EventStore;
  storage: Storage;
  runtimeFile: RuntimeFile;
  web?: WebService;
}

async function shutdownSequence(parts: ShutdownParts): Promise<void> {
  const { logger } = parts;
  const startedAt = performance.now();
  const deadline = startedAt + parts.budgetMs;
  logger.info('shutting down', { trigger: describeTrigger(parts.trigger) });
  /** 执行一步，返回是否完成。`bounded` 的步骤超过预算就记日志、不再等它。 */
  const step = async (name: string, run: () => unknown, bounded = false): Promise<boolean> => {
    const stepStartedAt = performance.now();
    try {
      const result = Promise.resolve().then(run);
      if (bounded && (await beforeDeadline(result, deadline)) === 'timeout') {
        logger.error('shutdown step timed out', { step: name, ms: elapsed(stepStartedAt) });
        return false;
      }
      await result;
      logger.info('shutdown step done', { step: name, ms: elapsed(stepStartedAt) });
      return true;
    } catch (error) {
      logger.error('shutdown step failed', { step: name, ms: elapsed(stepStartedAt), error });
      return false;
    }
  };
  // 应用级工具不再接新调用，进行中的等待（wevir_session_wait）随即返回。
  parts.appMcp?.close();
  // 后台进程：SIGTERM，宽限期后 SIGKILL，不再通知。
  if (parts.processes !== undefined) {
    await step('stop_processes', () => parts.processes?.close(), true);
  }
  // 新连接回 503、新请求回 HOST_SHUTTING_DOWN，等在途请求结束；已连上的客户端继续收事件。
  await step('stop_accepting', () => parts.rpc.stopAccepting(), true);
  // 取消回合的事件经订阅推送出去，所以连接要留到后面再关。
  if (!(await step('cancel_turns', () => parts.sessions.shutdown(), true))) {
    // 不再等引擎结算：先停止写事件，之后才能安全地关闭数据库。会话停在活动状态，下次启动时对账（#15）。
    void parts.sessions.dispose().catch((error: unknown) => {
      logger.error('session manager dispose failed', { error });
    });
  }
  parts.accounts?.dispose();
  // 回合结束后的快照不再等：没打完的回合，diff 对着工作树（live）。进行中的 git 停下后等它退出（不超过预算）。
  await beforeDeadline(parts.checkpoints.dispose(), deadline);
  // 超时的话引擎进程留给适配器自己回收（ACP 引擎读到 stdin EOF 即退出）。
  await step('dispose_adapter', () => parts.adapter.dispose(), true);
  // 语言服务器：先 shutdown / exit，不退出的结束进程。
  if (parts.lsp !== undefined) await step('close_lsp', () => parts.lsp?.close(), true);
  // 引擎（和它挂着的桥脚本）停了之后再关联网服务的端点。
  if (parts.web !== undefined) await step('close_web', () => parts.web?.close(), true);
  await step('flush_storage', () => {
    parts.events.close();
    parts.storage.close();
  });
  await step('close_connections', () => parts.rpc.close());
  await step('remove_runtime_file', () => {
    if (!parts.runtimeFile.releaseSync()) {
      logger.warn('runtime file was not removed (missing or owned by another process)', {
        path: parts.runtimeFile.path,
      });
    }
  });
  logger.info('host stopped', { ms: elapsed(startedAt) });
}

/** `promise` 在 `deadline`（`performance.now()` 的时刻）之前完成返回 `done`，否则 `timeout`。 */
async function beforeDeadline(
  promise: Promise<unknown>,
  deadline: number,
): Promise<'done' | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), Math.max(0, deadline - performance.now()));
  });
  try {
    return await Promise.race([promise.then(() => 'done' as const), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function describeTrigger(trigger: ShutdownTrigger): Record<string, unknown> {
  switch (trigger.kind) {
    case 'rpc':
      return { kind: 'rpc', client: trigger.client };
    case 'signal':
      return { kind: 'signal', signal: trigger.signal };
    case 'fatal':
      return { kind: 'fatal', error: trigger.error };
    default:
      return { kind: trigger.kind };
  }
}

function elapsed(since: number): number {
  return Math.round(performance.now() - since);
}

/**
 * `<数据目录>/host-id`：每个数据目录一个 `hostId`，跨重启不变（host-api.md §2）。不存在或内容不合法
 * 时生成新的，以 0600 写临时文件再 rename。
 */
async function loadHostId(home: string, logger: Logger): Promise<HostId> {
  const path = homePath(home, 'hostIdFile');
  try {
    const text = (await readFile(path, 'utf8')).trim();
    const parsed = HostIdSchema.safeParse(text);
    if (parsed.success) return parsed.data;
    logger.warn('invalid host-id file, generating a new hostId', { path });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const hostId = newId('hst');
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(`${hostId}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return hostId;
}

/**
 * 每种 Provider 的引擎能做什么（0.25.0）：多引擎的路由按各自的引擎给；只有一个引擎（没挂订阅来源的 Codex、没挂假订阅的 echo）时每种都是它。
 */
export function hostEngineFeatures(
  adapter: AgentRuntimeAdapter,
  engine: string,
): Record<string, EngineFeatures> {
  if (adapter instanceof EngineRouter) return adapter.engineFeatures();
  const features = engineFeaturesOf(engine, adapter);
  return Object.fromEntries(ProviderKindSchema.options.map((kind) => [kind, features]));
}
