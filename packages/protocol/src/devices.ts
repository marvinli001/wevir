// 远程设备与配对（0.107.0，Host 功能 `remote_devices`，domain-model §3.49）：配对过的手机与远程 CLI 的记录、它们的权限，以及桌面
// “添加手机”时的配对窗口与二维码载荷。远程监听（0.109.0，Host 功能 `remote_listener`）的端口、路径、握手负载与状态也在这里。
// entities.ts 的 Host 设置引用这里的 `remote`，所以这里只引用 common.ts 与 capabilities.ts。

import { z } from 'zod';
import { PERMISSIONS, type Permission, PermissionsSchema } from './capabilities.js';
import {
  DeviceIdSchema,
  IsoTimeSchema,
  PairingIdSchema,
  PairingRequestIdSchema,
} from './common.js';

// ── Host 设置 `remote` ─────────────────────────────────────────────

/** 自建中继的地址：`wss://` 或 `ws://`。 */
export const RelayUrlSchema = z.url({ protocol: /^wss?$/ }).max(2048);

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
 * - `relay`：不在同一网络时经中继转发同一套密文；`url` 省略时用官方实例。
 * - `push`：经推送网关给手机发加密的提醒。
 */
export const RemoteSettingsSchema = z.object({
  enabled: z.boolean(),
  interfaces: z.object({
    lan: z.boolean(),
    tailscale: z.boolean(),
    lanInterfaces: z.array(RemoteInterfaceRefSchema).max(64).optional(),
  }),
  port: z.int().min(REMOTE_PORT_MIN).max(65_535).optional(),
  relay: z.object({ enabled: z.boolean(), url: RelayUrlSchema.optional() }),
  push: z.object({ enabled: z.boolean() }),
});
export type RemoteSettings = z.infer<typeof RemoteSettingsSchema>;

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

export const DEVICE_PLATFORMS = ['ios', 'android', 'macos', 'windows', 'linux', 'other'] as const;
export const DevicePlatformSchema = z.enum(DEVICE_PLATFORMS);
export type DevicePlatform = z.infer<typeof DevicePlatformSchema>;

/** `revoked`：用户移除了它，之后它的握手一律失败，只能重新配对（得到新的记录）。 */
export const DeviceStatusSchema = z.enum(['active', 'revoked']);
export type DeviceStatus = z.infer<typeof DeviceStatusSchema>;

/** 新配对的设备默认有的权限（ADR-0017 §4）。 */
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
  /** 二维码的内容，格式见 `formatPairingUri`。含配对秘密，只显示、不记录。 */
  uri: z.string(),
  shortCode: PairingCodeSchema,
  expiresAt: IsoTimeSchema,
  /** Host 的 Noise 静态公钥（X25519）。 */
  hostPublicKey: PublicKeySchema,
  /** Host 的路由 ID：Ed25519 路由公钥（base64url），中继与局域网发现用。 */
  routeId: PublicKeySchema,
  /** 远程监听还没开时是空的。 */
  candidates: z.array(PairingCandidateSchema),
  /** 开了中继、填了地址时有。 */
  relayUrl: RelayUrlSchema.optional(),
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
});
export const DeviceResultSchema = z.object({ device: DeviceSchema });

export const DeviceRevokeParamsSchema = z.object({ id: DeviceIdSchema });

export const PairingStartParamsSchema = z.object({});
export const PairingStartResultSchema = PairingOfferSchema;

export const PairingCancelParamsSchema = z.object({
  /** 只结束这个窗口；省略时结束当前的。 */
  pairingId: PairingIdSchema.optional(),
});
export const PairingCancelResultSchema = z.object({});

export const PairingRespondParamsSchema = z.object({
  requestId: PairingRequestIdSchema,
  allow: z.boolean(),
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

/** 从 WebSocket 升级到握手完成（配对时到第三条消息）的时限。 */
export const REMOTE_HANDSHAKE_TIMEOUT_MS = 10_000;

/** 局域网 mDNS 广播的服务类型（`_wevir._tcp`）；实例名是 Host 的路由 ID，TXT 只有 `v`（协议版本）与 `rid`（路由 ID）。 */
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
  /** 当前的远程连接数（握手完成的）。 */
  connections: z.int().min(0),
  error: RemoteListenerErrorSchema.optional(),
});
export type RemoteStatus = z.infer<typeof RemoteStatusSchema>;

export const RemoteStatusParamsSchema = z.object({});
export const RemoteStatusResultSchema = RemoteStatusSchema;
export const RemoteChangedParamsSchema = RemoteStatusSchema;

// ── 二维码载荷 ─────────────────────────────────────────────────────

export const PAIRING_URI_PREFIX = 'wevir://pair?';
export const PAIRING_URI_VERSION = 1;

/** 二维码里的内容（`wevir://pair?v=1&…`）。 */
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
  return `${PAIRING_URI_PREFIX}${params.toString()}`;
}

const SECRET_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((PAIRING_SECRET_BYTES * 4) / 3)}}$`);
const CANDIDATE_PATTERN = /^(?:\[([0-9A-Fa-f:.]+)\]|([^:[\]]+)):(\d{1,5})$/;

/** 读二维码载荷；不是这个格式、版本不认识或缺必需的参数时返回 null。 */
export function parsePairingUri(uri: string): PairingPayload | null {
  if (!uri.startsWith(PAIRING_URI_PREFIX)) return null;
  const params = new URLSearchParams(uri.slice(PAIRING_URI_PREFIX.length));
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
