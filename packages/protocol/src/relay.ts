// 中继的线缆（0.110.0，Host 功能 `remote_relay`，ADR-0017 §1–§2、host-api.md「中继」）：Host 与中继之间的控制连接、设备经中继连
// Host 的路径，以及中继的关闭码。中继（apps/relay）、Host 与客户端共用。中继只转发 Noise 密文，这里没有任何帧内容的形状。

import { z } from 'zod';
import { PublicKeySchema, REMOTE_PATHS } from './devices.js';

/**
 * 中继上的路径（接在中继地址的路径之后，见 `relayEndpoint`）：
 * - `host`：Host 的控制连接。中继先发挑战，Host 用路由密钥（Ed25519）签名注册路由 ID；之后中继在这里通知有设备来连。
 * - `accept`：Host 为每一条设备连接另开的数据连接，带 `id` 参数；中继把它与那条设备连接一对一接起来。
 * - 设备用直连的三个路径（`REMOTE_PATHS`），带 `route` 参数指明 Host 的路由 ID。
 * - `health`：健康检查（HTTP GET，200 与一个 JSON 对象）。
 */
export const RELAY_PATHS = {
  host: '/v1/host',
  accept: '/v1/accept',
  health: '/healthz',
} as const;

/** 设备连接上指明路由 ID 的查询参数。 */
export const RELAY_ROUTE_PARAM = 'route';
/** 数据连接上指明是哪一条设备连接的查询参数。 */
export const RELAY_ACCEPT_PARAM = 'id';

/** 设备连上之后，Host 要在这么久内接上数据连接，否则中继以 `HOST_UNAVAILABLE` 关闭设备连接。 */
export const RELAY_ACCEPT_TIMEOUT_MS = 10_000;
/** Host 收到挑战后要在这么久内注册。 */
export const RELAY_REGISTER_TIMEOUT_MS = 10_000;
/** 控制连接上一条消息的上限（字节）。 */
export const RELAY_CONTROL_MAX_BYTES = 4096;
/** 签名挑战的随机数字节数。 */
export const RELAY_NONCE_BYTES = 32;
/** 数据连接上一条 WebSocket 消息的上限：一条 Noise 消息（65535 字节）。 */
export const RELAY_MAX_MESSAGE_BYTES = 65_535;
/** 设备连接 ID 的字节数（随机，只经认证过的控制连接告诉 Host，是数据连接的凭据）。 */
export const RELAY_CONNECTION_ID_BYTES = 16;

/**
 * 中继的关闭码（4100–4199，与 Host 的 4000–4099 分开）。Host 在数据连接上的关闭码（`DEVICE_REVOKED` 等）原样转给设备。
 */
export const RelayCloseCode = {
  /** 这个路由 ID 没有 Host 在线，或 Host 没有及时接上，或 Host 的数据连接异常断开。稍后再试。 */
  HOST_UNAVAILABLE: 4100,
  /** 注册失败：没有按时注册、签名不对或消息格式不对。 */
  REGISTRATION_FAILED: 4101,
  /** 同一路由 ID 在别处重新注册了，这条控制连接作废。 */
  ROUTE_REPLACED: 4102,
  /** 超过了中继的限制（路由数、连接数、排队的消息）。 */
  LIMIT_EXCEEDED: 4103,
  /** 数据连接上收到文本消息或超长的消息。 */
  PROTOCOL_ERROR: 4104,
  /** Host 拒绝了这条连接（没开配对窗口、限速）。 */
  HOST_REJECTED: 4105,
} as const;
export type RelayCloseCodeName = keyof typeof RelayCloseCode;

const Base64UrlBytes = (bytes: number) =>
  z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((bytes * 4) / 3)}}$`));

export const RelayConnectionIdSchema = Base64UrlBytes(RELAY_CONNECTION_ID_BYTES);

/** 设备连的是哪个路径：配对（二维码秘密）、配对（短码）还是已配对设备的重连。 */
export const RelayDevicePathSchema = z.enum([
  REMOTE_PATHS.pair,
  REMOTE_PATHS.pairCode,
  REMOTE_PATHS.connect,
]);
export type RelayDevicePath = z.infer<typeof RelayDevicePathSchema>;

/** 中继发给 Host 的控制消息（UTF-8 JSON 文本）。 */
export const RelayServerMessageSchema = z.discriminatedUnion('type', [
  /** 连上后的第一条：签名用的随机数。 */
  z.object({ type: z.literal('challenge'), nonce: Base64UrlBytes(RELAY_NONCE_BYTES) }),
  /** 注册成功。 */
  z.object({ type: z.literal('registered') }),
  /**
   * 有设备连到这个路由 ID。`source` 是中继对设备来源地址的不透明标记（同一来源同一标记，按中继进程随机加盐），Host 按它限速，
   * 看不到设备的 IP。
   */
  z.object({
    type: z.literal('incoming'),
    id: RelayConnectionIdSchema,
    path: RelayDevicePathSchema,
    source: z.string().min(1).max(64),
  }),
]);
export type RelayServerMessage = z.infer<typeof RelayServerMessageSchema>;

/** Host 发给中继的控制消息。 */
export const RelayHostMessageSchema = z.discriminatedUnion('type', [
  /** 对挑战的回答：路由 ID（Ed25519 公钥）与它对 `relayRegistrationMessage(nonce)` 的签名。 */
  z.object({
    type: z.literal('register'),
    routeId: PublicKeySchema,
    signature: Base64UrlBytes(64),
  }),
  /** 不接这条设备连接，中继以 `HOST_REJECTED` 关闭它。 */
  z.object({ type: z.literal('reject'), id: RelayConnectionIdSchema }),
]);
export type RelayHostMessage = z.infer<typeof RelayHostMessageSchema>;

/** 签名的内容：带用途前缀，签名不能挪作别用。 */
export function relayRegistrationMessage(nonce: string): Uint8Array {
  return new TextEncoder().encode(`wevir-relay/1 register\n${nonce}`);
}

/**
 * 中继地址加上路径与查询参数。中继地址可以带路径前缀（`wss://example.com/relay`），路径接在它后面；地址里已有的查询参数保留。
 */
export function relayEndpoint(
  relayUrl: string,
  path: string,
  params: Record<string, string> = {},
): string {
  const url = new URL(relayUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${path}`;
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}
