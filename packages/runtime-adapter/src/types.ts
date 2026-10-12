// Host 与引擎适配器之间的类型（domain-model.md 里标 `→ adapter 接口` 的部分）。只在 Host 进程内
// 传递，不上线缆；线缆类型在 @wevir/protocol。
//
// 与 protocol 同形的类型（ToolDisplay、TodoItem）在这里单独声明，不 import 协议包：适配器不需要
// zod，也不必等 protocol 构建出 dist 才能做类型检查。Host 在两者之间直接赋值，形状一旦分叉，
// Host 的类型检查会报错。

/** 建会话与恢复会话的参数。 */
export interface SessionConfig {
  /**
   * 工作区根目录的 realpath，即 ACP `session/new` 的 `cwd`。`resumeSession` 必须传创建时的同一个值
   * （dsh 按 realpath 比较，T0.3 §3.2）。
   */
  cwd: string;
  /** Provider ID，也是 dsh 的 provider 路由名。 */
  providerId: string;
  modelId: string;
  /** 引擎原值，如 dsh 的 off / low / high / max。 */
  reasoningEffort?: string;
}

/** `createSession` / `resumeSession` 的结果。 */
export interface EngineSession {
  /** 引擎会话 ID（dsh：ACP `sessionId`）。Host 只用它路由，不解析。 */
  engineSessionId: string;
  /** 引擎实际采用的模型（ACP `session/new` 结果的 `configOptions`）；引擎不报时省略，Host 用请求值。 */
  modelId?: string;
  reasoningEffort?: string;
}

/** 一次 `send` 的用户输入。 */
export interface AgentInput {
  /** 至少一段。v0 只有文本（dsh 的 promptCapabilities 不支持图片、音频）。 */
  content: Array<{ type: 'text'; text: string }>;
}

/** 引擎给的一个审批选项，全部字段原样。 */
export interface ApprovalOption {
  /** `respondToApproval` 回传它，如 dsh 的 `allow-once`。 */
  optionId: string;
  /** 如 dsh 的 "Allow once"；界面按 `kind` 本地化。 */
  label: string;
  /** ACP：allow_once / allow_always / reject_once / reject_always。以 `allow` 开头才算批准。 */
  kind: string;
}

/** 审批决定：所选选项的 ID，必须是该请求 `options` 中的一个。 */
export interface ApprovalDecision {
  optionId: string;
}

/** 一个尚未决定的审批请求。`listPendingApprovals` 返回它，`approval.requested` 事件也是这个形状。 */
export interface PendingApproval {
  engineSessionId: string;
  /** 适配器分配，在适配器实例内唯一；`respondToApproval` 用它定位请求。 */
  requestId: string;
  /** 引擎要执行的工具调用。审批详情由 Host 从同一 `toolCallId` 的 `tool.started` 取（ADR-0001 §5）。 */
  toolCallId: string;
  options: ApprovalOption[];
}

/** 工具调用的展示类型，与 @wevir/protocol 的 `ToolDisplayKind` 同形（domain-model.md §7）。 */
export type ToolDisplayKind =
  | 'shell'
  | 'read'
  | 'edit'
  | 'write'
  | 'search'
  | 'fetch'
  | 'plan'
  | 'sub_agent'
  | 'unknown';

/**
 * 与 @wevir/protocol 的 `ToolDisplay` 同形。按工具名映射展示类型依赖引擎的工具名，所以由适配器
 * 产出（domain-model.md §6.2「放在哪一侧」）。
 */
export interface ToolDisplay {
  kind: ToolDisplayKind;
  /** 一行摘要：路径、命令、查询词或 URL。 */
  summary?: string;
  /** 引擎输入里的原值，可能是相对路径。 */
  paths?: string[];
  command?: string;
  query?: string;
  url?: string;
  /** `mcp__<server>__<tool>` 的 server 部分。 */
  mcpServer?: string;
}

/** 与 @wevir/protocol 的 `TodoItem` 同形。 */
export interface TodoItem {
  content: string;
  /** 引擎原值（dsh 已见 pending / in_progress / completed），其他值原样保留。 */
  status: string;
}
