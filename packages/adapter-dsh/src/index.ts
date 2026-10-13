export {
  type AcpRawReason,
  type AcpSessionNotification,
  type AcpSessionUpdate,
  isAcpSessionNotification,
  MAPPED_ACP_UPDATES,
  mapAcpUpdate,
  type OnRawUpdate,
  RAW_BY_DESIGN_ACP_UPDATES,
  sessionConfigInfo,
} from './acp-mapping.js';
export { dshAdapterCapabilities } from './capabilities.js';
export { DeltaMerger } from './delta-merge.js';
export { CANCEL_TIMEOUT_MS, DshAdapter, type DshAdapterOptions } from './dsh-adapter.js';
export {
  DISPOSE_TIMEOUTS,
  type DisposeTimeouts,
  type DshExit,
  type DshFailed,
  DshProcess,
  type DshProcessEventMap,
  type DshProcessOptions,
  type DshProcessState,
  type DshReady,
  type DshRestarting,
  type DshSpawnSpec,
  type DshSpawnSpecInput,
  type DshStreamTapOptions,
  dshSpawnSpec,
  INITIALIZE_TIMEOUT_MS,
  RESTART_POLICY,
  type RestartPolicy,
  STDERR_TAIL_CHARS,
  STREAM_TAP_READY_GRACE_MS,
  type StreamTapState,
} from './dsh-process.js';
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
  type AdapterLogger,
  SessionEventQueue,
  type WarnOnce,
  warnOnceVia,
} from './session-events.js';
export {
  defaultStreamTapPluginDir,
  ensureStreamTapInstalled,
  isStreamTapInstalled,
  parseStreamTapLine,
  STREAM_TAP_INSTALL_TIMEOUT_MS,
  STREAM_TAP_MAX_LINE_BYTES,
  STREAM_TAP_PACKAGE,
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
  type ClassifiedTurnError,
  classifyTurnError,
  INTERNAL_ERROR_CODE,
  TURN_ERROR_RULES,
  type TurnErrorCategory,
  type TurnErrorRule,
} from './turn-error.js';
