// 推送（0.112.0，Host 功能 `remote_push`，ADR-0017 §6 与补记 6，domain-model §3.52，host-api.md §1.3）：电脑前没人时，把 M0d 的通知意图
// 加密后经 Wevir 的推送网关（apps/push）发给开了推送的设备。网关只见推送令牌、平台与密文；它连不上只记在 `remote.status` 的
// `push` 里，不影响别的功能。

import { ed25519 } from '@noble/curves/ed25519.js';
import {
  derivePushKey,
  fromBase64Url,
  pushCollapseKey,
  randomBytes,
  sealPushMessage,
  toBase64Url,
} from '@wevir/noise';
import {
  type DeviceId,
  type NotificationIntent,
  PUSH_GATEWAY_PATHS,
  PUSH_MESSAGE_VERSION,
  PUSH_SIGNATURE_HEADER,
  type PushCategory,
  type PushGatewayErrorCode,
  PushGatewayErrorSchema,
  type PushMessage,
  type PushPlatform,
  type PushState,
  pushSignatureMessage,
  type RemotePushStatus,
  type RemoteSettings,
} from '@wevir/protocol';
import { HostError } from '../errors.js';
import type { DeviceService, StoredPushToken } from './devices.js';
import type { RemoteIdentity } from './identity.js';

/** 同一台设备、同一个收起键（同一会话）的推送至少隔这么久；这段时间里来的只留最新一条，到时再发。 */
export const PUSH_COALESCE_MS = 30_000;
/** 一台设备每小时最多收几条推送；超了丢掉（网关另有自己的限制）。 */
export const PUSH_MAX_PER_HOUR = 30;
/** 推送的有效期：过了 APNs / FCM 就不必再送达。 */
export const PUSH_TTL_MS = 60 * 60_000;
/** 一次网关请求的时限。 */
const GATEWAY_TIMEOUT_MS = 10_000;

const encoder = new TextEncoder();

// ── 网关客户端 ─────────────────────────────────────────────────────

/** 网关一次请求的结果：网关回了错误码，或连不上（`unreachable`，含超时与读不懂的响应）。 */
export type PushGatewayResult =
  | { ok: true }
  | { ok: false; error: PushGatewayErrorCode | 'unreachable'; message: string };

export interface PushGatewayRequest {
  platform: PushPlatform;
  token: string;
}

/** Host 到网关的三个签名请求。 */
export interface PushGatewayClient {
  readonly url: string;
  bind(request: PushGatewayRequest & { code: string }): Promise<PushGatewayResult>;
  unbind(request: PushGatewayRequest): Promise<PushGatewayResult>;
  send(
    request: PushGatewayRequest & { payload: string; collapseKey: string; expiresAt: number },
  ): Promise<PushGatewayResult>;
}

/**
 * 经 HTTPS 调网关：请求体带路由 ID、毫秒时间戳与 16 字节随机数，用路由密钥（Ed25519）签 `wevir-push/1 <路径>\n` 加请求体的原样字节，
 * 签名放在 `wevir-push-signature` 头里。
 */
export class HttpPushGateway implements PushGatewayClient {
  readonly url: string;
  readonly #identity: Pick<RemoteIdentity, 'ensure'>;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(options: {
    url: string;
    identity: Pick<RemoteIdentity, 'ensure'>;
    fetch?: typeof fetch;
    now?: () => number;
  }) {
    this.url = options.url.replace(/\/+$/, '');
    this.#identity = options.identity;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? Date.now;
  }

  bind(request: PushGatewayRequest & { code: string }): Promise<PushGatewayResult> {
    return this.#post(PUSH_GATEWAY_PATHS.bind, request);
  }

  unbind(request: PushGatewayRequest): Promise<PushGatewayResult> {
    return this.#post(PUSH_GATEWAY_PATHS.unbind, request);
  }

  send(
    request: PushGatewayRequest & { payload: string; collapseKey: string; expiresAt: number },
  ): Promise<PushGatewayResult> {
    return this.#post(PUSH_GATEWAY_PATHS.send, request);
  }

  async #post(path: string, fields: object): Promise<PushGatewayResult> {
    let response: Response;
    try {
      const keys = await this.#identity.ensure();
      const body = encoder.encode(
        JSON.stringify({
          routeId: keys.routeId,
          timestamp: Math.floor(this.#now()),
          nonce: toBase64Url(randomBytes(16)),
          ...fields,
        }),
      );
      const signature = ed25519.sign(pushSignatureMessage(path, body), keys.route.secretKey);
      response = await this.#fetch(`${this.url}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [PUSH_SIGNATURE_HEADER]: toBase64Url(signature),
        },
        body,
        signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS),
      });
    } catch (error) {
      return { ok: false, error: 'unreachable', message: errorMessage(error) };
    }
    if (response.ok) {
      await response.body?.cancel();
      return { ok: true };
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {}
    const error = PushGatewayErrorSchema.safeParse(parsed);
    if (!error.success) {
      return { ok: false, error: 'unreachable', message: `HTTP ${response.status}` };
    }
    return {
      ok: false,
      error: error.data.error.code,
      message: error.data.error.message.slice(0, 200),
    };
  }
}

function errorMessage(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } }).cause?.code;
  const message = error instanceof Error ? error.message : String(error);
  return (typeof cause === 'string' ? `${message} (${cause})` : message).slice(0, 200);
}

// ── 推送判定 ───────────────────────────────────────────────────────

/** 意图属于哪一路开关：需要操作（审批、提问、失败，自动化等待或失败），或完成（回合完成、自动化完成）。 */
export function pushCategory(intent: NotificationIntent): PushCategory {
  switch (intent.kind) {
    case 'approval':
    case 'question':
    case 'failed':
      return 'action';
    case 'completed':
      return 'completion';
    case 'automation':
      return intent.automationStatus === 'completed' ? 'completion' : 'action';
    // 助理在时间线上说话（0.121.0）：同回合完成；预算用完、回合失败的说明也归这一路。
    case 'channel':
      return 'completion';
    // agent 的提醒（0.142.0）：要用户处理或想知道的事。
    case 'agent':
      return 'action';
  }
}

/**
 * 一条意图会推到几台设备（`recipients`，`wevir_notify` 据此告诉模型）；一台都没有时的原因：推送或这一路关着（`off`）、没有开了推送
 * 并报过令牌的设备（`no_device`）、电脑前有人（`at_computer`）、设备都到了每小时的上限（`rate_limited`）。
 */
export interface PushRecipients {
  devices: number;
  skipped?: 'off' | 'no_device' | 'at_computer' | 'rate_limited';
}

export interface PushServiceOptions {
  /** Host 设置的 `remote`。 */
  settings: () => RemoteSettings | undefined;
  devices: DeviceService;
  identity: Pick<RemoteIdentity, 'ensure'>;
  notifications: { watch(listener: (intent: NotificationIntent) => void): () => void };
  /** 有没有人在电脑前（M0d 的在场）。 */
  presence: { atComputer(): boolean };
  gateway: PushGatewayClient;
  /** 电脑的名称，放进载荷给手机称呼这台电脑。 */
  hostName: string;
  now?: () => number;
  coalesceMs?: number;
  maxPerHour?: number;
  ttlMs?: number;
  onError?: (error: unknown) => void;
}

/** 上一次网关请求的结果（`RemotePushStatus` 去掉地址与设备数）。 */
type GatewayState = Pick<RemotePushStatus, 'state' | 'lastSentAt' | 'error'>;

interface Slot {
  lastSentAt: number;
  pending: NotificationIntent | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * 推送服务。
 *
 * - **发不发**：远程访问与推送的总开关都开着，这一路开关（`needsAction` / `completion`）开着，电脑前没人（在场），设备是 active、
 *   开了推送、报过令牌、有 `session.read`。发送时再看一次在场。
 * - **合并与限频**：同一台设备、同一个收起键的推送至少隔 `coalesceMs`，期间来的只留最新一条，到时再发；每台设备每小时最多
 *   `maxPerHour` 条。意图本身已按 ID 去重（NotificationService）。
 * - **令牌**：`push.register` 带着网关推给设备的验证码向网关绑定，成功才存（加密在 secrets.json）；换了令牌时解绑旧的。关掉设备的
 *   推送、关掉总开关、设备报撤销、移除设备时删掉令牌并向网关解绑（失败不重试，网关那边的绑定长期不用会被清理）。网关说令牌失效
 *   （`unregistered` / `not_bound`）时删掉，设备下次连上时会重新报。
 * - **状态**：上一次网关请求的结果在 `status()`（`remote.status` 的 `push`）；设备看到的自己的状态变了时通知 `onDeviceChange` 的监听者
 *   （`push.changed`）。
 */
export class PushService {
  readonly #options: PushServiceOptions;
  readonly #now: () => number;
  readonly #coalesceMs: number;
  readonly #maxPerHour: number;
  readonly #ttlMs: number;
  readonly #onError: (error: unknown) => void;
  readonly #slots = new Map<string, Slot>();
  readonly #sent = new Map<DeviceId, number[]>();
  readonly #unsubscribe: (() => void)[] = [];
  readonly #deviceListeners = new Set<(deviceId: DeviceId) => void>();
  readonly #statusListeners = new Set<() => void>();
  /** 每台设备上一次通知时的 `enabled registered`。 */
  readonly #lastStates = new Map<DeviceId, string>();
  #status: GatewayState = { state: 'idle' };
  #globalEnabled: boolean;
  #closed = false;

  constructor(options: PushServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#coalesceMs = options.coalesceMs ?? PUSH_COALESCE_MS;
    this.#maxPerHour = options.maxPerHour ?? PUSH_MAX_PER_HOUR;
    this.#ttlMs = options.ttlMs ?? PUSH_TTL_MS;
    this.#onError = options.onError ?? (() => {});
    this.#globalEnabled = options.settings()?.push.enabled === true;
    this.#unsubscribe.push(
      options.notifications.watch((intent) => this.#onIntent(intent)),
      options.devices.watch(() => this.#devicesChanged()),
      options.devices.onRevoked((_deviceId, removed) => {
        if (removed.pushToken !== undefined) void this.#unbind(removed.pushToken);
      }),
    );
    for (const device of options.devices.list())
      this.#lastStates.set(device.id, this.#key(device.id));
  }

  get gatewayUrl(): string {
    return this.#options.gateway.url;
  }

  /** 设置变了时调用：总开关关掉时删掉全部令牌并解绑；通知状态与设备的变化。 */
  refresh(): void {
    if (this.#closed) return;
    const enabled = this.#options.settings()?.push.enabled === true;
    if (this.#globalEnabled && !enabled) {
      for (const device of this.#options.devices.list()) {
        if (device.push?.registered === true) void this.#forget(device.id);
      }
      this.#clearSlots();
    }
    if (enabled !== this.#globalEnabled) this.#status = { state: 'idle' };
    this.#globalEnabled = enabled;
    this.#devicesChanged();
    this.#statusChanged();
  }

  /** 设备看到的自己的推送（`push.get` 等的结果）。 */
  async stateFor(deviceId: DeviceId): Promise<PushState> {
    const keys = await this.#options.identity.ensure();
    const device = this.#options.devices.get(deviceId);
    return {
      enabled: this.#enabledFor(deviceId),
      registered: device?.status === 'active' && device.push?.registered === true,
      gatewayUrl: this.#options.gateway.url,
      routeId: keys.routeId,
    };
  }

  /**
   * 设备报令牌（`push.register`）。推送关着时什么都不做（设备看结果的 `enabled`，等 `push.changed` 再报）；开着时带着验证码向网关绑定，
   * 成功才存下，换了令牌时解绑旧的。网关拒绝或连不上时 `PUSH_GATEWAY_ERROR`。
   */
  async register(
    deviceId: DeviceId,
    params: { platform: PushPlatform; token: string; code: string },
  ): Promise<PushState> {
    if (!this.#enabledFor(deviceId)) return this.stateFor(deviceId);
    const result = await this.#options.gateway.bind(params);
    this.#record(result);
    if (!result.ok) {
      throw new HostError('PUSH_GATEWAY_ERROR', `push gateway: ${result.message}`, {
        reason:
          result.error === 'bad_code' || result.error === 'rate_limited'
            ? result.error
            : result.error === 'unreachable' || result.error === 'upstream_failed'
              ? 'unreachable'
              : 'rejected',
      });
    }
    const previous = await this.#options.devices.pushToken(deviceId);
    await this.#options.devices.setPushToken(deviceId, {
      platform: params.platform,
      token: params.token,
    });
    if (
      previous !== undefined &&
      (previous.token !== params.token || previous.platform !== params.platform)
    ) {
      void this.#unbind(previous);
    }
    return this.stateFor(deviceId);
  }

  /** 设备撤回令牌（`push.unregister`，例如手机上关了通知）：删掉并解绑。 */
  async unregister(deviceId: DeviceId): Promise<PushState> {
    await this.#forget(deviceId);
    return this.stateFor(deviceId);
  }

  /** 桌面改这台设备的推送开关（`device.update` 与 `pairing.respond` 的 `push`）。关掉时删掉令牌并解绑。 */
  async setDeviceEnabled(deviceId: DeviceId, enabled: boolean): Promise<void> {
    this.#options.devices.setPushEnabled(deviceId, enabled);
    if (!enabled) {
      this.#dropSlots(deviceId);
      await this.#forget(deviceId);
    }
  }

  /** 远程与推送都开着时的状态（`remote.status` 的 `push`）。 */
  status(): RemotePushStatus | undefined {
    const settings = this.#options.settings();
    if (settings?.enabled !== true || settings.push.enabled !== true) return undefined;
    const devices = this.#options.devices
      .list()
      .filter(
        (device) =>
          device.status === 'active' &&
          device.push?.enabled === true &&
          device.push.registered === true,
      ).length;
    return { ...this.#status, gatewayUrl: this.#options.gateway.url, devices };
  }

  /** `status()` 可能变了时调用 `listener`。返回退订函数。 */
  watchStatus(listener: () => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  /** 某台设备看到的推送状态变了时调用 `listener`（`push.changed`）。返回退订函数。 */
  onDeviceChange(listener: (deviceId: DeviceId) => void): () => void {
    this.#deviceListeners.add(listener);
    return () => this.#deviceListeners.delete(listener);
  }

  close(): void {
    this.#closed = true;
    for (const unsubscribe of this.#unsubscribe.splice(0)) unsubscribe();
    this.#clearSlots();
    this.#deviceListeners.clear();
    this.#statusListeners.clear();
  }

  // ── 内部 ──────────────────────────────────────────────────────────

  #enabledFor(deviceId: DeviceId): boolean {
    const settings = this.#options.settings();
    const device = this.#options.devices.get(deviceId);
    return (
      settings?.push.enabled === true &&
      device?.status === 'active' &&
      device.push?.enabled === true
    );
  }

  #key(deviceId: DeviceId): string {
    const device = this.#options.devices.get(deviceId);
    return `${this.#enabledFor(deviceId)} ${device?.push?.registered === true}`;
  }

  #devicesChanged(): void {
    for (const device of this.#options.devices.list()) {
      const key = this.#key(device.id);
      if (this.#lastStates.get(device.id) === key) continue;
      this.#lastStates.set(device.id, key);
      for (const listener of [...this.#deviceListeners]) listener(device.id);
    }
    this.#statusChanged();
  }

  #statusChanged(): void {
    for (const listener of [...this.#statusListeners]) listener();
  }

  /** 这条意图现在会推到几台设备（不发）：同 `#onIntent` 的判定，另把到了每小时上限的设备算作不发。 */
  recipients(intent: NotificationIntent): PushRecipients {
    const targets = this.#targets(intent);
    if (!Array.isArray(targets)) return { devices: 0, skipped: targets };
    const now = this.#now();
    const open = targets.filter(
      (deviceId) =>
        (this.#sent.get(deviceId) ?? []).filter((at) => now - at < 60 * 60_000).length <
        this.#maxPerHour,
    );
    return open.length === 0 && targets.length > 0
      ? { devices: 0, skipped: 'rate_limited' }
      : { devices: open.length };
  }

  /** 要推给哪些设备；不推时是原因。 */
  #targets(intent: NotificationIntent): DeviceId[] | NonNullable<PushRecipients['skipped']> {
    if (this.#closed) return 'off';
    const settings = this.#options.settings();
    if (settings?.enabled !== true || settings.push.enabled !== true) return 'off';
    const category = pushCategory(intent);
    if (category === 'action' && settings.push.needsAction === false) return 'off';
    if (category === 'completion' && settings.push.completion === false) return 'off';
    const devices = this.#options.devices
      .list()
      .filter(
        (device) =>
          device.status === 'active' &&
          device.push?.enabled === true &&
          device.push.registered === true &&
          device.permissions.includes('session.read'),
      );
    if (devices.length === 0) return 'no_device';
    if (this.#options.presence.atComputer()) return 'at_computer';
    return devices.map((device) => device.id);
  }

  #onIntent(intent: NotificationIntent): void {
    const targets = this.#targets(intent);
    if (!Array.isArray(targets)) return;
    for (const deviceId of targets) this.#enqueue(deviceId, intent);
  }

  #enqueue(deviceId: DeviceId, intent: NotificationIntent): void {
    const now = this.#now();
    for (const [key, slot] of this.#slots) {
      if (slot.timer === undefined && now - slot.lastSentAt >= this.#coalesceMs) {
        this.#slots.delete(key);
      }
    }
    const key = `${deviceId}\n${intent.collapseKey}`;
    let slot = this.#slots.get(key);
    if (slot === undefined) {
      slot = { lastSentAt: Number.NEGATIVE_INFINITY, pending: undefined, timer: undefined };
      this.#slots.set(key, slot);
    }
    const wait = slot.lastSentAt + this.#coalesceMs - now;
    if (wait <= 0 && slot.timer === undefined) {
      slot.lastSentAt = now;
      this.#dispatch(deviceId, intent);
      return;
    }
    slot.pending = intent;
    if (slot.timer !== undefined) return;
    const pending = slot;
    pending.timer = setTimeout(() => {
      pending.timer = undefined;
      const latest = pending.pending;
      pending.pending = undefined;
      if (latest === undefined || this.#closed) return;
      if (this.#options.presence.atComputer() || !this.#enabledFor(deviceId)) return;
      pending.lastSentAt = this.#now();
      this.#dispatch(deviceId, latest);
    }, wait);
    pending.timer.unref?.();
  }

  #dispatch(deviceId: DeviceId, intent: NotificationIntent): void {
    const now = this.#now();
    const sent = (this.#sent.get(deviceId) ?? []).filter((at) => now - at < 60 * 60_000);
    if (sent.length >= this.#maxPerHour) {
      this.#sent.set(deviceId, sent);
      return;
    }
    sent.push(now);
    this.#sent.set(deviceId, sent);
    this.#send(deviceId, intent).catch((error: unknown) => this.#onError(error));
  }

  async #send(deviceId: DeviceId, intent: NotificationIntent): Promise<void> {
    const devices = this.#options.devices;
    const device = devices.get(deviceId);
    const token = await devices.pushToken(deviceId);
    if (device === undefined || token === undefined) return;
    const keys = await this.#options.identity.ensure();
    const devicePublicKey = fromBase64Url(device.publicKey);
    const key = derivePushKey({
      secretKey: keys.noise.secretKey,
      publicKey: devicePublicKey,
      hostPublicKey: keys.noise.publicKey,
      devicePublicKey,
    });
    const message: PushMessage = {
      v: PUSH_MESSAGE_VERSION,
      id: intent.id,
      kind: intent.kind,
      category: pushCategory(intent),
      title: intent.title,
      host: this.#options.hostName.slice(0, 64),
      ...(intent.sessionId !== undefined && { sessionId: intent.sessionId }),
      ...(intent.workspaceId !== undefined && { workspaceId: intent.workspaceId }),
      ...(intent.automationId !== undefined && { automationId: intent.automationId }),
      ...(intent.channelId !== undefined && { channelId: intent.channelId }),
      // 只有 agent 的提醒（0.142.0）带正文：它就是 agent 要说的话，别的种类的正文不上手机。
      ...(intent.kind === 'agent' && intent.body !== '' && { body: intent.body }),
      createdAt: intent.createdAt,
    };
    const now = this.#now();
    const counter = devices.nextPushCounter(deviceId, now);
    const result = await this.#options.gateway.send({
      platform: token.platform,
      token: token.token,
      payload: sealPushMessage(key, counter, encoder.encode(JSON.stringify(message))),
      collapseKey: pushCollapseKey(key, intent.collapseKey),
      expiresAt: now + this.#ttlMs,
    });
    this.#record(result);
    if (!result.ok && (result.error === 'unregistered' || result.error === 'not_bound')) {
      // 令牌失效或网关丢了绑定：删掉，设备下次连上时看到 `registered: false` 会重新报。
      const current = await devices.pushToken(deviceId);
      if (current?.token === token.token) await devices.setPushToken(deviceId, undefined);
    }
  }

  /** 记下一次网关请求的结果。令牌层面的拒绝（验证码不对、令牌失效）不算网关出问题。 */
  #record(result: PushGatewayResult): void {
    let next: GatewayState;
    if (result.ok) {
      next = { state: 'ok', lastSentAt: new Date(this.#now()).toISOString() };
    } else if (
      result.error === 'bad_code' ||
      result.error === 'unregistered' ||
      result.error === 'not_bound'
    ) {
      return;
    } else {
      next = {
        state: 'unavailable',
        ...(this.#status.lastSentAt !== undefined && { lastSentAt: this.#status.lastSentAt }),
        error: {
          reason:
            result.error === 'rate_limited'
              ? 'rate_limited'
              : result.error === 'unreachable' || result.error === 'upstream_failed'
                ? 'unreachable'
                : 'rejected',
          message: result.message.slice(0, 500),
        },
      };
    }
    if (JSON.stringify(next) === JSON.stringify(this.#status)) return;
    this.#status = next;
    this.#statusChanged();
  }

  /** 删掉设备的令牌并向网关解绑（不等结果）。 */
  async #forget(deviceId: DeviceId): Promise<void> {
    const token = await this.#options.devices.pushToken(deviceId);
    await this.#options.devices.setPushToken(deviceId, undefined);
    if (token !== undefined) void this.#unbind(token);
  }

  async #unbind(token: StoredPushToken): Promise<void> {
    try {
      const result = await this.#options.gateway.unbind(token);
      if (!result.ok && result.error === 'unreachable') this.#record(result);
    } catch (error) {
      this.#onError(error);
    }
  }

  #dropSlots(deviceId: DeviceId): void {
    for (const [key, slot] of this.#slots) {
      if (!key.startsWith(`${deviceId}\n`)) continue;
      if (slot.timer !== undefined) clearTimeout(slot.timer);
      this.#slots.delete(key);
    }
  }

  #clearSlots(): void {
    for (const slot of this.#slots.values()) {
      if (slot.timer !== undefined) clearTimeout(slot.timer);
    }
    this.#slots.clear();
  }
}
