import { z } from 'zod';
import { ApprovalIdSchema, SessionIdSchema } from './common.js';
import {
  ActiveTurnSchema,
  ApprovalResolutionSchema,
  EngineErrorInfoSchema,
  ResolvedApprovalStatusSchema,
  SessionStateSchema,
} from './entities.js';
import { ProtocolVersionSchema } from './version.js';

/**
 * JSON-RPC `error.code` 表（host-api.md「错误码」）。客户端按数值判断，`message` 只给人看。
 * 前五个是 JSON-RPC 2.0 标准码；Wevir 自己的错误在规范留给实现方的 -32000…-32099 内分段：
 * -32000…-32009 连接与握手，-32010…-32019 对象不存在，-32020…-32039 状态与冲突，
 * -32040…-32059 环境与引擎。只增不减，已分配的数值不复用。
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

  WORKSPACE_NOT_FOUND: -32010,
  PROVIDER_NOT_FOUND: -32011,
  SESSION_NOT_FOUND: -32012,
  APPROVAL_NOT_FOUND: -32013,

  INVALID_STATE: -32020,
  SESSION_BUSY: -32021,
  ALREADY_DECIDED: -32022,
  CLIENT_MESSAGE_CONFLICT: -32023,
  RESOURCE_IN_USE: -32024,

  WORKSPACE_PATH_INVALID: -32040,
  ENGINE_ERROR: -32041,
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
  INVALID_STATE: z.object({
    state: SessionStateSchema,
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
  RESOURCE_IN_USE: z.object({
    /** 阻止操作的未关闭会话。 */
    sessionIds: z.array(SessionIdSchema),
  }),
  WORKSPACE_PATH_INVALID: z.object({
    path: z.string(),
    reason: z.enum(['not_absolute', 'not_found', 'not_directory', 'not_accessible']),
  }),
  ENGINE_ERROR: EngineErrorInfoSchema,
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
} as const;

export type CloseCodeName = keyof typeof CloseCode;
