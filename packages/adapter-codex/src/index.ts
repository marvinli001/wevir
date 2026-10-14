// Codex 适配器（ADR-0005 决策 1.1，docs/architecture/codex-event-mapping.md）：codex-app-server 的进程与握手
// （codex-process.ts）、CODEX_HOME 与生成的配置（paths.ts、env.ts、config.ts、prompts.ts）、通知 → AgentEvent
// （mapping.ts、tool-display.ts，回合失败的归类 turn-error.ts）、恢复失败的归类（resume-error.ts）、会话标题
// （title.ts）与 AgentRuntimeAdapter 的实现（codex-adapter.ts）。所有 Provider 经 Host 进程里的模型协议网关
// （@wevir/model-gateway）。

export { codexAdapterCapabilities } from './capabilities.js';
export {
  CANCEL_TIMEOUT_MS,
  COMMAND_APPROVAL_OPTIONS,
  CodexAdapter,
  type CodexAdapterLogger,
  type CodexAdapterOptions,
  FILE_CHANGE_APPROVAL_OPTIONS,
  RESUME_RETRIES,
  RESUME_RETRY_DELAY_MS,
} from './codex-adapter.js';
export {
  type CodexExit,
  type CodexFailed,
  type CodexLauncher,
  CodexProcess,
  type CodexProcessEventMap,
  type CodexProcessOptions,
  type CodexProcessState,
  type CodexReady,
  type CodexRestarting,
  CodexRpcError,
  type CodexServerRequest,
  type CodexSpawnSpec,
  DISPOSE_TIMEOUTS,
  type DisposeTimeouts,
  INITIALIZE_TIMEOUT_MS,
  NO_REPLY,
  RESTART_POLICY,
  type RestartPolicy,
} from './codex-process.js';
export {
  catalogEntry,
  codexProviderId,
  fromCodexEffort,
  HARDENING_TABLES,
  HARDENING_TOP,
  modelProviderEntry,
  renderConfigToml,
  renderModelCatalog,
  threadConfig,
  toCodexEffort,
} from './config.js';
export { buildCodexEnv, type CodexEnvOptions, GATEWAY_TOKEN_ENV, INHERITED_ENV } from './env.js';
export {
  CodexEventMapper,
  ENGINE_RAW_PROTOCOL,
  IGNORED_NOTIFICATIONS,
  MAPPED_NOTIFICATIONS,
  PLAN_TOOL_CALL_PREFIX,
} from './mapping.js';
export {
  CODEX_BIN_ENV,
  CODEX_VERSION,
  type CodexPaths,
  checkCodexVersion,
  codexBinaryName,
  codexPaths,
  devBinDir,
  FETCH_CODEX_COMMAND,
  parseCodexVersion,
  prepareCodexHome,
  resolveCodexBinary,
} from './paths.js';
export { BasePrompt, defaultPromptsDir, renderPromptTemplate } from './prompts.js';
export {
  type ClassifiedResumeError,
  type CodexResumeFailure,
  classifyResumeError,
  RESUME_ERROR_RULES,
  type ResumeErrorRule,
} from './resume-error.js';
export { lowestEffort, TITLE_THREAD_CONFIG } from './title.js';
export {
  commandDisplay,
  fileChangeDisplay,
  TOOL_ITEM_TYPES,
  toolDisplay,
  toolName,
} from './tool-display.js';
export { type ClassifiedTurnError, classifyTurnError } from './turn-error.js';
