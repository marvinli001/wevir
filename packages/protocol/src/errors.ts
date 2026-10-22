import { z } from 'zod';
import { PermissionsSchema } from './capabilities.js';
import { ApprovalIdSchema, PendingMessageIdSchema, SessionIdSchema } from './common.js';
import {
  ActiveTurnSchema,
  ApprovalResolutionSchema,
  EngineErrorInfoSchema,
  PendingDeliverySchema,
  PendingStatusSchema,
  ResolvedApprovalStatusSchema,
  SessionReadOnlySchema,
  SessionStateSchema,
} from './entities.js';
import { GitExpectedStateSchema } from './git.js';
import { McpOAuthErrorReasonSchema } from './plugins.js';
import { SpeechFailedDataSchema } from './speech.js';
import { ProtocolVersionSchema } from './version.js';

/**
 * JSON-RPC `error.code` 表（host-api.md「错误码」）。客户端按数值判断，`message` 只给人看。
 * 前五个是 JSON-RPC 2.0 标准码；Wevir 自己的错误在规范留给实现方的 -32000…-32099 内分段：
 * -32000…-32009 连接与握手，-32010…-32019 对象不存在，-32020…-32039 状态与冲突，
 * -32040…-32059 环境与引擎，-32060…-32069 是调优（0.85.0 档案、0.86.0 护栏、0.87.0 建议），-32070 起是远程访问（0.107.0）。
 * 只增不减，已分配的数值不复用。
 */
export const ErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,

  UNAUTHORIZED: -32001,
  INCOMPATIBLE_PROTOCOL: -32002,
  HELLO_REQUIRED: -32003,
  HOST_SHUTTING_DOWN: -32004,
  /** 这条连接没有方法或参数需要的权限（0.98.0，ADR-0017 §4）；缺少的权限名在 `data.missing`。连接不关。 */
  DEVICE_FORBIDDEN: -32005,

  WORKSPACE_NOT_FOUND: -32010,
  PROVIDER_NOT_FOUND: -32011,
  SESSION_NOT_FOUND: -32012,
  APPROVAL_NOT_FOUND: -32013,
  PENDING_NOT_FOUND: -32014,
  /** 没有这组问题（0.10.0），或它不属于这个 Host 上的会话。 */
  QUESTION_NOT_FOUND: -32015,
  /** 没有这个环境（0.15.0）。 */
  ENVIRONMENT_NOT_FOUND: -32016,
  /** 没有这张图片（0.28.0）。 */
  IMAGE_NOT_FOUND: -32017,
  /** 这个范围里没有这个名字的笔记（0.57.0，`memory.*`）。 */
  MEMORY_NOT_FOUND: -32018,
  /** 没有这个自动化（0.66.0，`automation.*`）。 */
  AUTOMATION_NOT_FOUND: -32019,

  INVALID_STATE: -32020,
  SESSION_BUSY: -32021,
  ALREADY_DECIDED: -32022,
  CLIENT_MESSAGE_CONFLICT: -32023,
  RESOURCE_IN_USE: -32024,
  PENDING_NOT_EDITABLE: -32025,
  /** 接力预览的绑定过期了（0.60.0，`session.configure` 的 `handoff.binding`）：重新预览后再切换。 */
  HANDOFF_STALE: -32026,
  /** 仓库的 HEAD 或索引与读状态时不同（0.67.0，`git.stage` / `git.unstage` / `git.commit` 的 `expected`）：重新读状态再操作。 */
  GIT_STATE_CHANGED: -32027,
  /**
   * 审批到了 `expiresAt` 没人回，Host 已按拒绝结掉（0.105.0，`approval.respond`）。没声明能力位 `approval_timeout` 的连接收到的是
   * `ALREADY_DECIDED`。
   */
  APPROVAL_EXPIRED: -32028,

  WORKSPACE_PATH_INVALID: -32040,
  ENGINE_ERROR: -32041,
  /** 听写转写失败（0.92.0，`speech.finish`）：本机模型没装好、转写服务出错等，原因在 `data.reason`。 */
  SPEECH_FAILED: -32042,
  /**
   * 远程 MCP 服务的 OAuth 登录开始不了（0.97.0，`connector.login`）：服务器不用 OAuth、要填客户端 ID、授权服务器不支持 PKCE S256 等，
   * 原因在 `data.reason`（取值同 `Connector.oauth.error`）。
   */
  MCP_OAUTH_FAILED: -32043,

  /** 没有这个档案版本（0.85.0，`tuning.*`）。 */
  PROFILE_VERSION_NOT_FOUND: -32060,
  /** 没有这条护栏规则（0.86.0，`guardrail.*`）。 */
  GUARDRAIL_NOT_FOUND: -32061,
  /** 没有这条建议（0.87.0，`tuning.proposal.*`）。 */
  PROPOSAL_NOT_FOUND: -32062,
  /** 建议的目标在生成之后被改过（0.87.0，`tuning.proposal.update` / `decide`）：只能拒绝或重新生成。 */
  PROPOSAL_STALE: -32063,

  /** 没有这台设备（0.107.0，`device.*`）。 */
  DEVICE_NOT_FOUND: -32070,
  /** 没有这个配对窗口或请求，或它已经结束（0.107.0，`pairing.respond`）。 */
  PAIRING_NOT_FOUND: -32071,
} as const;

export type ErrorCodeName = keyof typeof ErrorCode;
export type ErrorCodeValue = (typeof ErrorCode)[ErrorCodeName];

export const ERROR_CODE_NAMES = Object.keys(ErrorCode) as ErrorCodeName[];

export function errorCodeName(code: number): ErrorCodeName | undefined {
  return ERROR_CODE_NAMES.find((name) => ErrorCode[name] === code);
}

/** 带结构化 `error.data` 的错误码。没列出的错误码不带 `data`。 */
export const ErrorDataSchemas = {
  METHOD_NOT_FOUND: z.object({
    hostVersion: z.string(),
    /** 给人看的提示，如“请升级 Wevir Host”。 */
    hint: z.string(),
  }),
  INVALID_PARAMS: z.object({
    issues: z.array(
      z.object({
        path: z.array(z.union([z.string(), z.int()])),
        message: z.string(),
      }),
    ),
  }),
  INCOMPATIBLE_PROTOCOL: z.object({
    hostVersion: z.string(),
    protocolVersion: ProtocolVersionSchema,
    minProtocolVersion: ProtocolVersionSchema,
  }),
  /** 缺少的权限名（开放字符串，同 `PermissionsSchema`）。 */
  DEVICE_FORBIDDEN: z.object({ missing: PermissionsSchema.min(1) }),
  INVALID_STATE: z.object({
    state: SessionStateSchema,
    /** 会话只读时有（0.3.0）：引擎会话恢复不了的原因。 */
    readOnly: SessionReadOnlySchema.optional(),
    /** 子会话（0.6.0）：它由父 agent 驱动，不接受客户端的 send、cancel、close、resume。 */
    parentSessionId: SessionIdSchema.optional(),
  }),
  SESSION_BUSY: z.object({
    state: SessionStateSchema,
    activeTurn: ActiveTurnSchema.optional(),
  }),
  ALREADY_DECIDED: z.object({
    approvalId: ApprovalIdSchema,
    status: ResolvedApprovalStatusSchema,
    resolution: ApprovalResolutionSchema,
  }),
  CLIENT_MESSAGE_CONFLICT: z.object({
    clientMessageId: z.string(),
  }),
  APPROVAL_EXPIRED: z.object({
    approvalId: ApprovalIdSchema,
    resolution: ApprovalResolutionSchema,
  }),
  RESOURCE_IN_USE: z.object({
    /** 阻止操作的未关闭会话。 */
    sessionIds: z.array(SessionIdSchema),
    /** `session.delete`（0.43.0）：有没提交的改动的 worktree。 */
    worktrees: z.array(z.object({ path: z.string().min(1), branch: z.string().min(1) })).optional(),
  }),
  /** 待发消息现在不能这样改（0.8.0）：插话已交给引擎、暂停的不能改成插话、已到终态。 */
  PENDING_NOT_EDITABLE: z.object({
    pendingId: PendingMessageIdSchema,
    status: PendingStatusSchema,
    delivery: PendingDeliverySchema,
  }),
  /**
   * 哪几项和预览时不同（开放字符串）：`events` 之后有了新事件，`notes` 笔记改了、停用或删了，`target` 目标来源，`strategy` 方式，
   * `material` 材料的其余部分，`resume_failed` 要接着用的引擎会话恢复不了（再预览就是新建、整段）。
   */
  HANDOFF_STALE: z.object({
    reasons: z.array(z.string().min(1)).min(1),
  }),
  /** 现在的 HEAD 与索引（0.67.0）。 */
  GIT_STATE_CHANGED: GitExpectedStateSchema,
  WORKSPACE_PATH_INVALID: z.object({
    path: z.string(),
    reason: z.enum(['not_absolute', 'not_found', 'not_directory', 'not_accessible']),
  }),
  ENGINE_ERROR: EngineErrorInfoSchema,
  SPEECH_FAILED: SpeechFailedDataSchema,
  MCP_OAUTH_FAILED: z.object({ reason: McpOAuthErrorReasonSchema }),
} as const satisfies Partial<Record<ErrorCodeName, z.ZodType>>;

export type ErrorData<N extends keyof typeof ErrorDataSchemas> = z.infer<
  (typeof ErrorDataSchemas)[N]
>;

/**
 * WebSocket 关闭码（host-api.md「关闭码」）。1000–1015 是 RFC 6455 标准码；4000–4999 是应用私有码。
 * 握手失败时 Host 先回 JSON-RPC 错误，再用对应关闭码关闭。
 */
export const CloseCode = {
  /** 客户端或 Host 正常关闭。 */
  NORMAL: 1000,
  /** Host 优雅退出（`host.shutdown`、SIGINT / SIGTERM、桌面归属管道 EOF）。 */
  GOING_AWAY: 1001,

  /** 连接后 15 s 内没有完成 `host.hello`。 */
  HELLO_TIMEOUT: 4001,
  /** 首个请求不是合法的 `host.hello`（方法不对、参数不合 schema、帧不是合法 JSON-RPC 请求）。 */
  HELLO_REQUIRED: 4002,
  /** 协议主版本不同，或客户端版本低于 `minProtocolVersion`。 */
  INCOMPATIBLE_PROTOCOL: 4003,
  /** 令牌错误。 */
  UNAUTHORIZED: 4004,
  /** 超过租约（45 s）没有收到任何消息。 */
  LEASE_EXPIRED: 4005,
  /** 这条连接的发送缓冲超过上限。 */
  SEND_BUFFER_OVERFLOW: 4006,

  // 远程连接（0.109.0）：Noise 握手之后，连接以这些码关闭。握手失败不发关闭帧，直接断开。
  /** 设备被移除。 */
  DEVICE_REVOKED: 4007,
  /** 远程访问被关掉，或这条连接所在的网卡不再监听。 */
  REMOTE_DISABLED: 4008,
  /** 设备的权限改了：重连后按新的权限工作。 */
  PERMISSIONS_CHANGED: 4009,
  /** 配对没有被允许：桌面拒绝、取消或窗口到期。 */
  PAIRING_DENIED: 4010,
} as const;

export type CloseCodeName = keyof typeof CloseCode;
