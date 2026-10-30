// 推送（0.112.0，Host 功能 `remote_push`，ADR-0017 §6 与补记 6，domain-model §3.52，host-api.md §1.3）：电脑前没人时，Host 把通知意图加密后
// 经 Wevir 官方的推送网关（apps/push）发到开了推送的手机。这里有三部分：设备经隧道调的 `push.*` 方法与 `push.changed`、Host 设置与
// 设备记录里的推送状态，以及 Host 与网关、手机与网关之间的线缆（网关只见推送令牌、平台与密文）。加密本身在 `@wevir/noise` 的
// push.ts。devices.ts 引用这里的类型，所以这里只引用 common.ts 与 notifications.ts。

import { z } from 'zod';
import {
  AutomationIdSchema,
  ChannelIdSchema,
  IsoTimeSchema,
  SessionIdSchema,
  WorkspaceIdSchema,
} from './common.js';
import {
  AGENT_NOTIFICATION_BODY_MAX_LENGTH,
  NOTIFICATION_TITLE_MAX_LENGTH,
  NotificationKindSchema,
} from './notifications.js';

/** 官方推送网关的地址。域名由维护者部署时定，换了改这一个常量。 */
export const PUSH_GATEWAY_URL = 'https://push.wevir.si';

/**
 * 推送令牌的平台：APNs 正式环境、APNs 开发环境（开发版 App 拿到的令牌只在 sandbox 有效）与 FCM。
 */
export const PushPlatformSchema = z.enum(['apns', 'apns_sandbox', 'fcm']);
export type PushPlatform = z.infer<typeof PushPlatformSchema>;

/** APNs 令牌是十六进制，FCM 令牌含 `:`、`-`、`_`。不解析，只限字符与长度。 */
export const PushTokenSchema = z
  .string()
  .min(8)
  .max(4096)
  .regex(/^[A-Za-z0-9_:.-]+$/);

/** 网关推给手机的验证码：16 字节随机数的 base64url。 */
export const PUSH_VERIFY_CODE_BYTES = 16;
export const PushVerifyCodeSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

/** 两路开关的类别：需要操作（审批、提问、失败，自动化等待或失败，agent 的提醒）与完成（回合完成、自动化完成）。 */
export const PushCategorySchema = z.enum(['action', 'completion']);
export type PushCategory = z.infer<typeof PushCategorySchema>;

// ── Host 设置与设备记录 ─────────────────────────────────────────────

/**
 * Host 设置 `remote.push`：`enabled` 是总开关（关着时 Host 从不连网关，关掉时删掉全部令牌并向网关解绑）；`needsAction` 与
 * `completion`（0.112.0）是两路开关，省略按开。
 */
export const RemotePushSettingsSchema = z.object({
  enabled: z.boolean(),
  needsAction: z.boolean().optional(),
  completion: z.boolean().optional(),
});
export type RemotePushSettings = z.infer<typeof RemotePushSettingsSchema>;

/**
 * 设备记录上的推送（0.112.0，`Device.push`）：`enabled` 是这台设备的开关（配对时问一次，之后在设备页改）；`registered` 是设备报过令牌、
 * 网关已绑定。令牌本身只在 Host 里（加密存），不上线缆。
 */
export const DevicePushSchema = z.object({
  enabled: z.boolean(),
  registered: z.boolean(),
});
export type DevicePush = z.infer<typeof DevicePushSchema>;

/**
 * Host 到网关的状态（0.112.0，`RemoteStatus.push`，远程与推送都开着时有）：`idle` 是还没发过请求，`ok` 是上一次请求成功，
 * `unavailable` 是上一次网关连不上或出错（`error`）。网关出问题只记在这里，不影响别的功能。
 */
export const RemotePushStatusSchema = z.object({
  state: z.enum(['idle', 'ok', 'unavailable']),
  gatewayUrl: z.url({ protocol: /^https?$/ }),
  /** 有推送令牌、开着推送的设备数。 */
  devices: z.int().min(0),
  lastSentAt: IsoTimeSchema.optional(),
  error: z
    .object({
      reason: z.enum(['unreachable', 'rejected', 'rate_limited']),
      message: z.string().max(500),
    })
    .optional(),
});
export type RemotePushStatus = z.infer<typeof RemotePushStatusSchema>;

// ── 设备经隧道调的方法 ─────────────────────────────────────────────

/**
 * 设备看到的自己的推送（`push.get` / `push.register` / `push.unregister` 的结果与 `push.changed`）。`enabled` 是总开关与这台设备的开关
 * 都开着；开着而 `registered` 为假时，设备应向 `gatewayUrl` 要验证码再 `push.register`。`routeId` 是验证请求里要带的 Host 路由 ID。
 */
export const PushStateSchema = z.object({
  enabled: z.boolean(),
  registered: z.boolean(),
  gatewayUrl: z.url({ protocol: /^https?$/ }),
  routeId: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type PushState = z.infer<typeof PushStateSchema>;

export const PushGetParamsSchema = z.object({});
export const PushRegisterParamsSchema = z.object({
  platform: PushPlatformSchema,
  token: PushTokenSchema,
  /** 网关经这个令牌推来的验证码：证明设备收得到这个令牌的推送。 */
  code: PushVerifyCodeSchema,
});
export const PushUnregisterParamsSchema = z.object({});
export const PushStateResultSchema = PushStateSchema;
export const PushChangedParamsSchema = PushStateSchema;

// ── 加密载荷里的内容 ───────────────────────────────────────────────

/** 载荷明文的版本。 */
export const PUSH_MESSAGE_VERSION = 1;

/**
 * 手机解密后看到的一条提醒（UTF-8 JSON）：只放显示与跳转要的最少字段，只有 agent 的提醒带正文。`host` 是电脑的名称，`id` 同通知意图的 ID
 * （手机据此去重）。旧版手机认不出 `agent` 种类，显示通用的“需要处理”。
 */
export const PushMessageSchema = z.looseObject({
  v: z.literal(PUSH_MESSAGE_VERSION),
  id: z.string().max(160),
  kind: NotificationKindSchema,
  category: PushCategorySchema,
  title: z.string().max(NOTIFICATION_TITLE_MAX_LENGTH),
  host: z.string().max(64),
  sessionId: SessionIdSchema.optional(),
  workspaceId: WorkspaceIdSchema.optional(),
  automationId: AutomationIdSchema.optional(),
  /** 0.121.0：助理的提醒点开去助理页。 */
  channelId: ChannelIdSchema.optional(),
  /** 0.142.0：只在 `agent`，agent 写的正文（打码），手机显示它而不是种类文案。 */
  body: z.string().max(AGENT_NOTIFICATION_BODY_MAX_LENGTH).optional(),
  createdAt: IsoTimeSchema,
});
export type PushMessage = z.infer<typeof PushMessageSchema>;

// ── 推送网关的线缆 ─────────────────────────────────────────────────

/**
 * 网关的路径（HTTPS POST，JSON）：
 * - `verify`：手机调，不签名。网关经这个令牌给手机推一个验证码（静默推送 / 数据消息），手机把它经隧道交给 Host。
 * - `bind`：Host 调，签名。带上手机交来的验证码，网关绑定 `(路由 ID, 平台, 令牌)`，之后才替这台 Host 往这个令牌推送。
 * - `unbind`：Host 调，签名。移除设备、关推送、换令牌时解绑。
 * - `send`：Host 调，签名。只对绑定过的 `(路由 ID, 平台, 令牌)` 转发。
 * - `health`：GET，健康检查。
 */
export const PUSH_GATEWAY_PATHS = {
  verify: '/v1/verify',
  bind: '/v1/bind',
  unbind: '/v1/unbind',
  send: '/v1/send',
  health: '/healthz',
} as const;

/** Host 签名的请求头：Ed25519 签名的 base64url。 */
export const PUSH_SIGNATURE_HEADER = 'wevir-push-signature';
/** 请求体的上限（字节）。 */
export const PUSH_REQUEST_MAX_BYTES = 8192;
/** 加密载荷（base64url）的上限：APNs 与 FCM 的载荷都限 4 KiB。 */
export const PUSH_PAYLOAD_MAX_LENGTH = 3000;
/** 签名请求的 `timestamp` 与网关时钟最多差多少。 */
export const PUSH_CLOCK_SKEW_MS = 5 * 60_000;
/** 验证码的有效期。 */
export const PUSH_VERIFY_TTL_MS = 10 * 60_000;
/** `send` 的 `expiresAt` 最多在多久之后。 */
export const PUSH_MAX_TTL_MS = 24 * 60 * 60_000;
/** 签名请求的随机数：16 字节的 base64url。 */
export const PushNonceSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

const RouteIdSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const PushVerifyRequestSchema = z.object({
  routeId: RouteIdSchema,
  platform: PushPlatformSchema,
  token: PushTokenSchema,
});
export type PushVerifyRequest = z.infer<typeof PushVerifyRequestSchema>;

/** 签名请求共有的字段：路由 ID（Ed25519 公钥，验签用）、毫秒时间戳与随机数（防重放）。 */
const SignedFields = {
  routeId: RouteIdSchema,
  timestamp: z.int().min(0),
  nonce: PushNonceSchema,
};

export const PushBindRequestSchema = z.object({
  ...SignedFields,
  platform: PushPlatformSchema,
  token: PushTokenSchema,
  code: PushVerifyCodeSchema,
});
export type PushBindRequest = z.infer<typeof PushBindRequestSchema>;

export const PushUnbindRequestSchema = z.object({
  ...SignedFields,
  platform: PushPlatformSchema,
  token: PushTokenSchema,
});
export type PushUnbindRequest = z.infer<typeof PushUnbindRequestSchema>;

export const PushSendRequestSchema = z.object({
  ...SignedFields,
  platform: PushPlatformSchema,
  token: PushTokenSchema,
  /** `@wevir/noise` 的 `sealPushMessage` 的结果。 */
  payload: z
    .string()
    .min(1)
    .max(PUSH_PAYLOAD_MAX_LENGTH)
    .regex(/^[A-Za-z0-9_-]+$/),
  /** 同一个键手机只留最新一条（APNs 的 `apns-collapse-id`、FCM 的 `collapse_key`）。Host 用设备的推送密钥做 HMAC，网关看不出会话。 */
  collapseKey: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/)
    .optional(),
  /** 毫秒时间戳：过了就不必送达。 */
  expiresAt: z.int().min(0),
});
export type PushSendRequest = z.infer<typeof PushSendRequestSchema>;

export const PushGatewayErrorCodeSchema = z.enum([
  /** 请求体不是 JSON、不合 schema 或太大。 */
  'bad_request',
  /** 签名不对。 */
  'bad_signature',
  /** 时间戳偏差太大或随机数用过。 */
  'stale_request',
  /** 验证码不对、过期或不是这个令牌的。 */
  'bad_code',
  /** 没绑定过这个 `(路由 ID, 平台, 令牌)`。 */
  'not_bound',
  /** APNs / FCM 说令牌已失效，网关已删掉绑定。 */
  'unregistered',
  /** 超过了网关按路由、令牌或来源的限制。 */
  'rate_limited',
  /** 网关没配这个平台的凭据。 */
  'platform_unavailable',
  /** APNs / FCM 出错或连不上。 */
  'upstream_failed',
]);
export type PushGatewayErrorCode = z.infer<typeof PushGatewayErrorCodeSchema>;

/** 网关出错时的响应体。成功是 `{}`（`verify` 是 202）。 */
export const PushGatewayErrorSchema = z.object({
  error: z.object({ code: PushGatewayErrorCodeSchema, message: z.string() }),
});
export type PushGatewayError = z.infer<typeof PushGatewayErrorSchema>;

/** Host 签名的内容：用途前缀、路径与原样的请求体字节。 */
export function pushSignatureMessage(path: string, body: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(`wevir-push/1 ${path}\n`);
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix);
  out.set(body, prefix.length);
  return out;
}

/**
 * 网关推给手机的数据（APNs 载荷的顶层自定义键，FCM 的 `data`）：`wevir` 是种类。`verify` 带验证码 `code`，`push` 带加密载荷 `p`。
 */
export const PUSH_DATA_KIND_KEY = 'wevir';
export const PUSH_DATA_CODE_KEY = 'code';
export const PUSH_DATA_PAYLOAD_KEY = 'p';
/** iOS 的通知扩展解不开时显示的本地化键（App 的 Localizable.strings 里有）。 */
export const PUSH_APNS_TITLE_LOC_KEY = 'WEVIR_PUSH_TITLE';
export const PUSH_APNS_BODY_LOC_KEY = 'WEVIR_PUSH_BODY';
