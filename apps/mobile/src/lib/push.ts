// 推送（ADR-0017 §6 与补记 6，host-api.md §1.3）的手机一侧：纯逻辑，不 import React Native，Vitest 直接测。
//
// - 登记：每台开了推送的电脑都要绑定这台手机的推送令牌。手机向网关要验证码（`/v1/verify`），网关经这个令牌推一条静默推送送来验证码，
//   手机经隧道交给电脑（`push.register`），电脑再签名向网关绑定。令牌变了重绑，退出电脑时解绑（`push.unregister`）。网关的验证码按
//   “电脑 + 令牌”记，而静默推送里只有码、不说是哪台电脑要的，所以同一时刻只登记一台。
// - 推送密钥：载荷用 Host 与设备静态密钥的 DH 派生的推送密钥加密（`@wevir/noise` 的 `derivePushKey`）。设备私钥在钥匙串里是
//   “解锁后才读得到”，锁屏时通知服务扩展读不到，所以手机在前台时把派生好的推送密钥另存一份（“首次解锁后可读”），扩展只用它解密。
//   推送密钥只能解开这台电脑发来的推送，拿不到会话、也冒充不了设备。
// - 解密：推送里不说是哪台电脑发的，逐台试；计数重放的丢掉（`PushReplayGuard`）。

import { base64urlToBytes } from '@wevir/client-sdk';
import {
  derivePushKey,
  type KeyPair,
  openPushMessage,
  PushReplayGuard,
  type PushReplayState,
} from '@wevir/noise';
import {
  type NotificationIntent,
  PUSH_DATA_CODE_KEY,
  PUSH_DATA_KIND_KEY,
  PUSH_DATA_PAYLOAD_KEY,
  PUSH_GATEWAY_PATHS,
  PushGatewayErrorSchema,
  type PushMessage,
  PushMessageSchema,
  type PushPlatform,
  type PushState,
  PushVerifyCodeSchema,
} from '@wevir/protocol';

// ── 网关推来的数据 ─────────────────────────────────────────────────

export type PushData = { kind: 'verify'; code: string } | { kind: 'push'; payload: string };

/** 网关推来的数据（APNs 的顶层自定义键、FCM 的 `data`）：验证码或加密载荷，别的都不认。 */
export function parsePushData(data: unknown): PushData | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const record = data as Record<string, unknown>;
  const kind = record[PUSH_DATA_KIND_KEY];
  if (kind === 'verify') {
    const code = record[PUSH_DATA_CODE_KEY];
    return PushVerifyCodeSchema.safeParse(code).success
      ? { kind: 'verify', code: code as string }
      : undefined;
  }
  if (kind === 'push') {
    const payload = record[PUSH_DATA_PAYLOAD_KEY];
    return typeof payload === 'string' && /^[A-Za-z0-9_-]+$/.test(payload)
      ? { kind: 'push', payload }
      : undefined;
  }
  return undefined;
}

// ── 登记 ───────────────────────────────────────────────────────────

/** 这台电脑的推送密钥：设备私钥与电脑的 Noise 静态公钥（记录里的 `hostPublicKey`）。 */
export function computerPushKey(hostPublicKey: string, device: KeyPair): Uint8Array {
  const host = base64urlToBytes(hostPublicKey);
  return derivePushKey({
    secretKey: device.secretKey,
    publicKey: host,
    hostPublicKey: host,
    devicePublicKey: device.publicKey,
  });
}

export interface DeviceToken {
  platform: PushPlatform;
  token: string;
}

/** 系统给不出令牌的原因：没有通知权限，或这台手机 / 这个构建收不到推送（没配 FCM、国内安卓、模拟器）。 */
export type TokenUnavailable = 'denied' | 'unavailable';

/** 一台电脑上推送的样子（电脑详情页显示）。 */
export type PushStatus =
  /** 电脑上的 Wevir 太旧，或这台设备没有 `session.read`。 */
  | { kind: 'unsupported' }
  /** 电脑上没开（总开关或这台设备的开关）。 */
  | { kind: 'off' }
  | { kind: 'denied' }
  | { kind: 'unavailable' }
  | { kind: 'registering' }
  | { kind: 'registered' }
  | { kind: 'failed'; reason: PushFailure };

export type PushFailure =
  /** 网关连不上或拒绝。 */
  | 'gateway'
  /** 一直没收到验证码（推送没送达）。 */
  | 'no_code'
  /** 电脑那边绑定失败。 */
  | 'host';

/** 一台电脑的推送接口（经隧道），`WevirClient` 里用到的部分。 */
export interface PushLinkClient {
  get(): Promise<PushState>;
  register(params: { platform: PushPlatform; token: string; code: string }): Promise<PushState>;
  unregister(): Promise<PushState>;
  /** `push.changed`；重连之后以 `undefined` 调一次。 */
  onChanged(listener: (state: PushState | undefined) => void): () => void;
}

export interface PushComputer {
  /** 记录名称（跳转、去重用）。 */
  name: string;
  routeId: string;
}

export interface PushRegistrarEnvironment {
  /** 系统的推送令牌。会弹通知权限，所以只在有电脑开了推送时才调。 */
  deviceToken(): Promise<DeviceToken | TokenUnavailable>;
  /** 向网关发 `POST`（`fetch` 的子集）。 */
  post(url: string, body: string): Promise<{ status: number; text(): Promise<string> }>;
  /** 这台电脑的推送密钥（用设备私钥与电脑公钥派生）。 */
  pushKey(computer: PushComputer): Promise<Uint8Array>;
  store: PushRegistrationStore;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/** 登记过哪个令牌（按路由 ID）与给扩展用的推送密钥。 */
export interface PushRegistrationStore {
  registration(routeId: string): Promise<string | undefined>;
  setRegistration(routeId: string, value: string | undefined): Promise<void>;
  saveKey(routeId: string, key: Uint8Array): Promise<void>;
  deleteKey(routeId: string): Promise<void>;
}

/** 等验证码多久：网关先推再回 202，静默推送一般几秒内到。 */
export const PUSH_CODE_TIMEOUT_MS = 30_000;
/** 退出电脑时等 `push.unregister` 多久。 */
export const PUSH_UNREGISTER_TIMEOUT_MS = 3_000;

export class PushGatewayRequestError extends Error {
  override readonly name = 'PushGatewayRequestError';
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

class CodeTimeoutError extends Error {
  override readonly name = 'CodeTimeoutError';
}

function registrationValue(token: DeviceToken): string {
  return `${token.platform}:${token.token}`;
}

/**
 * 全部电脑的登记。`sync` 在每次连上、`push.changed`、令牌变了时调；同一时刻只有一台在要验证码（见文件头）。验证码由后台任务收到后交给
 * `deliverCode`。
 */
export class PushRegistrar {
  readonly #env: PushRegistrarEnvironment;
  readonly #statuses = new Map<string, PushStatus>();
  readonly #listeners = new Set<() => void>();
  /** 串行的登记队列。 */
  #queue: Promise<unknown> = Promise.resolve();
  #codeWaiter: ((code: string) => void) | undefined;
  /** 每台电脑最近一次 `sync` 的序号：新的 `sync` 来了，排在队里的旧的不再做。 */
  readonly #generations = new Map<string, number>();
  /** 退出了的电脑的连接：解绑后电脑会发 `push.changed`，不能因此又去登记。 */
  readonly #removed = new WeakSet<PushLinkClient>();

  constructor(env: PushRegistrarEnvironment) {
    this.#env = env;
  }

  status(name: string): PushStatus | undefined {
    return this.#statuses.get(name);
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 后台任务收到的验证码。没人在等时丢掉（过期的、别的流程的）。 */
  deliverCode(code: string): void {
    const waiter = this.#codeWaiter;
    this.#codeWaiter = undefined;
    waiter?.(code);
  }

  /** 按电脑现在的推送状态（`push.get` 或 `push.changed`）登记、重登或清理。 */
  sync(computer: PushComputer, client: PushLinkClient, known?: PushState): Promise<PushStatus> {
    const generation = (this.#generations.get(computer.name) ?? 0) + 1;
    this.#generations.set(computer.name, generation);
    const run = async (): Promise<PushStatus> => {
      if (this.#removed.has(client)) return { kind: 'off' };
      if (this.#generations.get(computer.name) !== generation) {
        return this.#statuses.get(computer.name) ?? { kind: 'off' };
      }
      const status = await this.#sync(computer, client, known).catch(
        (): PushStatus => ({ kind: 'failed', reason: 'host' }),
      );
      // 期间又来了新的 `sync`（例如登记触发的 `push.changed`），它的结果为准。
      if (this.#generations.get(computer.name) === generation)
        this.#setStatus(computer.name, status);
      return status;
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => {});
    return next;
  }

  /** 这台电脑断开了：界面不再显示它的推送状态。 */
  forgetStatus(name: string): void {
    if (this.#statuses.delete(name)) this.#changed();
  }

  /** 退出这台电脑：连着时先请电脑解绑（等不了多久），再删本机的推送密钥与登记。 */
  async remove(computer: PushComputer, client: PushLinkClient | undefined): Promise<void> {
    this.#generations.set(computer.name, (this.#generations.get(computer.name) ?? 0) + 1);
    if (client !== undefined) this.#removed.add(client);
    if (client !== undefined && (await this.#env.store.registration(computer.routeId))) {
      await this.#withTimeout(client.unregister(), PUSH_UNREGISTER_TIMEOUT_MS).catch(() => {});
    }
    await this.#env.store.setRegistration(computer.routeId, undefined);
    await this.#env.store.deleteKey(computer.routeId);
    this.forgetStatus(computer.name);
  }

  async #sync(
    computer: PushComputer,
    client: PushLinkClient,
    known: PushState | undefined,
  ): Promise<PushStatus> {
    const state = known ?? (await client.get());
    const { store } = this.#env;
    if (!state.enabled) {
      // 电脑上关了：电脑已经删了令牌、向网关解绑，这里只清本机的。
      if ((await store.registration(computer.routeId)) !== undefined) {
        await store.setRegistration(computer.routeId, undefined);
        await store.deleteKey(computer.routeId);
      }
      return { kind: 'off' };
    }
    const token = await this.#env.deviceToken();
    if (token === 'denied' || token === 'unavailable') return { kind: token };
    // 推送密钥每次都写：派生很便宜，写一次保证扩展有最新的（重新配对后电脑公钥会变）。
    await store.saveKey(computer.routeId, await this.#env.pushKey(computer));
    const value = registrationValue(token);
    if (state.registered && (await store.registration(computer.routeId)) === value) {
      return { kind: 'registered' };
    }
    // 等令牌期间退出了这台电脑。
    if (this.#removed.has(client)) return { kind: 'off' };
    this.#setStatus(computer.name, { kind: 'registering' });
    // 验证码不对（例如晚到的上一次的码）时再要一次。
    for (let attempt = 0; ; attempt += 1) {
      let code: string;
      try {
        code = await this.#requestCode(state, token);
      } catch (error) {
        return {
          kind: 'failed',
          reason: error instanceof CodeTimeoutError ? 'no_code' : 'gateway',
        };
      }
      try {
        await client.register({ platform: token.platform, token: token.token, code });
      } catch (error) {
        if (attempt === 0 && gatewayReason(error) === 'bad_code') continue;
        return { kind: 'failed', reason: gatewayReason(error) === undefined ? 'host' : 'gateway' };
      }
      await store.setRegistration(computer.routeId, value);
      return { kind: 'registered' };
    }
  }

  /** 向网关要验证码并等它推来。先开始等再发请求：网关先推送、再回 202。 */
  async #requestCode(state: PushState, token: DeviceToken): Promise<string> {
    const code = new Promise<string>((resolve) => {
      this.#codeWaiter = resolve;
    });
    try {
      const response = await this.#env.post(
        new URL(PUSH_GATEWAY_PATHS.verify, state.gatewayUrl).toString(),
        JSON.stringify({ routeId: state.routeId, platform: token.platform, token: token.token }),
      );
      if (response.status !== 202 && response.status !== 200) {
        const parsed = PushGatewayErrorSchema.safeParse(
          await response.text().then(
            (text) => JSON.parse(text) as unknown,
            () => undefined,
          ),
        );
        throw new PushGatewayRequestError(
          parsed.success ? parsed.data.error.code : `http_${response.status}`,
          parsed.success ? parsed.data.error.message : `push gateway answered ${response.status}`,
        );
      }
      return await this.#withTimeout(code, PUSH_CODE_TIMEOUT_MS, () => new CodeTimeoutError());
    } finally {
      this.#codeWaiter = undefined;
    }
  }

  #withTimeout<T>(promise: Promise<T>, ms: number, error = () => new Error('timeout')): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = this.#env.setTimer(() => reject(error()), ms);
      promise.then(
        (value) => {
          this.#env.clearTimer(timer);
          resolve(value);
        },
        (cause: unknown) => {
          this.#env.clearTimer(timer);
          reject(cause);
        },
      );
    });
  }

  #setStatus(name: string, status: PushStatus): void {
    const previous = this.#statuses.get(name);
    if (previous !== undefined && JSON.stringify(previous) === JSON.stringify(status)) return;
    this.#statuses.set(name, status);
    this.#changed();
  }

  #changed(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}

/** `PUSH_GATEWAY_ERROR` 的 `data.reason`（client-sdk 的 `WevirRpcError`，只看形状）。 */
function gatewayReason(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, data } = error as { code?: unknown; data?: unknown };
  if (code !== -32072) return undefined;
  const reason = (data as { reason?: unknown } | undefined)?.reason;
  return typeof reason === 'string' ? reason : 'rejected';
}

// ── 解密与显示 ─────────────────────────────────────────────────────

export interface PushKeyEntry extends PushComputer {
  key: Uint8Array;
}

export type OpenedPush =
  | { kind: 'ok'; computer: PushComputer; message: PushMessage }
  /** 哪台电脑的密钥都解不开（退出了的电脑、被伪造的推送）。 */
  | { kind: 'undecryptable' }
  /** 收过的计数（重放）。 */
  | { kind: 'replayed' }
  /** 解开了但内容不对。 */
  | { kind: 'invalid' };

/**
 * 逐台试着解开一条推送，通过的再查重放。`guard` 给出每台电脑的重放检查（状态由调用方存取）。
 */
export function openPush(
  payload: string,
  entries: readonly PushKeyEntry[],
  guard: (routeId: string) => PushReplayGuard,
): OpenedPush {
  for (const entry of entries) {
    let opened: { counter: number; plaintext: Uint8Array };
    try {
      opened = openPushMessage(entry.key, payload);
    } catch {
      continue;
    }
    if (!guard(entry.routeId).accept(opened.counter)) return { kind: 'replayed' };
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(opened.plaintext));
    } catch {
      return { kind: 'invalid' };
    }
    const parsed = PushMessageSchema.safeParse(value);
    if (!parsed.success) return { kind: 'invalid' };
    return {
      kind: 'ok',
      computer: { name: entry.name, routeId: entry.routeId },
      message: parsed.data,
    };
  }
  return { kind: 'undecryptable' };
}

/** 重放状态按路由 ID 存（Android 的后台任务存成一份 JSON；iOS 的扩展用同一个形状）。 */
export type PushReplayStates = Record<string, PushReplayState>;

/** 从存下的状态建重放检查，`save()` 时取回改过的状态。 */
export function replayGuards(states: PushReplayStates): {
  guard(routeId: string): PushReplayGuard;
  save(): PushReplayStates;
} {
  const guards = new Map<string, PushReplayGuard>();
  return {
    guard(routeId) {
      let guard = guards.get(routeId);
      if (guard === undefined) {
        const state = states[routeId];
        guard = new PushReplayGuard(state === undefined ? {} : { state });
        guards.set(routeId, guard);
      }
      return guard;
    },
    save() {
      const next: PushReplayStates = { ...states };
      for (const [routeId, guard] of guards) next[routeId] = guard.state();
      return next;
    },
  };
}

/** 通知上显示的内容：标题是会话（没有时用电脑名），副标题是电脑名，正文是提醒的种类（agent 的提醒是它写的正文，0.142.0）。 */
export function pushContent(
  message: PushMessage,
  kindText: (kind: PushMessage['kind']) => string,
): { title: string; subtitle: string; body: string } {
  const host = message.host.trim();
  return {
    title: message.title.trim() || host || 'Wevir',
    subtitle: host,
    body: message.body?.trim() || kindText(message.kind),
  };
}

/** 本地通知里带的跳转信息（Android 的通知、iOS 扩展改写后的 `userInfo`）：点开去哪台电脑的哪个会话或助理。 */
export const PUSH_TARGET_KEY = 'wevirTarget';

export interface PushTarget {
  computer: string;
  sessionId?: string;
  channelId?: string;
}

export function pushTarget(computer: PushComputer, message: PushMessage): PushTarget {
  return {
    computer: computer.name,
    ...(message.sessionId !== undefined && { sessionId: message.sessionId }),
    ...(message.channelId !== undefined && { channelId: message.channelId }),
  };
}

/** 从通知的数据里读跳转信息（字段不对时 undefined）。 */
export function readPushTarget(data: unknown): PushTarget | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const value = (data as Record<string, unknown>)[PUSH_TARGET_KEY];
  if (typeof value !== 'object' || value === null) return undefined;
  const { computer, sessionId, channelId } = value as Record<string, unknown>;
  if (typeof computer !== 'string' || computer === '') return undefined;
  if (sessionId !== undefined && typeof sessionId !== 'string') return undefined;
  if (channelId !== undefined && typeof channelId !== 'string') return undefined;
  return {
    computer,
    ...(sessionId !== undefined && { sessionId }),
    ...(channelId !== undefined && { channelId }),
  };
}

/** 跳转信息转成 `notificationTarget` 要的形状。 */
export function targetIntent(
  target: PushTarget,
): Pick<NotificationIntent, 'sessionId' | 'channelId'> {
  return {
    ...(target.sessionId !== undefined && {
      sessionId: target.sessionId as NotificationIntent['sessionId'],
    }),
    ...(target.channelId !== undefined && {
      channelId: target.channelId as NotificationIntent['channelId'],
    }),
  };
}
