// 远程设备与配对（0.107.0，Host 功能 `remote_devices`，domain-model §3.49）：配对过的手机与远程 CLI 的记录、它们的权限，以及桌面
// “添加手机”时的配对窗口与二维码载荷。远程监听（0.109.0，Host 功能 `remote_listener`）的端口、路径、握手负载与状态也在这里；
// 中继的线缆（0.110.0，Host 功能 `remote_relay`）在 relay.ts。
// entities.ts 的 Host 设置引用这里的 `remote`，所以这里只引用 common.ts 与 capabilities.ts。

import { z } from 'zod';
import { PERMISSIONS, type Permission, PermissionsSchema } from './capabilities.js';
import {
  DeviceIdSchema,
  IsoTimeSchema,
  PairingIdSchema,
  PairingRequestIdSchema,
} from './common.js';
import { DevicePushSchema, RemotePushSettingsSchema, RemotePushStatusSchema } from './push.js';

// ── Host 设置 `remote` ─────────────────────────────────────────────

/** 中继的地址：`wss://` 或 `ws://`。 */
export const RelayUrlSchema = z.url({ protocol: /^wss?$/ }).max(2048);

/**
 * Wevir 官方中继的地址（0.117.0）：只在用户选了“官方”（`relay.mode: 'official'`）时用。**不是**没填地址时的默认值：开着中继、
 * 没选官方也没填地址仍等同于关（0.111.0 的规矩不变）。与网页客户端是同一个 Cloudflare Worker：页面是静态文件，中继的路径
 * （`/v1/*`、`/healthz`）才进 Worker 代码。
 */
export const OFFICIAL_RELAY_URL = 'wss://web.wevir.si';

/** 中继开着时连哪一个（0.117.0）：官方中继，或 `url` 里自建的。省略按 `custom`（0.116.0 及以前的设置）。 */
export const RelayModeSchema = z.enum(['official', 'custom']);
export type RelayModeSetting = z.infer<typeof RelayModeSchema>;

/** 网页客户端的官方地址（0.117.0）：网页配对链接的默认前缀。自建网页的人在 `remote.web.url` 里改。 */
export const WEB_CLIENT_DEFAULT_URL = 'https://web.wevir.si';

/** 网页客户端的地址：`https://`，或回环地址上的 `http://`（本机开发）；不带查询与 `#`。 */
export const WebClientUrlSchema = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .refine((value) => !/[?#]/.test(value), 'address must not have a query or fragment')
  .refine(
    (value) => !value.startsWith('http:') || isLoopbackHost(authorityHost(value.slice(7))),
    'http:// is only allowed for loopback addresses',
  );

/** 网页设备闲置多少天后自动移除（0.117.0）的默认值与上限；0 是从不。 */
export const WEB_DEVICE_IDLE_DAYS_DEFAULT = 30;
export const WEB_DEVICE_IDLE_DAYS_MAX = 3650;

/** 远程监听省略 `port` 时用的端口（0.109.0）。 */
export const REMOTE_DEFAULT_PORT = 47_830;
/** 设置里能填的端口范围：不用特权端口。 */
export const REMOTE_PORT_MIN = 1024;

export const NetworkFamilySchema = z.enum(['IPv4', 'IPv6']);
export type NetworkFamily = z.infer<typeof NetworkFamilySchema>;

/** 一块网卡的一个地址族（0.109.0）：勾选按“网卡名 + 地址族”记，不记具体 IP，DHCP 换了地址照样生效。 */
export const RemoteInterfaceRefSchema = z.object({
  name: z.string().min(1).max(64),
  family: NetworkFamilySchema,
});
export type RemoteInterfaceRef = z.infer<typeof RemoteInterfaceRefSchema>;

/**
 * 远程访问（Host 设置 `remote`）。整体与每一项都默认关；省略 `remote` 等于全关。
 * - `enabled`：总开关。关掉是“暂停远程”：断开远程连接、结束配对窗口，设备记录保留。
 * - `interfaces`：直连监听哪几类网卡（局域网；Tailscale 的 `100.64.0.0/10` 与 `fd7a:115c:a1e0::/48`）。`lanInterfaces`（0.109.0）
 *   只监听这几块局域网网卡；省略时监听全部局域网网卡。Tailscale 按地址段认，没有网卡的勾选（macOS 上它的网卡名会变）。
 * - `port`（0.109.0）：直连监听的端口，省略时 `REMOTE_DEFAULT_PORT`。
 * - `relay`：不在同一网络时经中继转发同一套密文。三态（0.117.0，用 `relayMode` 读）：`enabled` 为假是关；`mode: 'official'` 是
 *   官方中继 `OFFICIAL_RELAY_URL`；否则是 `url` 里自建的中继。`enabled` 为真但既没选官方也没有 `url` 时等同于关（0.111.0；0.110.0
 *   的设置可能这样存着，读进来不报错）：Host 不连中继，配对链接与握手负载不带中继地址。地址用 `relayConfigured` 取。
 * - `web`（0.117.0）：网页客户端。`url` 是配对链接的前缀（省略时 `WEB_CLIENT_DEFAULT_URL`）；`idleDays` 是网页设备多少天没连过就
 *   自动移除（省略时 `WEB_DEVICE_IDLE_DAYS_DEFAULT`，0 是从不）。
 * - `push`：经推送网关给手机发加密的提醒；两路开关（0.112.0）与设备级的开关见 push.ts。
 */
export const RemoteSettingsSchema = z.object({
  enabled: z.boolean(),
  interfaces: z.object({
    lan: z.boolean(),
    tailscale: z.boolean(),
    lanInterfaces: z.array(RemoteInterfaceRefSchema).max(64).optional(),
  }),
  port: z.int().min(REMOTE_PORT_MIN).max(65_535).optional(),
  relay: z.object({
    enabled: z.boolean(),
    url: RelayUrlSchema.optional(),
    mode: RelayModeSchema.optional(),
  }),
  push: RemotePushSettingsSchema,
  web: z
    .object({
      url: WebClientUrlSchema.optional(),
      idleDays: z.int().min(0).max(WEB_DEVICE_IDLE_DAYS_MAX).optional(),
    })
    .optional(),
});
export type RemoteSettings = z.infer<typeof RemoteSettingsSchema>;

/** 中继的三态（0.117.0）：关、官方、自建。开着但既没选官方也没填地址的旧设置是关。远程访问的总开关不看。 */
export type RelayMode = 'off' | RelayModeSetting;

export function relayMode(settings: Pick<RemoteSettings, 'relay'>): RelayMode {
  const { relay } = settings;
  if (!relay.enabled) return 'off';
  if (relay.mode === 'official') return 'official';
  return relay.url !== undefined ? 'custom' : 'off';
}

/** 中继真正打开时的地址：官方时是 `OFFICIAL_RELAY_URL`，自建时是 `url`，关着时 undefined（0.111.0；0.117.0 加了官方）。 */
export function relayConfigured(settings: Pick<RemoteSettings, 'relay'>): string | undefined {
  switch (relayMode(settings)) {
    case 'official':
      return OFFICIAL_RELAY_URL;
    case 'custom':
      return settings.relay.url;
    default:
      return undefined;
  }
}

/** 网页客户端的地址（0.117.0）：设置里的 `web.url`，省略时官方地址。 */
export function webClientUrl(settings: Pick<RemoteSettings, 'web'>): string {
  return settings.web?.url ?? WEB_CLIENT_DEFAULT_URL;
}

/** 网页设备闲置多少天后自动移除（0.117.0）；0 是从不。 */
export function webDeviceIdleDays(settings: Pick<RemoteSettings, 'web'>): number {
  return settings.web?.idleDays ?? WEB_DEVICE_IDLE_DAYS_DEFAULT;
}

export const DEFAULT_REMOTE_SETTINGS: RemoteSettings = Object.freeze({
  enabled: false,
  interfaces: { lan: false, tailscale: false },
  relay: { enabled: false },
  push: { enabled: false },
});

// ── 设备 ───────────────────────────────────────────────────────────

/** X25519 / Ed25519 公钥：32 字节，base64url 不带填充（43 个字符）。 */
export const PublicKeySchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

export const DEVICE_NAME_MAX_LENGTH = 64;
export const DeviceNameSchema = z.string().min(1).max(DEVICE_NAME_MAX_LENGTH);

/** `web`（0.117.0）：浏览器里的网页客户端，只经中继连；旧客户端看到的是 `other`。 */
export const DEVICE_PLATFORMS = [
  'ios',
  'android',
  'macos',
  'windows',
  'linux',
  'other',
  'web',
] as const;
export const DevicePlatformSchema = z.enum(DEVICE_PLATFORMS);
export type DevicePlatform = z.infer<typeof DevicePlatformSchema>;

/** `revoked`：用户移除了它，之后它的握手一律失败，只能重新配对（得到新的记录）。 */
export const DeviceStatusSchema = z.enum(['active', 'revoked']);
export type DeviceStatus = z.infer<typeof DeviceStatusSchema>;

/** 新配对的设备默认有的权限（ADR-0017 §4）。网页设备（0.117.0）也是这一组。 */
export const DEFAULT_DEVICE_PERMISSIONS = [
  'session.read',
  'session.write',
  'workspace.read',
] as const satisfies readonly Permission[];

/** 能给设备的权限：除 `host.manage` 外的全部。设备与配对的管理只在本机。 */
export const DEVICE_ASSIGNABLE_PERMISSIONS = PERMISSIONS.filter(
  (permission) => permission !== 'host.manage',
);

/** 一台配对过的设备。推送令牌只在 Host 里（加密存），不上线缆。 */
export const DeviceSchema = z.object({
  id: DeviceIdSchema,
  name: DeviceNameSchema,
  platform: DevicePlatformSchema,
  /** 设备的 Noise 静态公钥（X25519）：设备的身份。 */
  publicKey: PublicKeySchema,
  permissions: PermissionsSchema,
  createdAt: IsoTimeSchema,
  /** 最近一次握手成功或连接还在的时刻；刚配对时等于 `createdAt`。 */
  lastSeenAt: IsoTimeSchema,
  status: DeviceStatusSchema,
  /** 推送（0.112.0）。旧 Host 没有。 */
  push: DevicePushSchema.optional(),
});
export type Device = z.infer<typeof DeviceSchema>;

// ── 配对 ───────────────────────────────────────────────────────────

/** 一个配对窗口的有效期。 */
export const PAIRING_WINDOW_MS = 5 * 60_000;
/** 配对握手的第一条消息之后，设备必须在这么久内发来第三条消息。 */
export const PAIRING_HANDSHAKE_TIMEOUT_MS = 10_000;
/** 二维码里配对秘密的字节数（≥ 128 位）。 */
export const PAIRING_SECRET_BYTES = 32;
/** 短码的字符表（Crockford Base32，不含 I L O U）与长度：约 40 位，一个窗口只能试一次。 */
export const PAIRING_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const PAIRING_CODE_LENGTH = 8;
export const PairingCodeSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{8}$/);

/** 直连的一个候选地址：IP 或 MagicDNS 名与端口。 */
export const PairingCandidateSchema = z.object({
  kind: z.enum(['lan', 'tailscale']),
  host: z.string().min(1).max(253),
  port: z.int().min(1).max(65_535),
});
export type PairingCandidate = z.infer<typeof PairingCandidateSchema>;

/** `pairing.start` 的结果：桌面显示二维码（`uri`）、短码与倒计时。 */
export const PairingOfferSchema = z.object({
  pairingId: PairingIdSchema,
  /**
   * 二维码的内容，格式见 `formatPairingUri`；网页配对（`web`，0.117.0）时是 `formatWebPairingUrl` 的 https 链接。含配对秘密，
   * 只显示、不记录。
   */
  uri: z.string(),
  shortCode: PairingCodeSchema,
  expiresAt: IsoTimeSchema,
  /** Host 的 Noise 静态公钥（X25519）。 */
  hostPublicKey: PublicKeySchema,
  /** Host 的路由 ID：Ed25519 路由公钥（base64url），中继与局域网发现用。 */
  routeId: PublicKeySchema,
  /** 远程监听还没开时是空的。 */
  candidates: z.array(PairingCandidateSchema),
  /** 中继开着时有（0.111.0 起；0.117.0 起也可以是用户选的官方中继）。 */
  relayUrl: RelayUrlSchema.optional(),
  /** 网页配对的窗口（0.117.0）：`uri` 是 https 链接，一定有 `relayUrl`；短码在这个窗口里不能用，桌面不显示它。 */
  web: z.literal(true).optional(),
});
export type PairingOffer = z.infer<typeof PairingOfferSchema>;

/** 配对窗口为什么结束。 */
export const PairingEndReasonSchema = z.enum([
  /** 用户允许了，设备已写入。 */
  'paired',
  /** 用户拒绝了。 */
  'denied',
  /** 用户关掉了窗口，或关掉了远程访问。 */
  'cancelled',
  /** 新的 `pairing.start` 取代了它。 */
  'replaced',
  /** 到了 `expiresAt`。 */
  'expired',
  /** 握手失败或超时（秘密不对、消息乱序、第三条消息没来）。窗口只给一次尝试。 */
  'failed',
]);
export type PairingEndReason = z.infer<typeof PairingEndReasonSchema>;

// ── 方法与通知 ─────────────────────────────────────────────────────

export const DeviceListParamsSchema = z.object({});
export const DeviceListResultSchema = z.object({
  /** 全部设备，含已移除的，按配对时间排列。 */
  devices: z.array(DeviceSchema),
});

export const DeviceUpdateParamsSchema = z.object({
  id: DeviceIdSchema,
  name: DeviceNameSchema.optional(),
  /** 整组替换。只能取 `DEVICE_ASSIGNABLE_PERMISSIONS` 里的。 */
  permissions: PermissionsSchema.optional(),
  /** 这台设备的推送开关（0.112.0）。关掉时删掉它的令牌并向网关解绑。 */
  push: z.object({ enabled: z.boolean() }).optional(),
});
export const DeviceResultSchema = z.object({ device: DeviceSchema });

export const DeviceRevokeParamsSchema = z.object({ id: DeviceIdSchema });

export const PairingStartParamsSchema = z.object({
  /** 给网页客户端配对（0.117.0）：结果的 `uri` 是 https 链接。中继关着时 `INVALID_PARAMS`（网页只能经中继连）。 */
  web: z.boolean().optional(),
});
export const PairingStartResultSchema = PairingOfferSchema;

export const PairingCancelParamsSchema = z.object({
  /** 只结束这个窗口；省略时结束当前的。 */
  pairingId: PairingIdSchema.optional(),
});
export const PairingCancelResultSchema = z.object({});

export const PairingRespondParamsSchema = z.object({
  requestId: PairingRequestIdSchema,
  allow: z.boolean(),
  /** 配对时问一次的推送（0.112.0）：允许时为真则打开这台设备的推送，总开关关着时一并打开。省略按关。 */
  push: z.boolean().optional(),
});
export const PairingRespondResultSchema = z.object({
  /** 允许时写入（或重新配对时更新）的设备。 */
  device: DeviceSchema.optional(),
});

/** `devices.changed`：设备增、改、移除后的全部设备。 */
export const DevicesChangedParamsSchema = DeviceListResultSchema;

/** `pairing.request`：配对握手完成，等桌面允许。 */
export const PairingRequestParamsSchema = z.object({
  pairingId: PairingIdSchema,
  requestId: PairingRequestIdSchema,
  name: DeviceNameSchema,
  platform: DevicePlatformSchema,
  requestedAt: IsoTimeSchema,
});
export type PairingRequest = z.infer<typeof PairingRequestParamsSchema>;

export const PairingEndedParamsSchema = z.object({
  pairingId: PairingIdSchema,
  reason: PairingEndReasonSchema,
  /** `paired` 时是写入的设备。 */
  deviceId: DeviceIdSchema.optional(),
});
export type PairingEnded = z.infer<typeof PairingEndedParamsSchema>;

/** Host 名称在载荷里最多多少字符。 */
export const PAIRING_HOST_NAME_MAX_LENGTH = 64;

// ── 远程监听（0.109.0）────────────────────────────────────────────

/**
 * 远程监听的 WebSocket 路径：二维码里的配对秘密配对（`Noise_XXpsk2`）、手输短码配对（同一握手，PSK 从短码派生）、已配对设备的
 * 每次连接（`Noise_IK`）。配对的两个路径只在配对窗口里接受。别的路径与普通 HTTP 请求一律 404。
 */
export const REMOTE_PATHS = {
  pair: '/v1/pair',
  pairCode: '/v1/pair-code',
  connect: '/v1/connect',
} as const;

/**
 * 原生应用的 WebSocket 升级带的 `Origin`。React Native 的 WebSocket（iOS 与 Android）总会带 `Origin`，去不掉只能换值；网页发出的
 * `Origin` 只会是 `http(s)://…` 或 `null`，冒充不了这个值。远程监听只放行不带 `Origin` 的与带这个值的升级。
 */
export const REMOTE_NATIVE_ORIGIN = 'wevir-app://native';

/** 从 WebSocket 升级到握手完成（配对时到第三条消息）的时限。 */
export const REMOTE_HANDSHAKE_TIMEOUT_MS = 10_000;

/** 局域网 mDNS 广播的服务类型（`_wevir._tcp`）；实例名是 Host 的路由 ID，TXT 只有 `v`（协议版本）、`rid`（路由 ID）与 `pk`（Host 的 Noise 静态公钥，base64url；只拿到短码的设备用它派生 PSK）。 */
export const REMOTE_MDNS_SERVICE_TYPE = 'wevir';
export const REMOTE_MDNS_TXT_VERSION = '1';

/**
 * Host 在握手里发给设备的负载（`XXpsk2` 的第二条、`IK` 的第二条消息，UTF-8 JSON）：直连的最新候选地址，设备据此更新记下的
 * 地址。只有对方认证过之后才解得开（`XXpsk2` 的这条消息已经混入了 PSK）。
 */
export const RemoteHostPayloadSchema = z.looseObject({
  protocolVersion: z.string(),
  hostName: z.string().max(PAIRING_HOST_NAME_MAX_LENGTH).optional(),
  candidates: z.array(PairingCandidateSchema),
  /** 这台电脑开着中继时的中继地址（0.110.0）：设备据此更新记下的中继，关掉中继后不再有。 */
  relayUrl: RelayUrlSchema.optional(),
});
export type RemoteHostPayload = z.infer<typeof RemoteHostPayloadSchema>;

/** 配对时设备在第三条消息里报上的自己（UTF-8 JSON）。`IK` 的第一条消息不带负载。 */
export const RemoteDevicePayloadSchema = z.looseObject({
  name: DeviceNameSchema,
  platform: DevicePlatformSchema,
});
export type RemoteDevicePayload = z.infer<typeof RemoteDevicePayloadSchema>;

/** 认出的一块网卡的一个地址族。只列局域网（私有地址段）与 Tailscale 的地址；回环、链路本地与公网地址不列、也从不监听。 */
export const RemoteInterfaceSchema = z.object({
  name: z.string(),
  family: NetworkFamilySchema,
  kind: z.enum(['lan', 'tailscale']),
  addresses: z.array(z.string()),
  /** 按设置该监听：对应的开关开着，局域网网卡还要在 `lanInterfaces` 里（或没有 `lanInterfaces`）。 */
  selected: z.boolean(),
  /** 已经在监听的地址。 */
  listening: z.array(z.string()),
});
export type RemoteInterface = z.infer<typeof RemoteInterfaceSchema>;

/** 远程监听出的问题：端口被占用，或别的绑定错误。地址暂时不在（`EADDRNOTAVAIL`）不算，下一轮重试。 */
export const RemoteListenerErrorSchema = z.object({
  reason: z.enum(['port_in_use', 'bind_failed']),
  message: z.string(),
});

/**
 * 中继的出站连接（0.110.0）。`connecting` 包括断线后退避等待的时候；上一次失败的原因在 `error`：中继连不上或注册前断开
 * （`unreachable`）、中继拒绝了注册（`rejected`，签名不对或中继满了）、同一路由 ID 在别处注册取代了这条（`replaced`，两台电脑用了
 * 同一份密钥）。0.111.0 起 `error` 另有细节，旧客户端忽略：`certificate`（`unreachable` 里 TLS 证书验不过）、`httpStatus`（升级前
 * 中继或那个地址回的 HTTP 状态码，`rejected`；404 等说明那里不是中继）、`closeCode`（中继的关闭码 `RelayCloseCode`，`rejected`）。
 */
export const RemoteRelayStatusSchema = z.object({
  state: z.enum(['connecting', 'connected']),
  url: RelayUrlSchema,
  /** 经中继、握手完成的远程连接数（也算在 `connections` 里）。 */
  connections: z.int().min(0),
  error: z
    .object({
      reason: z.enum(['unreachable', 'rejected', 'replaced']),
      message: z.string(),
      certificate: z.literal(true).optional(),
      httpStatus: z.int().min(100).max(599).optional(),
      closeCode: z.int().min(1000).max(4999).optional(),
    })
    .optional(),
});
export type RemoteRelayStatus = z.infer<typeof RemoteRelayStatusSchema>;

/** `remote.status` 的结果与 `remote.changed` 的参数。 */
export const RemoteStatusSchema = z.object({
  /** 远程访问开着且至少在一个地址上监听。 */
  listening: z.boolean(),
  port: z.int().min(1).max(65_535),
  /** 认出的网卡，监听与否都列出，给设置页确认用。 */
  interfaces: z.array(RemoteInterfaceSchema),
  /** Tailscale 的 MagicDNS 名（有 Tailscale 地址且查得到时）。 */
  magicDnsName: z.string().optional(),
  /** 正在局域网 mDNS 广播 `_wevir._tcp`。 */
  advertising: z.boolean(),
  /** 当前的远程连接数（握手完成的，直连与经中继的合计）。 */
  connections: z.int().min(0),
  error: RemoteListenerErrorSchema.optional(),
  /** 远程访问与中继都开着时有（0.110.0）。 */
  relay: RemoteRelayStatusSchema.optional(),
  /** 远程访问与推送都开着时有（0.112.0）。 */
  push: RemotePushStatusSchema.optional(),
});
export type RemoteStatus = z.infer<typeof RemoteStatusSchema>;

export const RemoteStatusParamsSchema = z.object({});
export const RemoteStatusResultSchema = RemoteStatusSchema;
export const RemoteChangedParamsSchema = RemoteStatusSchema;

// ── 二维码载荷 ─────────────────────────────────────────────────────

export const PAIRING_URI_PREFIX = 'wevir://pair?';
export const PAIRING_URI_VERSION = 1;
/** 网页配对链接（0.117.0）在网页客户端地址之后的路径；参数放在 `#` 后面，不发给托管网页的服务器。 */
export const WEB_PAIRING_PATH = '/pair';

/** 二维码里的内容（`wevir://pair?v=1&…`，或网页的 `https://…/pair#v=1&…`）。 */
export interface PairingPayload {
  hostPublicKey: string;
  routeId: string;
  /** 配对秘密，base64url（`PAIRING_SECRET_BYTES` 字节）。 */
  secret: string;
  /** 电脑的名称，手机上用来称呼这台电脑。 */
  hostName?: string;
  candidates: { host: string; port: number }[];
  relayUrl?: string;
}

/**
 * 载荷的 URI：`wevir://pair?v=1&k=<Host 公钥>&r=<路由 ID>&s=<配对秘密>[&n=<名称>][&a=<地址:端口>…][&relay=<中继>]`。
 * 密钥与秘密是 base64url；`a` 可以重复，IPv6 地址写在方括号里。参数按这个顺序写，读的一方忽略不认识的参数。
 */
export function formatPairingUri(payload: PairingPayload): string {
  return `${PAIRING_URI_PREFIX}${formatPairingParams(payload)}`;
}

/**
 * 网页配对链接（0.117.0）：`<网页客户端地址>/pair#<与 wevir://pair? 相同的参数>`。网页只能经中继连，载荷没有 `relayUrl` 时抛错。
 * `baseUrl` 省略时是官方网页 `WEB_CLIENT_DEFAULT_URL`，末尾的 `/` 去掉。
 */
export function formatWebPairingUrl(
  payload: PairingPayload,
  baseUrl: string = WEB_CLIENT_DEFAULT_URL,
): string {
  if (payload.relayUrl === undefined) throw new Error('a web pairing link needs a relay address');
  return `${baseUrl.replace(/\/+$/, '')}${WEB_PAIRING_PATH}#${formatPairingParams(payload)}`;
}

function formatPairingParams(payload: PairingPayload): string {
  const params = new URLSearchParams();
  params.append('v', String(PAIRING_URI_VERSION));
  params.append('k', payload.hostPublicKey);
  params.append('r', payload.routeId);
  params.append('s', payload.secret);
  if (payload.hostName !== undefined) {
    params.append('n', payload.hostName.slice(0, PAIRING_HOST_NAME_MAX_LENGTH));
  }
  for (const { host, port } of payload.candidates) {
    params.append('a', `${host.includes(':') ? `[${host}]` : host}:${port}`);
  }
  if (payload.relayUrl !== undefined) params.append('relay', payload.relayUrl);
  return params.toString();
}

const SECRET_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((PAIRING_SECRET_BYTES * 4) / 3)}}$`);
const CANDIDATE_PATTERN = /^(?:\[([0-9A-Fa-f:.]+)\]|([^:[\]]+)):(\d{1,5})$/;
/** 网页配对链接：scheme、主机（含端口）、路径、可有可无的查询、`#` 后的参数。不用 `URL`：React Native 的 `URL` 不全。 */
const WEB_PAIRING_PATTERN = /^(https?):\/\/([^/?#]+)(\/[^?#]*)?(?:\?[^#]*)?#(.+)$/i;

/**
 * 读二维码载荷：`wevir://pair?…`，或网页配对链接 `https://<任意网页地址>/pair#…`（0.117.0，回环地址上也可以是 `http://`）。
 * 不是这两种格式、版本不认识、缺必需的参数，或网页链接没有中继地址时返回 null。
 */
export function parsePairingUri(uri: string): PairingPayload | null {
  if (uri.startsWith(PAIRING_URI_PREFIX)) {
    return parsePairingParams(uri.slice(PAIRING_URI_PREFIX.length));
  }
  const web = WEB_PAIRING_PATTERN.exec(uri);
  if (!web) return null;
  const [, scheme, authority, path = ''] = web as unknown as [string, string, string, string?];
  if (scheme.toLowerCase() === 'http' && !isLoopbackHost(authorityHost(authority))) return null;
  if (!path.replace(/\/+$/, '').endsWith(WEB_PAIRING_PATH)) return null;
  const payload = parsePairingParams(web[4] as string);
  return payload?.relayUrl !== undefined ? payload : null;
}

function parsePairingParams(query: string): PairingPayload | null {
  const params = new URLSearchParams(query);
  if (params.get('v') !== String(PAIRING_URI_VERSION)) return null;
  const hostPublicKey = params.get('k');
  const routeId = params.get('r');
  const secret = params.get('s');
  if (!PublicKeySchema.safeParse(hostPublicKey).success) return null;
  if (!PublicKeySchema.safeParse(routeId).success) return null;
  if (secret === null || !SECRET_PATTERN.test(secret)) return null;
  const candidates: PairingPayload['candidates'] = [];
  for (const value of params.getAll('a')) {
    const match = CANDIDATE_PATTERN.exec(value);
    const port = Number(match?.[3]);
    if (!match || port < 1 || port > 65_535) return null;
    candidates.push({ host: (match[1] ?? match[2]) as string, port });
  }
  const payload: PairingPayload = {
    hostPublicKey: hostPublicKey as string,
    routeId: routeId as string,
    secret,
    candidates,
  };
  const hostName = params.get('n');
  if (hostName !== null && hostName !== '') {
    payload.hostName = hostName.slice(0, PAIRING_HOST_NAME_MAX_LENGTH);
  }
  const relayUrl = params.get('relay');
  if (relayUrl !== null) {
    if (!RelayUrlSchema.safeParse(relayUrl).success) return null;
    payload.relayUrl = relayUrl;
  }
  return payload;
}

/** URL 的“主机[:端口]”部分里的主机名（去掉用户信息与端口，IPv6 去掉方括号），小写。 */
function authorityHost(authority: string): string {
  const host = authority.slice(authority.lastIndexOf('@') + 1).replace(/[/?#].*$/, '');
  const bracketed = /^\[([^\]]+)\]/.exec(host);
  return (bracketed ? (bracketed[1] as string) : host.replace(/:\d*$/, '')).toLowerCase();
}

function isLoopbackHost(host: string): boolean {
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/**
 * 把手输的短码规范成 `PairingCodeSchema` 的形状：去掉空格与连字符、转大写，按 Crockford 的规矩把 I、L 当 1，O 当 0。
 * 结果不合法时返回 null。
 */
export function normalizePairingCode(input: string): string | null {
  const code = input.replace(/[\s-]/g, '').toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0');
  return PairingCodeSchema.safeParse(code).success ? code : null;
}

/** 短码显示成两段：`ABCD-EFGH`。 */
export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
