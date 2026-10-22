import { randomBytes } from 'node:crypto';
import {
  type Device,
  formatPairingUri,
  PAIRING_CODE_ALPHABET,
  PAIRING_CODE_LENGTH,
  PAIRING_HANDSHAKE_TIMEOUT_MS,
  PAIRING_SECRET_BYTES,
  PAIRING_WINDOW_MS,
  type PairingCandidate,
  type PairingEnded,
  type PairingEndReason,
  type PairingId,
  type PairingOffer,
  type PairingRequest,
  type PairingRequestId,
  type RemoteSettings,
  relayConfigured,
} from '@wevir/protocol';
import { HostError } from '../errors.js';
import { newId } from '../ids.js';
import type { DeviceIdentity, DeviceService } from './devices.js';
import { base64url, type RemoteIdentity, type RemoteKeys } from './identity.js';

/** `pairing.request` 或 `pairing.ended`。 */
export type PairingEvent =
  | { type: 'request'; request: PairingRequest }
  | { type: 'ended'; ended: PairingEnded };

/** 用哪一个秘密握手：二维码里的配对秘密，或手输的短码。 */
export type PairingSecretKind = 'secret' | 'code';

/** 一次配对握手：远程监听收到第一条消息时从 `beginAttempt` 拿到，之后一直带着它。 */
export interface PairingAttempt {
  readonly pairingId: PairingId;
  /** 派生 PSK 用的秘密：配对秘密的字节，或短码的 ASCII。 */
  readonly secret: Uint8Array;
  readonly keys: RemoteKeys;
}

interface PendingRequest {
  readonly requestId: PairingRequestId;
  readonly identity: DeviceIdentity;
  readonly settle: (device: Device | undefined) => void;
}

interface AttemptState {
  readonly attempt: PairingAttempt;
  /** 第三条消息的时限；到了请求还没来就算失败。 */
  timer: ReturnType<typeof setTimeout> | undefined;
  request: PendingRequest | undefined;
}

interface PairingWindow {
  readonly pairingId: PairingId;
  readonly secret: Uint8Array;
  readonly code: string;
  readonly keys: RemoteKeys;
  readonly timer: ReturnType<typeof setTimeout>;
  attempt: AttemptState | undefined;
}

/**
 * 配对窗口（domain-model §3.49，ADR-0017 §3，security.md 的“远程访问”）：桌面点“添加手机”时开一个，5 分钟有效，同一时间只有一个
 * （新开的取代旧的）。窗口里有一个 ≥ 128 位的配对秘密（放进二维码）与一个 8 位短码（手输），**整个窗口只给一次握手**：远程监听收到
 * 第一条配对消息就用掉它，之后的握手一律拒绝；握手失败、第三条消息 10 s 内没来、到期，窗口都结束并告诉桌面。握手完成后设备只是在
 * 等待，桌面 `pairing.respond` 允许了才写入设备。
 *
 * 握手本身在远程监听里；它经 `beginAttempt` → `requestApproval` / `failAttempt` 与这里交互。
 */
export class PairingService {
  readonly #identity: Pick<RemoteIdentity, 'ensure'>;
  readonly #devices: Pick<DeviceService, 'add'>;
  readonly #settings: () => RemoteSettings | undefined;
  readonly #hostName: string | undefined;
  readonly #candidates: () => PairingCandidate[];
  readonly #now: () => Date;
  readonly #windowMs: number;
  readonly #handshakeTimeoutMs: number;
  readonly #listeners = new Set<(event: PairingEvent) => void>();
  #window: PairingWindow | undefined;
  /** 每次 `start` / `cancel` 加一：等密钥期间被取消或取代的 `start` 据此作废。 */
  #generation = 0;

  constructor(options: {
    identity: Pick<RemoteIdentity, 'ensure'>;
    devices: Pick<DeviceService, 'add'>;
    /** Host 设置的 `remote`；省略或总开关关着时不能开窗口。 */
    settings: () => RemoteSettings | undefined;
    /** 二维码里的电脑名称。 */
    hostName?: string;
    /** 直连的候选地址；远程监听没开时是空的。 */
    candidates?: () => PairingCandidate[];
    now?: () => Date;
    windowMs?: number;
    handshakeTimeoutMs?: number;
  }) {
    this.#identity = options.identity;
    this.#devices = options.devices;
    this.#settings = options.settings;
    this.#hostName = options.hostName;
    this.#candidates = options.candidates ?? (() => []);
    this.#now = options.now ?? (() => new Date());
    this.#windowMs = options.windowMs ?? PAIRING_WINDOW_MS;
    this.#handshakeTimeoutMs = options.handshakeTimeoutMs ?? PAIRING_HANDSHAKE_TIMEOUT_MS;
  }

  /** 当前窗口的 ID。 */
  get pairingId(): PairingId | undefined {
    return this.#window?.pairingId;
  }

  /** 开一个窗口（`pairing.start`），取代已有的。远程访问关着时 `INVALID_PARAMS`。 */
  async start(): Promise<PairingOffer> {
    this.#requireEnabled();
    const generation = ++this.#generation;
    const keys = await this.#identity.ensure();
    if (generation !== this.#generation) {
      throw new HostError('PAIRING_NOT_FOUND', 'pairing was cancelled');
    }
    const settings = this.#requireEnabled();
    if (this.#window) this.#end('replaced');
    const pairingId = newId('prg');
    const secret = new Uint8Array(randomBytes(PAIRING_SECRET_BYTES));
    const code = randomCode();
    const expiresAt = new Date(this.#now().getTime() + this.#windowMs).toISOString();
    const candidates = this.#candidates();
    // 开着中继却没填地址等同于关（0.111.0）：链接里不带中继。
    const relayUrl = relayConfigured(settings);
    const timer = setTimeout(() => {
      if (this.#window?.pairingId === pairingId) this.#end('expired');
    }, this.#windowMs);
    timer.unref?.();
    this.#window = { pairingId, secret, code, keys, timer, attempt: undefined };
    return {
      pairingId,
      uri: formatPairingUri({
        hostPublicKey: keys.hostPublicKey,
        routeId: keys.routeId,
        secret: base64url(secret),
        ...(this.#hostName !== undefined && { hostName: this.#hostName }),
        candidates: candidates.map(({ host, port }) => ({ host, port })),
        ...(relayUrl !== undefined && { relayUrl }),
      }),
      shortCode: code,
      expiresAt,
      hostPublicKey: keys.hostPublicKey,
      routeId: keys.routeId,
      candidates,
      ...(relayUrl !== undefined && { relayUrl }),
    };
  }

  /** 结束窗口（`pairing.cancel`、关掉远程访问）。给了 `pairingId` 时只结束那一个；没有窗口时什么都不做。 */
  cancel(pairingId?: PairingId): void {
    if (pairingId !== undefined && this.#window?.pairingId !== pairingId) return;
    this.#generation += 1;
    if (this.#window) this.#end('cancelled');
  }

  /** 桌面对配对请求作答（`pairing.respond`）。允许时写入设备并返回它。请求不是当前窗口的 `PAIRING_NOT_FOUND`。 */
  respond(requestId: PairingRequestId, allow: boolean): Device | undefined {
    const request = this.#window?.attempt?.request;
    if (!request || request.requestId !== requestId) {
      throw new HostError('PAIRING_NOT_FOUND', `pairing request ${requestId} not found`);
    }
    if (!allow) {
      this.#end('denied');
      return undefined;
    }
    const device = this.#devices.add(request.identity);
    request.settle(device);
    this.#end('paired', device.id);
    return device;
  }

  /**
   * 远程监听收到第一条配对消息：用掉这个窗口唯一的一次握手，返回派生 PSK 用的秘密。没有窗口或已经用掉时返回 undefined（断开）。
   * 之后 `handshakeTimeoutMs` 内要 `requestApproval`，否则窗口以 `failed` 结束。
   */
  beginAttempt(kind: PairingSecretKind): PairingAttempt | undefined {
    const window = this.#window;
    if (!window || window.attempt) return undefined;
    const attempt: PairingAttempt = {
      pairingId: window.pairingId,
      secret: kind === 'secret' ? window.secret : new TextEncoder().encode(window.code),
      keys: window.keys,
    };
    const timer = setTimeout(() => {
      if (this.#window === window && window.attempt?.request === undefined) this.#end('failed');
    }, this.#handshakeTimeoutMs);
    timer.unref?.();
    window.attempt = { attempt, timer, request: undefined };
    return attempt;
  }

  /**
   * 握手完成，设备报上名称、平台与公钥：发 `pairing.request` 等桌面作答。允许时得到写入的设备；拒绝、取消、到期时得到 undefined。
   * 不是这个窗口的握手，或已经请求过时直接是 undefined。
   */
  requestApproval(attempt: PairingAttempt, identity: DeviceIdentity): Promise<Device | undefined> {
    const window = this.#window;
    const state = window?.attempt;
    if (!window || !state || state.attempt !== attempt || state.request) {
      return Promise.resolve(undefined);
    }
    clearTimeout(state.timer);
    state.timer = undefined;
    const requestId = newId('prq');
    const decided = new Promise<Device | undefined>((resolve) => {
      state.request = { requestId, identity, settle: resolve };
    });
    this.#emit({
      type: 'request',
      request: {
        pairingId: window.pairingId,
        requestId,
        name: identity.name,
        platform: identity.platform,
        requestedAt: this.#now().toISOString(),
      },
    });
    return decided;
  }

  /** 握手失败（秘密不对、消息不合法、连接断了）：窗口以 `failed` 结束。 */
  failAttempt(attempt: PairingAttempt): void {
    if (this.#window?.attempt?.attempt === attempt) this.#end('failed');
  }

  /** 窗口里有了请求或窗口结束时调用 `listener`。返回退订函数。 */
  watch(listener: (event: PairingEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Host 退出：结束窗口，不再通知。 */
  close(): void {
    this.#listeners.clear();
    this.cancel();
  }

  #requireEnabled(): RemoteSettings {
    const settings = this.#settings();
    if (settings?.enabled !== true) {
      throw new HostError('INVALID_PARAMS', 'remote access is off', {
        issues: [{ path: [], message: 'remote access is off' }],
      });
    }
    return settings;
  }

  #end(reason: PairingEndReason, deviceId?: Device['id']): void {
    const window = this.#window;
    if (!window) return;
    this.#window = undefined;
    clearTimeout(window.timer);
    clearTimeout(window.attempt?.timer);
    window.attempt?.request?.settle(undefined);
    this.#emit({
      type: 'ended',
      ended: { pairingId: window.pairingId, reason, ...(deviceId !== undefined && { deviceId }) },
    });
  }

  #emit(event: PairingEvent): void {
    for (const listener of [...this.#listeners]) listener(event);
  }
}

/** 8 位短码：每个字节取低 5 位（256 是 32 的倍数，取值均匀）。 */
function randomCode(): string {
  let code = '';
  for (const byte of randomBytes(PAIRING_CODE_LENGTH)) code += PAIRING_CODE_ALPHABET[byte & 31];
  return code;
}
