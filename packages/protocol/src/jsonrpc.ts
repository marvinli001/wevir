import { z } from 'zod';

// JSON-RPC 2.0 封装（https://www.jsonrpc.org/specification）。一帧一个对象，v0 不支持批量：
// 收到 JSON 数组时 Host 回 `INVALID_REQUEST`（`id: null`）。参数一律按名称传（对象），不用数组。

export const JSONRPC_VERSION = '2.0';

/** 请求 ID：字符串或整数。规范允许的 `null` 与小数 Wevir 不用。 */
export const JsonRpcIdSchema = z.union([z.string().min(1), z.int()]);
export type JsonRpcId = z.infer<typeof JsonRpcIdSchema>;

/** 按名称传参；方法无参数时传 `{}`，省略 `params` 等同于 `{}`。 */
export const JsonRpcParamsSchema = z.record(z.string(), z.unknown());

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal(JSONRPC_VERSION),
  id: JsonRpcIdSchema,
  method: z.string().min(1),
  params: JsonRpcParamsSchema.optional(),
});
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

/** 通知没有 `id`，不回响应。v0 只有 Host → 客户端的 `events.event`。 */
export const JsonRpcNotificationSchema = z.object({
  jsonrpc: z.literal(JSONRPC_VERSION),
  id: z.never().optional(),
  method: z.string().min(1),
  params: JsonRpcParamsSchema.optional(),
});
export type JsonRpcNotification = z.infer<typeof JsonRpcNotificationSchema>;

export const JsonRpcErrorObjectSchema = z.object({
  /** 错误码表见 `errors.ts` 与 host-api.md「错误码」。 */
  code: z.int(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type JsonRpcErrorObject = z.infer<typeof JsonRpcErrorObjectSchema>;

export const JsonRpcSuccessResponseSchema = z.object({
  jsonrpc: z.literal(JSONRPC_VERSION),
  id: JsonRpcIdSchema,
  result: z.unknown(),
});
export type JsonRpcSuccessResponse = z.infer<typeof JsonRpcSuccessResponseSchema>;

export const JsonRpcErrorResponseSchema = z.object({
  jsonrpc: z.literal(JSONRPC_VERSION),
  /** 无法确定请求 ID（解析失败、不是合法请求）时为 null。 */
  id: JsonRpcIdSchema.nullable(),
  error: JsonRpcErrorObjectSchema,
});
export type JsonRpcErrorResponse = z.infer<typeof JsonRpcErrorResponseSchema>;

export const JsonRpcResponseSchema = z.union([
  JsonRpcSuccessResponseSchema,
  JsonRpcErrorResponseSchema,
]);
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;

/** 客户端 → Host 的一帧：v0 只有请求。 */
export const ClientFrameSchema = JsonRpcRequestSchema;
/** Host → 客户端的一帧：响应或通知。 */
export const HostFrameSchema = z.union([JsonRpcResponseSchema, JsonRpcNotificationSchema]);
export type HostFrame = z.infer<typeof HostFrameSchema>;
