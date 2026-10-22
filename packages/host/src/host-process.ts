import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  AUTOMATION_QUIET_MARKER,
  type ClientIdentity,
  DESKTOP_RENDERER_ORIGINS,
  type EngineFeatures,
  type HostId,
  HostIdSchema,
  PROTOCOL_VERSION,
  ProviderKindSchema,
  type ProviderTranscriptionModel,
  type SessionId,
  type WorkspaceId,
} from '@wevir/protocol';
import type { AgentRuntimeAdapter } from '@wevir/runtime-adapter';
import { guardrailChecker } from '@wevir/runtime-adapter/guardrail';
import { FileSecretStore, openStorage, type Storage } from '@wevir/storage';
import packageJson from '../package.json' with { type: 'json' };
import { HostAccounts } from './accounts.js';
import { AppMcpServer } from './app-mcp.js';
import { AppTools, engineSessionResolver } from './app-tools.js';
import { ApprovalRuleService } from './approval-rules/service.js';
import { automationRunMessage } from './automations/automation-tools.js';
import { AutomationService } from './automations/service.js';
import { BrowserBroker } from './browser-broker.js';
import { ChatFolders } from './chats.js';
import { TurnCheckpoints } from './checkpoints.js';
import {
  type CustomPrompts,
  customInputs,
  loadCustomPrompts,
  planCustom,
  styleReminder,
  writingStyleInput,
} from './custom-instructions.js';
import { EnginePathStore } from './engine-paths.js';
import { EngineRouter, engineFeaturesOf } from './engine-router.js';
import { EventStore } from './event-store.js';
import { ExternalImport } from './external-import/service.js';
import { FileUrls } from './file-urls.js';
import { GitService } from './git/service.js';
import { GuardrailService } from './guardrails/service.js';
import { homePath } from './home.js';
import { createHostMethods, createProviderLock, syncProviders } from './host-methods.js';
import { newId } from './ids.js';
import { ImageStore } from './images.js';
import { InboxService } from './inbox.js';
import { loadInsightInstructions } from './insight.js';
import { KeepAwake } from './keep-awake.js';
import type { Logger } from './logger.js';
import { LspManager } from './lsp/manager.js';
import { LspStatusService } from './lsp/service.js';
import { MarketService, type MarketServiceOptions } from './market/service.js';
import { McpRemoteProxy } from './mcp-oauth/proxy.js';
import { type McpOAuthOptions, McpOAuthService } from './mcp-oauth/service.js';
import { MemoryStore } from './memory.js';
import { instructionsWithMemory } from './memory-tools.js';
import { NotificationService } from './notifications.js';
import type { TestConnectionGrant } from './permissions.js';
import { PluginRegistry } from './plugins.js';
import { Presence } from './presence.js';
import { PreviewService } from './preview/service.js';
import { PreviewStore } from './preview/store.js';
import { ProcessOutputService } from './process-output.js';
import { ProcessManager } from './processes.js';
import { loadSuggestionInstructions } from './prompt-suggestion.js';
import { ReadinessService } from './readiness/service.js';
import { loadRecapInstructions } from './recap.js';
import { RetroService } from './retro/service.js';
import { loadRetroInstructions } from './retro/summary.js';
import { loadReviewTemplate, ReviewService } from './review/service.js';
import { RoleStore } from './roles.js';
import { HostRpcServer } from './rpc-server.js';
import { discoverRuleFiles } from './rule-files.js';
import { RuntimeFile } from './runtime-file.js';
import { loadOpinionTemplate, SecondOpinionService } from './second-opinion.js';
import { SessionListFeed } from './session-list.js';
import { SessionManager, type SessionManagerOptions } from './session-manager.js';
import { SessionSearch } from './session-search.js';
import { HostSettingsStore } from './settings.js';
import { SpeechModelInstaller } from './speech/install.js';
import { LocalTranscriber, loadSherpa } from './speech/local.js';
import {
  loadPolishInstructions,
  POLISH_OUTPUT_SCHEMA,
  POLISH_TIMEOUT_MS,
  parsePolish,
  polishInput,
} from './speech/polish.js';
import { SpeechService } from './speech/service.js';
import { boardEventRecorder, TaskBoardStore } from './task-board.js';
import { loadTerminalModules, TerminalService } from './terminals.js';
import { defaultPromptsDir, loadTitleInstructions } from './title.js';
import { ToolOutputStore } from './tool-output.js';
import { ProfileBlobStore } from './tuning/blobs.js';
import { ProfileCollector } from './tuning/profile.js';
import { ProposalService } from './tuning/proposals.js';
import { loadProposalInstructions } from './tuning/proposals-input.js';
import { TuningService } from './tuning/service.js';
import { PricingStore } from './usage/pricing.js';
import { UsageService } from './usage/usage-service.js';
import { ChecksStore } from './verification/checks-store.js';
import { CheckRunner } from './verification/runner.js';
import { loadRepairTemplate, VerificationService } from './verification/service.js';
import type { WebService } from './web/service.js';
import { WritingStyleStore } from './writing-style/store.js';

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
  | { kind: 'parent_port' }
  | { kind: 'fatal'; error: unknown }
  | { kind: 'api' };

export interface StartHostOptions {
  /**
   * 只给测试（0.98.0，permissions.ts）：hello 后让某条连接以受限的身份与权限工作。wevir-host 与桌面的入口不传它，Host 也不从
   * 环境变量读，省略时每条连接都是本机身份、全部权限。
   */
  testConnectionGrant?: TestConnectionGrant;
  /** 远程 MCP 服务的 OAuth（0.97.0）：测试换掉 CIMD 地址、登录超时、时钟与 DNS 解析。 */
  mcpOAuth?: Pick<McpOAuthOptions, 'clientMetadataUrl' | 'loginTimeoutMs' | 'now' | 'lookup'>;
  /** 官方插件市场的镜像地址、公钥与 fetch（0.91.0）；省略用 wevir-marketplace 的三个镜像（测试换成本机服务）。 */
  market?: Pick<MarketServiceOptions, 'mirrors' | 'publicKeys' | 'fetch'>;
  /** 测试时与隔离的引擎 HOME 一致；产品默认 os.homedir()。 */
  pluginUserHome?: string;
  /** 找用户级规则文件（0.68.0，`~/.codex/AGENTS.md` 等）的家目录；省略时同 `pluginUserHome`，再省略是 os.homedir()。 */
  userHome?: string;
  /**
   * 导入（0.74.0）读的环境变量（`CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`GROK_HOME`）；省略是 `process.env`。导入找用户目录的家目录同
   * `userHome`。
   */
  importEnv?: Readonly<Record<string, string | undefined>>;
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
   * Wevir 提示词目录（会话标题用 `thread-title.md`，内置 skills 在 `skills/`），默认仓库的 `prompts/`。wevir-host 传 adapter-codex 的
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
  let automations: AutomationService | undefined;
  let rpc: HostRpcServer | undefined;
  let backgroundProcesses: ProcessManager | undefined;
  let userTerminals: TerminalService | undefined;
  let verificationService: VerificationService | undefined;
  let readiness: ReadinessService | undefined;
  let devPreviews: PreviewService | undefined;
  let dictation: SpeechService | undefined;
  let accounts: HostAccounts | undefined;
  let turnCheckpoints: TurnCheckpoints | undefined;
  let sessionSearch: SessionSearch | undefined;
  let sessionList: SessionListFeed | undefined;
  let inbox: InboxService | undefined;
  let notifications: NotificationService | undefined;
  let approvalRules: ApprovalRuleService | undefined;
  let guardrails: GuardrailService | undefined;
  try {
    const hostId = await loadHostId(home, logger);
    storage = openStorage({ dataDir: home });
    const store = new EventStore({
      storage,
      onError: (error) => logger.error('event store error', { error }),
    });
    events = store;
    // 会话全文搜索（0.77.0）：索引从事件派生，后台按批追上，新事件写入后稍后追。出错只记日志，不影响会话。
    sessionSearch = new SessionSearch({
      storage,
      onError: (error) => logger.warn('session search index error', { error }),
    });
    const search = sessionSearch;
    store.listenAll(() => search.notify());
    search.start();
    // 会话列表推送（0.101.0）：读过 session.list 的连接收 sessions.changed。
    const listFeed = new SessionListFeed({
      storage,
      events: store,
      onError: (error) => logger.warn('session list push error', { error }),
    });
    sessionList = listFeed;
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
    // 用户的说明与输出风格（0.78.0）：读不到提示词就没有这个功能，不阻止 Host 启动。
    let customPrompts: CustomPrompts | undefined;
    try {
      customPrompts = loadCustomPrompts(options.promptsDir);
    } catch (error) {
      logger.warn('failed to load the output style prompts; custom instructions are off', {
        error,
      });
    }
    // 你应该知道（0.79.0）：同标题，适配器能生成才读提示词；读不到只是没有这个功能。
    let insightInstructions: string | undefined;
    if (adapter.generateTitle !== undefined) {
      try {
        insightInstructions = loadInsightInstructions(options.promptsDir);
      } catch (error) {
        logger.warn('failed to load the session insight prompt; insights are unavailable', {
          error,
        });
      }
    }
    // Host 设置（R11，domain-model §3.7）：文件有问题时用默认值并告警。
    const settings = new HostSettingsStore({
      path: homePath(home, 'settingsFile'),
      onWarning: (message, fields) => logger.warn(message, fields),
    });
    await settings.load();
    // 防休眠的判定（0.102.0，domain-model §3.45）：设置与会话事件进来，值变了经 `power.changed` 交给桌面主进程。
    const keepAwake = new KeepAwake(settings.get());
    settings.watch((current) => keepAwake.settingsChanged(current));
    store.listenAll((event) => keepAwake.onEvent(event));
    // 回合快照（0.20.0）：只认还开着的会话，清理时删掉别的会话留下的 ref。
    const sessionsDb = storage;
    const secrets = new FileSecretStore(home);
    // 远程 MCP 服务的 OAuth（0.97.0，mcp-oauth/）：令牌在密钥文件里，代理开在 RPC 的同一个端口上（监听之后才交给引擎）。
    const mcpOAuth = new McpOAuthService({
      secrets,
      onSecret: (value) => logger.addSecret(value),
      onWarning: (message) => logger.warn(message),
      ...options.mcpOAuth,
    });
    const plugins = new PluginRegistry({
      oauth: mcpOAuth,
      home,
      ...(options.pluginUserHome !== undefined && { userHome: options.pluginUserHome }),
      roots: () => sessionsDb.workspaces.list().map((workspace) => workspace.rootPath),
      adapter,
      builtinSkillsRoot: join(options.promptsDir ?? defaultPromptsDir(), 'skills'),
      onWarning: (message) => logger.warn(message),
    });
    await plugins.load();
    await mcpOAuth.load();
    const mcpRemote = new McpRemoteProxy({
      oauth: mcpOAuth,
      target: (id) => plugins.oauthTargetById(id),
      onError: (error) => logger.warn('remote MCP proxy error', { error }),
    });
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
    let opinions: SecondOpinionService | undefined;
    let review: ReviewService | undefined;
    // 大输出落盘与后台进程（tool-output.ts、processes.ts）：过期的文件启动时在后台清掉。
    const toolOutput = new ToolOutputStore(homePath(home, 'toolOutputDir'));
    void toolOutput
      .prune()
      .catch((error: unknown) => logger.warn('failed to prune tool output', { error }));
    // 用户的交互终端（0.69.0，terminals.ts）：node-pty 加载不了时没有，不声明 user_terminal。
    const terminalModules = await loadTerminalModules((message, fields) =>
      logger.warn(message, fields),
    );
    const terminals =
      terminalModules !== undefined
        ? new TerminalService({
            storage,
            modules: terminalModules,
            onWarning: (message, fields) => logger.warn(message, fields),
          })
        : undefined;
    userTerminals = terminals;
    // 进程输出（0.69.0，process-output.ts）：客户端看 Agent 的后台进程与检查的进程。
    const processOutput = new ProcessOutputService({ storage });
    const processes =
      adapter.appTools === true
        ? new ProcessManager({
            output: toolOutput,
            onNotice: (notice) => appTools?.onProcessNotice(notice),
            onWarning: (message, fields) => logger.warn(message, fields),
            onChange: (change) => processOutput.onChange(change),
          })
        : undefined;
    backgroundProcesses = processes;
    if (processes !== undefined) processOutput.attachAgent(processes);
    // 不在项目里的会话（0.39.0）：“对话”工作区与每个会话的文件夹。
    const chats = new ChatFolders({ dir: homePath(home, 'chatsDir') });
    await chats.load();
    // 跨会话记忆（memory.ts）：全局一份、每个项目一份，会话开始时索引放进应用级工具的说明；用户经 `memory.*` 管理（0.57.0），
    // Host 设置的 `autoMemory` 关掉时索引与工具都不给。
    const memory = new MemoryStore({ dir: homePath(home, 'memoryDir') });
    // 写作风格（0.95.0）：档案与建档期间的样本；放了太久的样本启动时删掉。
    const writingStyle = new WritingStyleStore({ dir: homePath(home, 'writingStyleDir') });
    writingStyle.pruneStale().catch((error: unknown) => {
      logger.warn('failed to prune writing style samples', { error });
    });
    // 从其他应用导入（0.74.0）：读用户自己的 Claude Code、Codex、Grok Build、Antigravity 目录。
    const externalImport = new ExternalImport({
      userHome: options.userHome ?? options.pluginUserHome ?? homedir(),
      env: options.importEnv ?? process.env,
      workspaces: {
        list: () => sessionsDb.workspaces.list(),
        get: (id) => sessionsDb.workspaces.get(id),
      },
      memory,
      plugins,
    });
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
    // 用量统计（0.62.0）：每次模型请求记进用量表；成本按 models.dev 的价格表算，价格表每天刷新。
    let usage: UsageService | undefined;
    const pricing = new PricingStore({
      file: homePath(home, 'pricingFile'),
      onChange: () => usage?.pricingChanged(),
      onWarning: (message, fields) => logger.warn(message, fields),
    });
    usage = new UsageService({
      storage,
      pricing,
      onWarning: (message, fields) => logger.warn(message, fields),
    });
    const usageStats = usage;
    void pricing.start();
    // 审批规则（0.80.0）：存在库里，Host 在引擎发来命令审批时匹配，与引擎无关。规则变了档案也跟着变。
    const ruleService = new ApprovalRuleService({
      storage,
      onChange: (workspaceId) => tuning.changed(workspaceId),
    });
    approvalRules = ruleService;
    // 调优的档案（0.85.0）：建会话、恢复与接力时记下用的档案版本；条目的文本存在 `<数据目录>/tuning/blobs`。
    const userHome = options.userHome ?? options.pluginUserHome ?? homedir();
    const tuning = new TuningService({
      storage,
      collector: new ProfileCollector({
        promptsDir: options.promptsDir ?? defaultPromptsDir(),
        userHome,
        ruleFiles: (cwd) => discoverRuleFiles({ cwd, home: userHome }),
        settings: () => settings.get(),
        memory,
        skills: () => plugins.enabledSkills(),
        roles,
        rolesDir: homePath(home, 'rolesDir'),
        // 全局档案只算全局规则；项目的算全局的与这个项目的。
        approvalRules: (workspaceId) =>
          workspaceId === undefined
            ? ruleService.list().filter((rule) => rule.workspaceId === undefined)
            : ruleService.list(workspaceId),
        // 护栏在下面才建好；采集总在之后。
        guardrails: (workspaceId) => guardrails?.list(workspaceId as WorkspaceId | undefined) ?? [],
        repoHooks: (workspaceId) => {
          try {
            return guardrails?.repoHooks(workspaceId as WorkspaceId).hooks ?? [];
          } catch {
            return [];
          }
        },
        connectors: () => plugins.connectors(),
        plugins: () => plugins.pluginVersions(),
      }),
      blobs: new ProfileBlobStore(join(homePath(home, 'tuningDir'), 'blobs')),
      wevirVersion: HOST_VERSION,
      isChats: (workspace) => chats.isChats(workspace),
    });
    memory.watch((change) => tuning.changed(change.workspaceId));
    settings.watch(() => tuning.changed());
    // 官方插件市场（0.91.0）：缓存在 plugins/market/official，镜像的选择跟着设置走。
    const market = new MarketService({
      dir: join(homePath(home, 'pluginsDir'), 'market', 'official'),
      preference: () => settings.get().marketMirror ?? 'auto',
      ...options.market,
      onWarning: (message, fields) => logger.warn(message, fields),
    });
    settings.watch(() => {
      void market
        .preferenceChanged()
        .catch((error: unknown) => logger.warn('plugin market state update failed', { error }));
    });
    plugins.watch(() => tuning.changed());
    void tuning
      .prune()
      .catch((error: unknown) => logger.warn('tuning blob cleanup failed', { error }));
    // 护栏（0.86.0）：规则文件与检查程序在数据目录；只有认 Codex hooks 的引擎挂得上。
    const workspaces = storage.workspaces;
    guardrails = new GuardrailService({
      checker: guardrailChecker(homePath(home, 'guardrailsDir')),
      workspaceRoot: (workspaceId) => {
        const workspace = workspaces.get(workspaceId);
        return workspace === undefined || workspace.removedAt !== undefined
          ? undefined
          : workspace.rootPath;
      },
      onWarning: (message, fields) => logger.warn(message, fields),
    });
    // 规则与仓库 hooks 的启用进档案；只是命中计数变了不算。
    guardrails.watch((change, { hitsOnly }) => {
      if (!hitsOnly) tuning.changed(change.workspaceId);
    });
    const manager = new SessionManager({
      storage,
      events: store,
      adapter,
      approvalRules,
      guardrails,
      appTools: {
        grant: (sessionId) => appMcp?.grant(sessionId),
        prepareEvent: (sessionId, event) => {
          // 代码智能：记下引擎改过的文件（不改事件）。
          appTools?.lsp?.observe(sessionId, event);
          return appTools?.plugins?.prepareEvent(sessionId, event) ?? Promise.resolve(event);
        },
        resolved: (sessionId, toolCallId, approved) =>
          appTools?.plugins?.resolved(sessionId, toolCallId, approved),
        forget: (sessionIds) => {
          void processes?.removeSessions(sessionIds);
          terminals?.removeSessions(sessionIds);
          void verificationService?.removeSessions(sessionIds);
        },
        dispose: () => appTools?.plugins?.close(),
      },
      // 只给某个项目的连接器（0.74.0）：按会话所在的工作区交给引擎。
      projectConnectors: (workspaceId) => plugins.projectConnectors(workspaceId),
      onTurnFinished: (info) => {
        appTools?.onTurnFinished(info);
        automations?.onTurnFinished(info);
        opinions?.onTurnFinished(info);
        // 订阅账号的会话：回合结束后重读那个账号的用量（usage-refresh.ts）。账号 ID 就是它的 Provider 的 ID；不是账号
        // （API Key 的 Provider）时 `turnEnded` 什么都不做。
        const providerId = storage?.sessions.get(info.sessionId)?.providerId;
        if (providerId !== undefined) accounts?.usage.turnEnded(providerId);
      },
      onUsage: (context, event) => usageStats.record(context, event),
      // 审查发现（0.83.0）存成批注；没有批注功能时只记文字。
      reviewFindings: (sessionId, input) =>
        review === undefined
          ? Promise.reject(new Error('review comments are unavailable'))
          : review.recordFindings(sessionId, input),
      engine: options.engine,
      onError: (error) => logger.error('session manager error', { error }),
      onWarning: (message, fields) => logger.warn(message, fields),
      // 无人值守会话里审批的超时（0.103.0）：每次记下审批时按当时的设置。
      approvalTimeoutMs: () => (settings.get().unattendedApprovalTimeoutMinutes ?? 0) * 60_000,
      ...(titleInstructions !== undefined && { titleInstructions }),
      // 起标题前查清不透明的链接（title.ts），按联网设置。
      ...(options.web !== undefined && { lookupLink: options.web.preview.bind(options.web) }),
      ...(suggestionInstructions !== undefined && {
        suggestion: {
          instructions: suggestionInstructions,
          enabled: () => settings.get().promptSuggestions !== false,
        },
      }),
      ...(recapInstructions !== undefined && { recapInstructions }),
      recapEnabled: () => settings.get().sessionRecap !== false,
      ...(insightInstructions !== undefined && {
        insight: {
          instructions: insightInstructions,
          enabled: () => settings.get().sessionInsights === true,
        },
      }),
      // 环境会话新开的 worktree（0.15.0，domain-model §3.10）。
      worktreesDir: join(home, 'worktrees'),
      chats,
      checkpoints,
      engineFeatures,
      historyDir: homePath(home, 'historyDir'),
      // 接力时用户选入的笔记（0.59.0）；自动记忆关着时不能选。
      memory,
      memoryEnabled: () => settings.get().autoMemory !== false,
      // 跨引擎的规则文件（0.68.0）：引擎不读的由 Host 补；设置关掉时只记引擎自己读的。
      ruleFiles: {
        discover: (cwd) =>
          discoverRuleFiles({ cwd, home: options.userHome ?? options.pluginUserHome ?? homedir() }),
        enabled: () => settings.get().ruleFiles !== false,
      },
      // 用户的说明与输出风格（0.78.0）：每次建立、恢复与接力引擎会话时按当时的设置与项目算。
      ...(customPrompts !== undefined && {
        customInstructions: customInstructionsOf(customPrompts, settings, writingStyle),
      }),
      toolOutputDir: toolOutput.dir,
      images,
      profile: { ensure: (workspaceId) => tuning.ensure(workspaceId) },
    });
    sessions = manager;
    // 自动化（0.66.0，automations/service.ts）：Host 自己计时，到点开会话、发指令；对账之后再开始计时。
    automations = new AutomationService({
      dir: homePath(home, 'automationsDir'),
      storage,
      events: store,
      sessions: manager,
      identity: { deviceId: hostId, clientId: 'wevir-automations', clientKind: 'desktop' },
      isChats: (workspaceId) => {
        const workspace = storage?.workspaces.get(workspaceId);
        return workspace !== undefined && chats.isChats(workspace);
      },
      message: (automation, context) =>
        automationRunMessage(automation, { ...context, marker: AUTOMATION_QUIET_MARKER }),
      onWarning: (message, fields) => logger.warn(message, fields),
    });
    const automationService = automations;
    const recovery = manager.recover();
    if (
      recovery.expiredApprovals > 0 ||
      recovery.interruptedSessions.length > 0 ||
      recovery.unknownSends > 0
    ) {
      logger.warn('recovered from unclean shutdown', { ...recovery });
    }
    const checksStore = new ChecksStore({
      dir: homePath(home, 'checksDir'),
      onWarning: (message, fields) => logger.warn(message, fields),
    });
    // 项目环境就绪（0.70.0，readiness/service.ts）：只读的预检、用户发起的安装与安装凭据；回合后验证据它把失败记成环境不可用。上次没
    // 跑完的安装记成取消。
    const readinessService = new ReadinessService({
      storage,
      checks: async (workspaceId) => (await checksStore.list(workspaceId)).checks,
      secrets,
      dir: homePath(home, 'readinessDir'),
      defaultEngine: options.engine,
      isChats: (workspaceId) => {
        const workspace = storage?.workspaces.get(workspaceId);
        return workspace !== undefined && chats.isChats(workspace);
      },
      onWarning: (message, fields) => logger.warn(message, fields),
    });
    readiness = readinessService;
    const abandonedInstalls = await readinessService.recover();
    if (abandonedInstalls > 0)
      logger.warn('marked unfinished installs as cancelled', { count: abandonedInstalls });
    // 回合后验证（0.65.0，ADR-0008）：检查配置存在 Host，检查进程由 Host 起（与 Agent 的后台进程分开）。上次没跑完的检查与修复链
    // 在服务客户端之前对账，什么都不重开。修复材料的模板读不到时不阻止 Host 启动，只是没有这个功能。
    try {
      verificationService = new VerificationService({
        storage,
        events: store,
        listenAll: (listener) => store.listenAll(listener),
        sessions: manager,
        checks: checksStore,
        readiness: readinessService,
        runner: new CheckRunner({
          dir: toolOutput.dir,
          onWarning: (message, fields) => logger.warn(message, fields),
          onChange: (change) => processOutput.onChange(change),
        }),
        checkpoints,
        hostId,
        repairTemplate: loadRepairTemplate(options.promptsDir),
        onWarning: (message, fields) => logger.warn(message, fields),
        onError: (error) => logger.error('verification error', { error }),
      });
      processOutput.attachChecks(verificationService);
      const reconciled = verificationService.recover();
      if (reconciled.cancelledRuns > 0 || reconciled.stoppedRepairs > 0) {
        logger.warn('reconciled verification after unclean shutdown', { ...reconciled });
      }
    } catch (error) {
      verificationService = undefined;
      logger.warn('verification is unavailable', { error });
    }
    const verification = verificationService;
    // 开发服务器预览（0.84.0，ADR-0013）：运行配置存在 Host，启动是会话里的后台进程，所以要有后台进程（应用级工具）。
    const previews =
      processes !== undefined
        ? new PreviewService({
            storage,
            store: new PreviewStore({
              dir: homePath(home, 'previewsDir'),
              onWarning: (message, fields) => logger.warn(message, fields),
            }),
            processes,
            readiness: readinessService,
            onWarning: (message, fields) => logger.warn(message, fields),
          })
        : undefined;
    devPreviews = previews;
    // 行级批注（0.67.0，ADR-0009）：消息模板读不到时不阻止 Host 启动，只是没有这个功能。
    try {
      review = new ReviewService({
        storage,
        sessions: manager,
        template: loadReviewTemplate(options.promptsDir),
      });
    } catch (error) {
      logger.warn('review comments are unavailable', { error });
    }

    // 第二意见（0.75.0）：消息模板读不到时不阻止 Host 启动，只是没有这个功能。上次没跑完的意见在服务客户端之前对账。
    try {
      opinions = new SecondOpinionService({
        storage,
        events: store,
        sessions: manager,
        hostId,
        template: loadOpinionTemplate(options.promptsDir),
        onWarning: (message, fields) => logger.warn(message, fields),
      });
      const fixed = opinions.recover();
      if (fixed > 0) logger.warn('reconciled second opinions after unclean shutdown', { fixed });
    } catch (error) {
      opinions = undefined;
      logger.warn('second opinions are unavailable', { error });
    }
    const secondOpinions = opinions;
    // 任务回顾（0.76.0，ADR-0012）：投影存在 SQLite，按需生成；模型摘要同离开后摘要，适配器能生成才读提示词，读不到只是没有摘要。
    let retroInstructions: string | undefined;
    if (adapter.generateTitle !== undefined) {
      try {
        retroInstructions = loadRetroInstructions(options.promptsDir);
      } catch (error) {
        logger.warn('failed to load the session retro prompt; retro summaries are unavailable', {
          error,
        });
      }
    }
    const retro = new RetroService({
      storage,
      events: store,
      checkpoints,
      ...(review !== undefined && { review }),
      memory,
      resolveDir: (dir) => realpath(dir),
      ...(retroInstructions !== undefined && {
        instructions: retroInstructions,
        generate: (sessionId, request) => manager.generateOnce(sessionId, request),
      }),
      onWarning: (message, fields) => logger.warn(message, fields),
    });
    // 调优的建议（0.87.0）：同回顾摘要，适配器能生成才读提示词；读不到就没有建议（不声明 `tuning_proposals`）。
    let proposalInstructions: string | undefined;
    if (adapter.generateTitle !== undefined) {
      try {
        proposalInstructions = loadProposalInstructions(options.promptsDir);
      } catch (error) {
        logger.warn('failed to load the tuning proposals prompt; proposals are unavailable', {
          error,
        });
      }
    }
    const proposals =
      proposalInstructions === undefined
        ? undefined
        : new ProposalService({
            storage,
            events: store,
            retro,
            instructions: proposalInstructions,
            generate: (sessionId, request) => manager.generateOnce(sessionId, request),
            isChats: (workspace) => chats.isChats(workspace),
            ruleFiles: (cwd) => discoverRuleFiles({ cwd, home: userHome }),
            skills: () => plugins.enabledSkills(),
            enableSkill: async (path) => {
              const real = await realpath(path).catch(() => path);
              const skill = (await plugins.skills()).find(
                (item) => item.path === real || item.path === path,
              );
              if (skill !== undefined && !skill.enabled)
                await plugins.setSkillEnabled(skill.id, true);
            },
            memory,
            ...(guardrails !== undefined && { guardrails }),
            userHome,
            onProfileChanged: (workspaceId) => tuning.changed(workspaceId),
            onWarning: (message, fields) => logger.warn(message, fields),
          });
    if (proposals !== undefined) {
      tuning.setCauses({
        pending: (workspaceId) => proposals.pendingCause(workspaceId),
        recorded: (versionId, cause) => proposals.recordCause(versionId, cause),
      });
    }

    // 暂存与提交（0.67.0，ADR-0009）：提交框里显示同一代码状态的验证记录，取会话快照里最近的。
    const sessionStore = storage;
    const git = new GitService({
      verification: async (sessionId) => {
        const record = sessionStore.sessions.get(sessionId);
        if (verification === undefined || !record) return undefined;
        const { checks } = await verification.listChecks(record.workspaceId as WorkspaceId);
        const runs = store.snapshot(sessionId as SessionId)?.verification?.runs ?? [];
        return { checks, runs };
      },
    });

    // 账号（R6 的 ChatGPT，0.19.0 起还有订阅来源）：引擎有账号时才有，Host 据此声明 chatgpt_account 与 subscription_sources。
    // 0.63.0：添加的账号各有自己的引擎，在把 Provider 交给引擎之前建好，它们的 Provider 才交得到对的引擎。
    const providerLock = createProviderLock();
    const db = storage;
    const pool = adapter instanceof EngineRouter ? adapter.accountPool : undefined;
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
            ...(pool !== undefined && { pool, accountsDir: homePath(home, 'accountsDir') }),
            onUsageRemoved: () => usageStats.recordsChanged(),
          });

    // 把已存的 Provider（含 Key）交给引擎（T3.4）。失败不阻止 Host 启动：会话建不起来时报引擎错误。
    await syncProviders(storage, secrets, adapter).catch((error: unknown) =>
      logger.error('failed to apply providers to the engine', { error }),
    );
    // 联网服务（0.34.0）：引擎第一次启动时要它的端点，所以在开始服务之前就监听。
    await options.web?.start(secrets);

    // 已登录账号的用量由 Host 定时重读，推给看着账号的客户端（usage-refresh.ts）。
    accounts?.usage.start();
    await automationService.start();
    // 收件箱（0.103.0）：对账与自动化载入之后从事件、审批表与运行记录重建，之后增量维护；调过 inbox.* 的连接收 inbox.changed。
    const inboxService = new InboxService({
      storage,
      events: store,
      automations: automationService,
      secrets: () => plugins.appToolSecrets(),
      onError: (error) => logger.warn('inbox error', { error }),
    });
    inbox = inboxService;
    inboxService.start();
    // 通知意图（0.104.0）：收件箱建好之后从它的新项、回合完成与自动化的等待判定，按 Host 设置的种类开关；Presence 记各连接的在场。
    const notificationService = new NotificationService({
      storage,
      events: store,
      inbox: inboxService,
      automations: automationService,
      settings: () => settings.get(),
      onError: (error) => logger.warn('notification error', { error }),
    });
    notifications = notificationService;
    notificationService.start();
    const presence = new Presence();
    if (accounts?.hasSubscriptions === true) {
      // 用户指定的可执行文件先交给引擎，再在后台检测一遍订阅来源：已登录的种类建好 Provider，模型选择里才看得到。
      // ChatGPT 不在这里读（它的进程第一次用到时才启动，R6）。
      const subscriptions = accounts;
      await subscriptions.applySavedPaths();
      // 添加的账号也一样（0.63.0）。
      void Promise.all(
        subscriptions.ids.flatMap((id) => {
          const kind = subscriptions.kindOf(id);
          if (kind === undefined || kind === 'chatgpt') return [];
          return [subscriptions.read({ kind, id }).catch(() => undefined)];
        }),
      );
    }

    // 内置浏览器（0.33.0）：桌面端登记为浏览器提供方，应用级工具的 browser_* 经它交给桌面端的浏览器。
    const browsers = adapter.appTools === true ? new BrowserBroker() : undefined;
    // 代码智能（lsp_* 工具）：语言服务器按需启动，空闲关闭，Host 退出时回收。
    // 0.71.0：`lsp.*` 看语言服务器的状态、重启、由用户发起安装。
    let lspStatus: LspStatusService | undefined;
    const lsp =
      adapter.appTools === true
        ? new LspManager({
            onWarning: (message, fields) => logger.warn(message, fields),
            onChange: (serverId, root) => lspStatus?.changed({ serverId, root }),
          })
        : undefined;
    if (lsp !== undefined) {
      lspStatus = new LspStatusService({
        lsp,
        onWarning: (message, fields) => logger.warn(message, fields),
      });
    }
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
        ...(previews !== undefined && { previews }),
        readiness: readinessService,
        ...(lsp !== undefined && { lsp }),
        memory,
        memoryEnabled: () => settings.get().autoMemory !== false,
        ...(customPrompts !== undefined && {
          writingStyle: {
            store: writingStyle,
            guide: customPrompts.writingStyle.setup,
            enabled: () => settings.get().writingStyle === true,
          },
        }),
        roles,
        tasks: taskBoards,
        automations: automationService,
        ...(secondOpinions !== undefined && { opinions: secondOpinions }),
        retro,
        search,
        onWarning: (message, fields) => logger.warn(message, fields),
      });
      const tools = appTools;
      appMcp = new AppMcpServer({
        tools: appTools.tools,
        filterTools: (sessionId, list) => tools.filterTools(sessionId, list),
        version: HOST_VERSION,
        instructions: instructionsWithMemory({
          base: (sessionId) => tools.instructions(sessionId),
          memory,
          workspaceOf: (sessionId) => manager.workspaceOf(sessionId),
          enabled: () => settings.get().autoMemory !== false,
          onWarning: (message, fields) => logger.warn(message, fields),
        }),
        onError: (error) => logger.error('app tools error', { error }),
        engineSession: engineSessionResolver(storage, options.engine),
        spill: (sessionId, toolName, result) => toolOutput.spill(sessionId, toolName, result),
      });
    }
    const mcp = appMcp;
    const presetTools = appTools;
    // 文件预览的流式地址（0.32.0，file-urls.ts）：与 MCP 端点同在 RPC 的 HTTP 服务上，监听之后才知道端口。
    const fileUrls = new FileUrls({
      onError: (error) => logger.warn('file preview request failed', { error }),
    });

    // 听写（0.92.0）：本机模型按需下载；这个平台没有 sherpa-onnx 的原生包时只有 Provider 的转写。润色要引擎能不带工具生成。
    let polishInstructions: string | undefined;
    if (adapter.generateTitle !== undefined) {
      try {
        polishInstructions = loadPolishInstructions(options.promptsDir);
      } catch (error) {
        logger.warn('dictation polish is unavailable', { error });
      }
    }
    const speechInstaller = new SpeechModelInstaller({ directory: homePath(home, 'speechDir') });
    const sherpa = loadSherpa((message, fields) => logger.info(message, fields));
    const speech = new SpeechService({
      installer: speechInstaller,
      ...(sherpa !== undefined && {
        local: new LocalTranscriber(sherpa, () => speechInstaller.installed()),
      }),
      settings: () => settings.get(),
      resolveProvider: async (providerId, modelId) => {
        const record = storage?.providers.get(providerId);
        if (
          record === undefined ||
          record.kind !== 'openai-compatible' ||
          record.baseURL === undefined ||
          record.enabled === false
        ) {
          return undefined;
        }
        const models = record.transcriptionModels as ProviderTranscriptionModel[] | undefined;
        if (models?.some((model) => model.id === modelId) !== true) return undefined;
        const apiKey =
          record.secretRef !== undefined ? await secrets.get(record.secretRef) : undefined;
        return { baseURL: record.baseURL, apiKey, modelId };
      },
      ...(polishInstructions !== undefined && {
        polish: async (sessionId: string, text: string) => {
          const result = await manager.generateOnce(sessionId as SessionId, {
            instructions: polishInstructions,
            input: polishInput(text),
            outputSchema: { ...POLISH_OUTPUT_SCHEMA },
            timeoutMs: POLISH_TIMEOUT_MS,
          });
          return 'text' in result ? parsePolish(result.text, text) : undefined;
        },
      }),
      onWarning: (message, fields) => logger.warn(message, fields),
    });
    dictation = speech;
    await speech.init();

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
        mcpOAuth,
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
        memory,
        writingStyle,
        usage: { service: usageStats, pricing },
        ...(verification !== undefined && { verification }),
        automations: automationService,
        ...(review !== undefined && { review }),
        ...(secondOpinions !== undefined && { opinions: secondOpinions }),
        retro,
        git,
        ...(processOutput.available && { processes: processOutput }),
        ...(previews !== undefined && { previews }),
        readiness: readinessService,
        ...(terminals !== undefined && { terminals }),
        ...(lspStatus !== undefined && { lsp: lspStatus }),
        ...(options.web !== undefined && { web: options.web }),
        ...(presetTools !== undefined && { toolPresets: () => presetTools.presets() }),
        externalImport,
        search,
        approvalRules,
        tuning,
        ...(guardrails !== undefined && { guardrails }),
        ...(proposals !== undefined && { proposals }),
        market,
        speech,
        keepAwake,
        inbox: inboxService,
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
        workspace_folders: true,
        file_preview: true,
        session_rename: true,
        session_archive: true,
        session_delete: true,
        worktree_archive: true,
        session_move: true,
        session_handoff: true,
        handoff_material: true,
        handoff_preview: true,
        subagent_cancel: true,
        environments: true,
        session_worktree: true,
        provider_enabled: true,
        chat_sessions: true,
        memory: true,
        usage_stats: true,
        automations: true,
        automation_conditions: true,
        ...(adapter.googleVertex === true && { google_vertex: true }),
        ...(accounts?.kinds.includes('chatgpt') === true && { chatgpt_account: true }),
        ...(accounts?.hasSubscriptions === true && { subscription_sources: true }),
        ...(accounts?.hasUpstreams === true && { subscription_upstreams: true }),
        ...(accounts?.canAddAccounts === true && { subscription_accounts: true }),
        ...(adapter.configureSession !== undefined && { session_configure: true }),
        ...(adapter.respondToQuestion !== undefined && { user_questions: true }),
        ...(adapter.respondToQuestion !== undefined && { question_timeout: true }),
        ...(adapter.permissionModes !== undefined && { permission_modes: true }),
        ...(adapter.suggestedTasks === true && { suggested_tasks: true }),
        ...(adapter.fork !== undefined && { side_sessions: true }),
        ...(adapter.compact !== undefined && { session_compact: true }),
        ...(adapter.review !== undefined && { session_review: true }),
        ...(adapter.startGoal !== undefined && { session_goals: true }),
        ...(adapter.acceptsImages !== undefined && { user_images: true }),
        ...(mcp !== undefined && { app_tools: true }),
        ...(mcp !== undefined && { shared_files: true }),
        ...(mcp !== undefined && { transcript_chapters: true }),
        ...(mcp !== undefined && { task_board: true }),
        ...(mcp !== undefined && { tool_presets: true }),
        ...(suggestionInstructions !== undefined && { prompt_suggestions: true }),
        ...(browsers !== undefined && { browser_tools: true }),
        ...(options.web !== undefined && { web_tools: true }),
        ...(adapter.planMode === true && { plan_mode: true }),
        ...(adapter.fork !== undefined && adapter.branches === true && { session_branches: true }),
        ...(adapter.rewind !== undefined && { session_rewind: true }),
        ...(adapter.injectNote !== undefined && { session_undo: true }),
        ...(recapInstructions !== undefined && { session_recap: true }),
        ...(insightInstructions !== undefined && { session_insights: true }),
        ...(verification !== undefined && { verification: true }),
        rule_files: true,
        ...(review !== undefined && { review_comments: true }),
        ...(review !== undefined && { review_findings: true }),
        git_commit: true,
        session_retro: true,
        ...(processOutput.available && { process_output: true }),
        ...(terminals !== undefined && { user_terminal: true }),
        workspace_readiness: true,
        ...(lspStatus !== undefined && { lsp_status: true }),
        external_import: true,
        ...(secondOpinions !== undefined && { second_opinion: true }),
        session_search: true,
        ...(customPrompts !== undefined && { agent_instructions: true, writing_style: true }),
        approval_rules: true,
        ...(previews !== undefined && { dev_preview: true }),
        tuning: true,
        ...(adapter.hookDialect !== undefined && { tuning_guardrails: true }),
        ...(proposals !== undefined && { tuning_proposals: true }),
        plugin_market: true,
        market_files: true,
        market_install: true,
        speech: true,
        mcp_oauth: true,
        permission_enforcement: true,
        session_list_push: true,
        files_read: true,
        prevent_sleep: true,
        inbox: true,
        approval_timeout: true,
        notification_intents: true,
      },
      engineFeatures,
      plugins,
      ...(accounts !== undefined && { accounts }),
      settings,
      memory,
      sessionList: listFeed,
      inbox: inboxService,
      notifications: notificationService,
      presence,
      usage: usageStats,
      automations: automationService,
      ...(processOutput.available && { processes: processOutput }),
      ...(previews !== undefined && { previews }),
      speech,
      market,
      power: keepAwake,
      ...(guardrails !== undefined && { guardrails }),
      readiness: readinessService,
      ...(terminals !== undefined && { terminals }),
      ...(lspStatus !== undefined && { lsp: lspStatus }),
      tuning,
      ...(proposals !== undefined && { proposals }),
      ...(browsers !== undefined && { browsers }),
      ...(options.port !== undefined && { port: options.port }),
      ...(options.testConnectionGrant !== undefined && {
        testConnectionGrant: options.testConnectionGrant,
      }),
      // 桌面渲染进程的 WebSocket 带 Origin 头（host-api.md §1）。
      allowedOrigins: DESKTOP_RENDERER_ORIGINS,
      onShutdownRequest: (client) => requestShutdown({ kind: 'rpc', client }),
      httpHandler: (req, res) =>
        fileUrls.handle(req, res) || mcpRemote.handle(req, res) || (mcp?.handle(req, res) ?? false),
      onError: (error) => logger.error('rpc error', { error }),
    });
    rpc = server;
    const url = await server.listen();
    mcp?.setPort(server.port);
    fileUrls.setPort(server.port);
    // 代理有了端口，已登录的 OAuth 连接器才交给引擎；还没判断过要不要 OAuth 的远程服务在后台探测一遍。
    mcpOAuth.setPort(server.port);
    mcpRemote.setPort(server.port);
    plugins.changed();
    void adapter.reloadPlugins?.().catch(() => {});
    void mcpOAuth
      .detectAll()
      .catch((error: unknown) => logger.warn('MCP OAuth detection failed', { error }));
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
          mcpRemote,
          mcpOAuth,
          processes,
          previews,
          speech,
          terminals,
          verification,
          readiness: readinessService,
          lsp,
          lspStatus,
          sessions: manager,
          adapter,
          accounts,
          automations: automationService,
          checkpoints,
          events: store,
          search,
          sessionList: listFeed,
          inbox: inboxService,
          notifications: notificationService,
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
    await verificationService?.dispose().catch(() => {});
    await readiness?.dispose().catch(() => {});
    devPreviews?.dispose();
    dictation?.dispose();
    await backgroundProcesses?.close().catch(() => {});
    await userTerminals?.dispose().catch(() => {});
    accounts?.dispose();
    automations?.dispose();
    await turnCheckpoints?.dispose();
    await sessions?.dispose().catch(() => {});
    await adapter.dispose().catch(() => {});
    await options.web?.close().catch(() => {});
    try {
      sessionSearch?.close();
      sessionList?.close();
      notifications?.close();
      inbox?.close();
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
  /** 远程 MCP 服务的代理与 OAuth 登录（0.97.0）。 */
  mcpRemote: McpRemoteProxy;
  mcpOAuth: McpOAuthService;
  /** 后台进程（processes.ts）；没有应用级工具时没有。 */
  processes: ProcessManager | undefined;
  /** 开发服务器预览（0.84.0）：停下判定就绪的循环；进程随后台进程结束。 */
  previews: PreviewService | undefined;
  /** 听写（0.92.0）：取消进行中的模型下载，放掉识别器。 */
  speech: SpeechService;
  /** 用户的交互终端（0.69.0）；node-pty 加载不了时没有。 */
  terminals: TerminalService | undefined;
  /** 回合后验证（0.65.0）；修复模板读不到时没有。 */
  verification: VerificationService | undefined;
  /** 项目环境就绪（0.70.0）：还在跑的安装要停掉。 */
  readiness: ReadinessService | undefined;
  /** 代码智能的语言服务器；引擎挂不上应用级工具时没有。 */
  lsp: LspManager | undefined;
  /** 语言服务器的安装（0.71.0）：结束还在跑的安装命令。 */
  lspStatus: LspStatusService | undefined;
  sessions: SessionManager;
  adapter: AgentRuntimeAdapter;
  accounts: HostAccounts | undefined;
  /** 自动化（0.66.0）：先停计时，回合取消后等运行记录写完。 */
  automations: AutomationService;
  checkpoints: TurnCheckpoints;
  events: EventStore;
  search: SessionSearch;
  sessionList: SessionListFeed;
  inbox: InboxService;
  notifications: NotificationService;
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
  parts.mcpRemote.close();
  parts.mcpOAuth.close();
  // 回合后验证：不再接新的回合事件，还在跑的检查 SIGTERM（宽限后 SIGKILL）；下次启动时对账为 `cancelled`。
  if (parts.verification !== undefined) {
    await step('stop_verification', () => parts.verification?.dispose(), true);
  }
  // 用户发起的安装：SIGTERM，宽限后 SIGKILL，记成取消（`host_restarted`）。
  if (parts.readiness !== undefined) {
    await step('stop_installs', () => parts.readiness?.dispose(), true);
  }
  // 后台进程：SIGTERM，宽限期后 SIGKILL，不再通知。
  parts.previews?.dispose();
  parts.speech.dispose();
  if (parts.processes !== undefined) {
    await step('stop_processes', () => parts.processes?.close(), true);
  }
  // 用户终端：SIGHUP，宽限后 SIGKILL。
  if (parts.terminals !== undefined) {
    await step('stop_terminals', () => parts.terminals?.dispose(), true);
  }
  // 自动化不再开始新的运行；进行中的随回合取消记为 cancelled。
  parts.automations.stop();
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
  // 自动化的运行记录（随回合取消记下的 cancelled）写完再关，不超过预算。
  await beforeDeadline(parts.automations.flush(), deadline);
  parts.automations.dispose();
  // 回合结束后的快照不再等：没打完的回合，diff 对着工作树（live）。进行中的 git 停下后等它退出（不超过预算）。
  await beforeDeadline(parts.checkpoints.dispose(), deadline);
  // 超时的话引擎进程留给适配器自己回收（ACP 引擎读到 stdin EOF 即退出）。
  await step('dispose_adapter', () => parts.adapter.dispose(), true);
  // 语言服务器：先 shutdown / exit，不退出的结束进程。
  parts.lspStatus?.close();
  if (parts.lsp !== undefined) await step('close_lsp', () => parts.lsp?.close(), true);
  // 引擎（和它挂着的桥脚本）停了之后再关联网服务的端点。
  if (parts.web !== undefined) await step('close_web', () => parts.web?.close(), true);
  await step('flush_storage', () => {
    parts.search.close();
    parts.sessionList.close();
    parts.notifications.close();
    parts.inbox.close();
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

/** SessionManager 的 `customInstructions`（0.78.0）：按当时的 Host 设置算；写作风格（0.95.0）开着时读档案。 */
function customInstructionsOf(
  prompts: CustomPrompts,
  settings: HostSettingsStore,
  writingStyle: WritingStyleStore,
): NonNullable<SessionManagerOptions['customInstructions']> {
  return {
    plan: async ({ styled }) => {
      const current = settings.get();
      const profile = current.writingStyle === true ? await writingStyle.get() : undefined;
      const writing = writingStyleInput(current, profile?.content);
      return planCustom(prompts, {
        ...customInputs(current, styled),
        ...(writing !== undefined && { writingStyle: writing }),
      });
    },
    reminder: (outputStyle) => styleReminder(prompts, outputStyle),
  };
}
