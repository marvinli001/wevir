import type {
  AssistantDeltaEvent,
  AssistantStreamEndedEvent,
  DeltaBlockRef,
  SessionLostReason,
  TodoItem,
  ToolDisplay,
  TurnFailedEvent,
} from '@wevir/runtime-adapter';
import type { AdapterCapabilities } from '@wevir/runtime-adapter/contract';
import type { AcpSessionUpdate } from './acp-mapping.js';

// 引擎描述（ADR-0005 决策 1.3）：通用 ACP 适配器对一个 ACP 引擎需要知道的全部差异。进程、连接、映射、事件队列、
// 会话与审批的记账都是通用的（docs/architecture/acp-event-mapping.md 第一部分），每个引擎只给出这里的几项。
// 描述分两层：`AcpEngine` 与进程实例无关（名字、版本、能力、错误归类、工具展示、路由、可选的增量旁路）；
// `AcpLauncher` 是一个进程的启动方式（可执行入口与参数、cwd、环境），依赖数据目录与当前的 Provider 配置，
// 由引擎的适配器在建进程时给出（acp-process.ts）。

export interface AcpEngine {
  /** 引擎名，出现在错误与告警里（“dsh 进程已退出…”），也是默认告警前缀 `[adapter-<name>]`。 */
  readonly name: string;
  /** 适配器锁定的引擎版本，记进 `EngineSession.engineVersion`（ACP 的 `agentInfo.version` 不可靠）。 */
  readonly version: string;
  /** 契约测试的能力声明里与增量旁路无关的部分；`incrementalStream` 由旁路的状态决定（`acpAdapterCapabilities`）。 */
  readonly capabilities: AcpEngineCapabilities;
  /** 工具调用的展示类型与待办。 */
  readonly tools: AcpToolPresentation;
  /** 会话的路由（Provider 与模型）怎样写进 ACP 的 config option、怎样从中读回。 */
  readonly route: AcpRouteCodec;
  /** `session/prompt` 失败（回合失败）的归类。原文保留在结果里。 */
  classifyTurnError(error: unknown): ClassifiedTurnError;
  /** `session/resume` 失败的归类。不是 ACP 错误（连接断开等）的归 `unknown`。 */
  classifyResumeError(error: unknown): ClassifiedResumeError;
  /** 可选的增量旁路：ACP 只有已提交消息的引擎，另开一个 fd 送逐字增量（dsh 的 stream-tap）。 */
  readonly incremental?: AcpIncrementalChannel;
}

export type AcpEngineCapabilities = Omit<
  AdapterCapabilities,
  'incrementalStream' | 'subagents' | 'steer'
>;

/**
 * 工具展示（domain-model.md §7）。ACP 的 `kind`、`locations` 各引擎给得不一样（dsh 的 `kind` 恒为 `other`），
 * 所以由引擎决定：`toolName` 是 `tool_call.title`，`rawInput` 是模型给的参数，`update` 是整条更新（要看
 * `kind`、`locations` 的引擎从这里取）。
 */
export interface AcpToolPresentation {
  display(toolName: string, rawInput: unknown, update: AcpSessionUpdate): ToolDisplay;
  /** 这次工具调用若是写待办（完整列表），返回条目；否则 undefined，不发 `todo.updated`。 */
  todos?(toolName: string, rawInput: unknown): TodoItem[] | undefined;
}

/**
 * 路由（ADR-0001 补记 5）：一个引擎进程承载多个 Provider，每个会话在 `session/new` / `session/resume` 之后用
 * `session/set_config_option` 选定自己的模型与推理强度。
 */
export interface AcpRouteCodec {
  /** 选模型的 config option（dsh：`model`）。 */
  readonly modelOption: string;
  /** 选推理强度的 config option（dsh：`reasoning_effort`）；没有就不设、不读。 */
  readonly reasoningEffortOption?: string;
  /** `SessionConfig` 的 Provider 与模型 → 模型选项的值。 */
  encode(providerId: string, modelId: string): string;
  /** 模型选项的值 → 模型 ID；解析不了返回 undefined（Host 用请求值）。 */
  decodeModel(value: string): string | undefined;
}

export type TurnErrorCategory = TurnFailedEvent['category'];

export interface ClassifiedTurnError {
  category: TurnErrorCategory;
  /** 引擎原文（ACP 错误的 `message`），不截断、不改写。 */
  message: string;
  code?: number;
}

export type ResumeFailure =
  /** 再试也恢复不了：适配器报 `session_lost`，Host 把会话标为只读。 */
  | { kind: 'lost'; reason: SessionLostReason }
  /** cwd 与创建时不一致：工作区目录被移走、删除或换成了别处的链接。 */
  | { kind: 'cwd_mismatch' }
  /** 会话仍挂在本进程上（适配器以为它已关闭：之前的 `session/close` 失败过）：沿用。 */
  | { kind: 'already_active' }
  | { kind: 'unknown' };

export interface ClassifiedResumeError {
  failure: ResumeFailure;
  /** 引擎原文，不截断、不改写；进 `AdapterError.message`。 */
  message: string;
  code?: number;
}

/** 旁路产出的 AgentEvent：文本与推理的增量（分开），以及一个 attempt 的增量流结束。 */
export type IncrementalEvent = AssistantDeltaEvent | AssistantStreamEndedEvent;

export interface IncrementalWarning {
  /**
   * malformed：不是合法的记录；too_long：单行太长；truncated：fd 关闭时最后一行没有换行（这三种由解码器报）；
   * install_failed：启动器没能准备好旁路，本次启动没有旁路；not_loaded：启动后旁路没有报到（`AcpProcess` 报）。
   */
  kind: 'malformed' | 'too_long' | 'truncated' | 'install_failed' | 'not_loaded';
  message: string;
  /** 出问题的行的开头，供诊断。 */
  line?: string;
}

export interface AcpIncrementalChannel {
  /** 告警里的名字（dsh：`stream-tap 插件`）。 */
  readonly name: string;
  /** 旁路的 fd。启动器在 spawn 参数里打开它（`AcpPreparedLaunch.incremental` 为 waiting 时）。 */
  readonly fd: number;
  /** initialize 完成后等旁路报到的默认时间（ms），超时按没有旁路处理。 */
  readonly readyGraceMs: number;
  /** 每个进程一个解码器：fd 上的字节 → 事件。回调同步调用。 */
  createDecoder(handlers: IncrementalDecoderHandlers): IncrementalDecoder;
  /** 每个会话一个：增量与 ACP 已提交消息的对齐，按回合重置。 */
  createMerger(): IncrementalMerger;
}

export interface IncrementalDecoderHandlers {
  onEvent: (event: IncrementalEvent) => void;
  /** 旁路报到：引擎那一侧已加载。 */
  onReady?: () => void;
  onWarning: (warning: IncrementalWarning) => void;
}

export interface IncrementalDecoder {
  push(chunk: Uint8Array): void;
  /** fd 关闭。 */
  end(): void;
}

/** 增量与已提交消息的对齐（domain-model.md §6.3）。返回 undefined 的事件不发出。 */
export interface IncrementalMerger {
  delta(event: AssistantDeltaEvent): AssistantDeltaEvent | undefined;
  ended(event: AssistantStreamEndedEvent): AssistantStreamEndedEvent | undefined;
  /** 一条已提交的块（`agent_message_chunk` / `agent_thought_chunk`）替换哪些增量块。 */
  commit(kind: AssistantDeltaEvent['kind'], messageId: string, text: string): DeltaBlockRef[];
  /** 回合结束。 */
  reset(): void;
}
