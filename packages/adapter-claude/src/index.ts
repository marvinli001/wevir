// Claude Agent 适配器（ADR-0005 补记 14，docs/architecture/claude-event-mapping.md）：经 Claude Agent SDK 驱动用户自己装的
// `claude` 与他的登录，移植自 T3 Code。找可执行文件与版本（executable.ts）、账号的检测与用量（account.ts）、随包的模型
// 清单（model-manifest.ts、model-catalog.ts）、权限（permissions.ts）、工具展示（tool-display.ts）、清单与提问（todos.ts）、
// 回合结果的归类（turn-result.ts）与 AgentRuntimeAdapter 的实现（claude-adapter.ts）。

export {
  applyRateLimitEvent,
  ClaudeAccounts,
  type ClaudeAccountsOptions,
  type ClaudeInstallation,
  claudePlan,
  claudeSignedIn,
  claudeSubscriptionLabel,
  PROBE_TTL_MS,
  probeQueryOptions,
  usageRateLimits,
} from './account.js';
export { claudeAdapterCapabilities } from './capabilities.js';
export {
  CANCEL_TIMEOUT_MS,
  ClaudeAdapter,
  type ClaudeAdapterLogger,
  type ClaudeAdapterOptions,
  ENGINE_RAW_PROTOCOL,
  toolResultText,
} from './claude-adapter.js';
export { claudeEnv, NESTED_SESSION_ENV } from './env.js';
export {
  CLAUDE_BIN_ENV,
  CLAUDE_INSTALL_COMMAND,
  CLAUDE_LOGIN_COMMAND,
  claudePath,
  commonClaudeDirs,
  findClaude,
  parseClaudeVersion,
  probeClaudeVersion,
  resolveWindowsShim,
} from './executable.js';
export {
  canonicalClaudeModel,
  claudeApiModelId,
  claudeContextWindow,
  claudeEffort,
  claudeModels,
  compareVersions,
  DEFAULT_CLAUDE_MODEL,
  lowestClaudeEffort,
} from './model-catalog.js';
export {
  APPROVAL_OPTIONS,
  claudePermissionMode,
  PERMISSION_MODES,
  permissionResult,
} from './permissions.js';
export { type ClaudeSdk, claudeSdkInstalled } from './sdk.js';
export { SIDE_BOUNDARY_NOTE } from './side.js';
export { applyTaskTool, askUserAnswers, askUserQuestions, todoWriteItems } from './todos.js';
export { claudeToolDisplay, isSubagentTool, normalizeToolName } from './tool-display.js';
export { isAbortedResult, resultFailure, resultUserFacingError } from './turn-result.js';
