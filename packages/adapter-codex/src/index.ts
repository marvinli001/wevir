// Codex 适配器（ADR-0005 决策 1.1，docs/architecture/codex-event-mapping.md）：codex-app-server 的进程与握手
// （codex-process.ts）、CODEX_HOME 与生成的配置（paths.ts、env.ts、config.ts、prompts.ts）、通知 → AgentEvent
// （mapping.ts、tool-display.ts）与 AgentRuntimeAdapter 的实现（codex-adapter.ts）。所有 Provider 经 Host 进程里的
// 模型协议网关（@wevir/model-gateway）。

export { codexAdapterCapabilities } from './capabilities.js';
export {
  CANCEL_TIMEOUT_MS,
  CodexAdapter,
  type CodexAdapterLogger,
  type CodexAdapterOptions,
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
  commandDisplay,
  fileChangeDisplay,
  TOOL_ITEM_TYPES,
  toolDisplay,
  toolName,
} from './tool-display.js';
