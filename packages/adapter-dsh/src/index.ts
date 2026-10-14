// dsh 适配器：通用 ACP 适配器（@wevir/adapter-acp）的一份配置（DSH_ENGINE 与 DshProcess 的启动器），加上
// dsh 专属的部分：可执行入口与 DSH_HOME、白名单环境、stream-tap 旁路与 DeltaMerger、Provider overlay 与
// provider.test、resume 的错误归类、工具展示表。通用的进程、映射、事件队列与 AcpAdapter 从 @wevir/adapter-acp 取。

export { dshAdapterCapabilities } from './capabilities.js';
export { DeltaMerger } from './delta-merge.js';
export { DshAdapter, type DshAdapterOptions } from './dsh-adapter.js';
export {
  type DshExit,
  DshProcess,
  type DshProcessEventMap,
  type DshProcessOptions,
  type DshSpawnSpecInput,
  type DshStreamTapOptions,
  dshSpawnSpec,
  type StreamTapState,
} from './dsh-process.js';
export { DSH_ENGINE, DSH_ROUTE } from './engine.js';
export { buildDshEnv, type DshEnvOptions, INHERITED_ENV, STREAM_FD } from './env.js';
export {
  DSH_PROFILE,
  DSH_VERSION,
  type DshEntry,
  type DshPaths,
  dshPaths,
  dshProfileDir,
  prepareDshHome,
  resolveDshEntry,
} from './paths.js';
export {
  COMPAT_APIS,
  DEEPSEEK_OFFICIAL,
  DSH_DEEPSEEK_MODELS,
  effectiveCompat,
  GATEWAY_ONLY_COMPAT,
  isDeepSeekHost,
  isOpenAIOfficial,
  type OverlayEntry,
  providerEnv,
  providerKeyEnv,
  providerOverlayEntries,
  providerOverlayPath,
  REASONING_LEVELS,
  RESERVED_PROVIDER_IDS,
  renderProviderOverlay,
  SUPPORTED_APIS,
  validateProviderConfig,
  wevirConfigDir,
  writeProviderOverlay,
} from './provider-config.js';
export {
  DEEPSEEK_DEFAULT_BASE_URL,
  deepseekMessagesUrl,
  PROVIDER_TEST_TIMEOUT_MS,
  type ProviderTestOptions,
  testProvider,
} from './provider-test.js';
export {
  defaultStreamTapPluginDir,
  ensureStreamTapInstalled,
  isStreamTapInstalled,
  parseStreamTapLine,
  STREAM_TAP_INSTALL_TIMEOUT_MS,
  STREAM_TAP_MAX_LINE_BYTES,
  STREAM_TAP_PACKAGE,
  STREAM_TAP_READY_GRACE_MS,
  type StreamTapChunk,
  StreamTapDecoder,
  type StreamTapDecoderHandlers,
  type StreamTapEvent,
  type StreamTapFrame,
  type StreamTapInstallInput,
  type StreamTapRecord,
  type StreamTapWarning,
  streamTapEvents,
  streamTapOverlay,
} from './stream-tap.js';
export { DSH_TOOLS, parseTodoItems, TODO_TOOL, toolDisplay } from './tool-display.js';
export {
  classifyTurnError,
  INTERNAL_ERROR_CODE,
  TURN_ERROR_RULES,
  type TurnErrorRule,
} from './turn-error.js';
