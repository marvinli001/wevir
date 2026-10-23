// 一台电脑的连接（M2a）：一个 `WevirClient`（远程隧道），App 在前台时连、进后台就断（iOS 后台留不住 socket），连上后读会话列表并跟着
// `sessions.changed`。这里只有状态机，`WevirClient` 与存储由 `LinkEnvironment` 注入（测试用假的）。
//
// 关闭码（ADR-0017 §3，host-api.md §1.1）：
// - 4007 设备被移除，或重连时 IK 握手被拒（这台设备的公钥已不在那台电脑的设备表里）：标成已移除、记进记录，不再自动连；
// - 4008 那台电脑关了远程访问：显示离线与原因，`WevirClient` 自己慢速重试；
// - 4009 权限改了：`WevirClient` 立即重连，界面不动；
// - 4010 只在配对时出现（`pairing.ts`）。

import {
  ClientClosedError,
  ConnectionLostError,
  type ConnectionState,
  RemoteHandshakeError,
  type RemoteRelayFailure,
  RemoteUnreachableError,
  WevirRpcError,
} from '@wevir/client-sdk';
import { CloseCode, type NotificationIntent, type Session } from '@wevir/protocol';
import type { ChannelClient } from './bot-store';
import {
  type ComputerRecord,
  type ConnectedInfo,
  type RouteKind,
  recordAfterConnect,
} from './records';
import type { SessionClient } from './session-watch';
import {
  applySessionsChange,
  type SessionList,
  type SessionsChangeLike,
  sortSessions,
} from './sessions';

export type OfflineReason =
  /** 哪条路都没走通（电脑关机、睡眠、不在同一网络）。 */
  | 'unreachable'
  /** 那台电脑关了远程访问（4008）。 */
  | 'remote_disabled'
  /** 经中继也没走通，原因在 `relay`。 */
  | 'relay'
  /** 对方不是配对时的那台电脑（Host 公钥不符）：不再自动重试。 */
  | 'host_mismatch';

export type LinkStatus =
  /** App 在后台，连接已断开。 */
  | { kind: 'paused' }
  | { kind: 'connecting' }
  | { kind: 'online'; route: RouteKind }
  | { kind: 'offline'; reason: OfflineReason; relay?: RemoteRelayFailure }
  /** 那台电脑移除了这台设备：要重新配对。 */
  | { kind: 'removed' };

export type SessionsState =
  | { kind: 'none' }
  | { kind: 'loading' }
  | { kind: 'ready'; sessions: readonly Session[] }
  /** 这台设备没有 `session.read`。 */
  | { kind: 'forbidden' }
  | { kind: 'failed' };

/** 连接失败的归类：已移除，或离线的原因与要不要自己再试。 */
export type LinkFailure =
  | { kind: 'removed' }
  | { kind: 'offline'; reason: OfflineReason; relay?: RemoteRelayFailure; retry: boolean };

/** 钥匙串里没有这台电脑的设备私钥（从备份恢复的记录、钥匙串被清空）：只能重新配对。 */
export class DeviceKeyMissingError extends Error {
  override readonly name = 'DeviceKeyMissingError';
  constructor() {
    super('the device key for this computer is not in the keychain');
  }
}

export function classifyLinkFailure(error: unknown): LinkFailure {
  if (error instanceof DeviceKeyMissingError) return { kind: 'removed' };
  if (error instanceof ClientClosedError && error.cause !== undefined)
    return classifyLinkFailure(error.cause);
  if (error instanceof ConnectionLostError) {
    if (error.closeCode === CloseCode.DEVICE_REVOKED) return { kind: 'removed' };
    if (error.closeCode === CloseCode.REMOTE_DISABLED)
      return { kind: 'offline', reason: 'remote_disabled', retry: true };
    if (error.cause !== undefined) return classifyLinkFailure(error.cause);
    return { kind: 'offline', reason: 'unreachable', retry: true };
  }
  if (error instanceof RemoteHandshakeError) {
    switch (error.reason) {
      case 'rejected':
        return { kind: 'removed' };
      case 'host_mismatch':
        return { kind: 'offline', reason: 'host_mismatch', retry: false };
      default:
        return { kind: 'offline', reason: 'unreachable', retry: true };
    }
  }
  if (error instanceof RemoteUnreachableError && error.relay !== undefined) {
    return { kind: 'offline', reason: 'relay', relay: error.relay, retry: true };
  }
  return { kind: 'offline', reason: 'unreachable', retry: true };
}

/** `LinkEnvironment.connect` 给出的客户端：`WevirClient` 里用到的部分。 */
export interface LinkClient {
  onStateChange(listener: (state: ConnectionState) => void): () => void;
  onSessionsChanged(listener: (change: SessionsChangeLike | undefined) => void): () => void;
  listSessions(): Promise<SessionList>;
  /** 助理的频道接口；Host 没有 `channels` 功能时没有。 */
  readonly channels?: ChannelClient;
  /** 按 ID 看一个会话（线程会话不在 `session.list` 里）；没有 `session.read` 时没有。 */
  readonly sessions?: SessionClient;
  /** Host 判定的通知意图（`notification.intent`）；Host 没有这项功能时什么都不收。 */
  watchNotifications?(listener: (intent: NotificationIntent) => void): () => void;
  close(): void;
}

export interface LinkConnectHooks {
  /** 现在的记录：`WevirClient` 每次重连前都按它取路（连上后候选地址会更新）。 */
  record(): ComputerRecord;
  /** 每次握手成功（含 `WevirClient` 自己的重连）。 */
  onConnected(info: ConnectedInfo): void;
  /** 从第一次连接起的连接状态。 */
  onStateChange(state: ConnectionState): void;
}

export interface LinkEnvironment {
  connect(hooks: LinkConnectHooks): Promise<LinkClient>;
  saveRecord(record: ComputerRecord): Promise<void>;
  now(): Date;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

/** 自己发起的重试（第一次就没连上，或 `WevirClient` 不再重连之后）的间隔。 */
export const LINK_RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 30_000] as const;

export interface LinkSnapshot {
  readonly record: ComputerRecord;
  readonly status: LinkStatus;
  readonly sessions: SessionsState;
  /** 上次在线的时刻（离线时显示）。 */
  readonly lastOnlineAt: string | undefined;
}

export class ComputerLink {
  readonly #env: LinkEnvironment;
  readonly #listeners = new Set<() => void>();
  #snapshot: LinkSnapshot;
  #list: SessionList | undefined;
  #client: LinkClient | undefined;
  #disposers: Array<() => void> = [];
  /** 每次 `resume` / `pause` 加一，旧连接的回调据此作废。 */
  #generation = 0;
  #active = false;
  #retryTimer: unknown;
  #retries = 0;
  /** 上次离线是因为电脑关了远程访问，此后还没连上过。 */
  #remoteDisabled = false;
  /** 正在读的列表请求；读完时若有更新的请求就再读一次。 */
  #reading: Promise<void> | undefined;
  #rereadQueued = false;

  constructor(record: ComputerRecord, env: LinkEnvironment) {
    this.#env = env;
    this.#snapshot = {
      record,
      status: record.removedAt !== undefined ? { kind: 'removed' } : { kind: 'paused' },
      sessions: { kind: 'none' },
      lastOnlineAt: record.lastConnectedAt,
    };
  }

  get snapshot(): LinkSnapshot {
    return this.#snapshot;
  }

  /** 连着时这台电脑的频道接口。 */
  get channels(): ChannelClient | undefined {
    return this.#client?.channels;
  }

  /** 现在的连接；换了连接就是另一个对象（重连、回到前台）。 */
  get connection(): object | undefined {
    return this.#client;
  }

  /** 连着时按 ID 看会话的接口。 */
  get sessions(): SessionClient | undefined {
    return this.#client?.sessions;
  }

  /** 连着时收这台电脑的通知意图；没连着时返回的取消函数什么都不做。 */
  watchNotifications(listener: (intent: NotificationIntent) => void): () => void {
    return this.#client?.watchNotifications?.(listener) ?? (() => {});
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 回到前台（或刚加进来）：没连着就连。已移除的不连。 */
  resume(): void {
    this.#active = true;
    if (this.#snapshot.status.kind === 'removed') return;
    if (this.#client !== undefined || this.#snapshot.status.kind === 'connecting') return;
    this.#retries = 0;
    this.#start();
  }

  /** 进后台：断开，不再重试。 */
  pause(): void {
    this.#active = false;
    this.#stop();
    if (this.#snapshot.status.kind !== 'removed') this.#update({ status: { kind: 'paused' } });
  }

  /** 立刻再试一次（离线时用户点了“重试”）。 */
  retryNow(): void {
    if (!this.#active || this.#snapshot.status.kind === 'removed') return;
    if (this.#client !== undefined) return;
    this.#stop();
    this.#retries = 0;
    this.#start();
  }

  /** 退出这台电脑：断开，之后不再用。 */
  dispose(): void {
    this.#active = false;
    this.#stop();
    this.#listeners.clear();
  }

  #start(): void {
    const generation = ++this.#generation;
    const current = () => generation === this.#generation;
    this.#update({ status: { kind: 'connecting' } });
    this.#env
      .connect({
        record: () => this.#snapshot.record,
        onConnected: (info) => {
          if (current()) this.#connected(info);
        },
        onStateChange: (state) => {
          if (current()) this.#clientState(state);
        },
      })
      .then(
        (client) => {
          if (!current()) {
            client.close();
            return;
          }
          this.#client = client;
          this.#retries = 0;
          this.#disposers.push(
            client.onSessionsChanged((change) => {
              if (current()) this.#sessionsChanged(change);
            }),
          );
          this.#readSessions(generation);
        },
        (error: unknown) => {
          if (current()) this.#failed(error);
        },
      );
  }

  #stop(): void {
    this.#generation += 1;
    if (this.#retryTimer !== undefined) {
      this.#env.clearTimer(this.#retryTimer);
      this.#retryTimer = undefined;
    }
    for (const dispose of this.#disposers.splice(0)) dispose();
    const client = this.#client;
    this.#client = undefined;
    this.#list = undefined;
    if (this.#snapshot.status.kind === 'online')
      this.#update({ lastOnlineAt: this.#env.now().toISOString() });
    client?.close();
  }

  #connected(info: ConnectedInfo): void {
    this.#remoteDisabled = false;
    const now = this.#env.now();
    const record = recordAfterConnect(this.#snapshot.record, info, now);
    this.#env.saveRecord(record).catch(() => {});
    this.#update({
      record,
      status: { kind: 'online', route: info.route },
      lastOnlineAt: now.toISOString(),
    });
  }

  #clientState(state: ConnectionState): void {
    switch (state.status) {
      case 'connecting':
      case 'connected':
        return;
      case 'reconnecting': {
        // 4009：权限改了，`WevirClient` 立即重连，界面不动。
        if (
          state.error instanceof ConnectionLostError &&
          state.error.closeCode === CloseCode.PERMISSIONS_CHANGED
        )
          return;
        if (this.#snapshot.status.kind === 'online')
          this.#update({ lastOnlineAt: this.#env.now().toISOString() });
        const failure = classifyLinkFailure(state.error);
        if (failure.kind === 'removed') {
          this.#markRemoved();
          return;
        }
        this.#update({
          status:
            state.attempt <= 1 && failure.reason === 'unreachable' && !this.#remoteDisabled
              ? { kind: 'connecting' }
              : this.#offlineStatus(failure),
        });
        return;
      }
      case 'closed':
        // 自己关的（暂停、退出）由 `#stop` 换代挡掉；第一次就没连上时 `connect` 也会 reject，由那边处理。
        if (state.error === undefined || this.#client === undefined) return;
        this.#failed(state.error);
    }
  }

  /**
   * 电脑说过远程访问关了（4008）之后，它的端口随即关闭，后面的尝试都只是连不上：在再次连上之前一直显示远程访问已关闭。
   */
  #offlineStatus(failure: Extract<LinkFailure, { kind: 'offline' }>): LinkStatus {
    if (failure.reason === 'remote_disabled') this.#remoteDisabled = true;
    else if (failure.reason === 'unreachable' && this.#remoteDisabled)
      return { kind: 'offline', reason: 'remote_disabled' };
    return offlineStatus(failure);
  }

  #failed(error: unknown): void {
    for (const dispose of this.#disposers.splice(0)) dispose();
    this.#client?.close();
    this.#client = undefined;
    const failure = classifyLinkFailure(error);
    if (failure.kind === 'removed') {
      this.#markRemoved();
      return;
    }
    if (this.#snapshot.status.kind === 'online')
      this.#update({ lastOnlineAt: this.#env.now().toISOString() });
    this.#update({ status: this.#offlineStatus(failure) });
    if (failure.retry && this.#active) this.#scheduleRetry();
  }

  #scheduleRetry(): void {
    const delay =
      LINK_RETRY_DELAYS_MS[Math.min(this.#retries, LINK_RETRY_DELAYS_MS.length - 1)] ?? 30_000;
    this.#retries += 1;
    const generation = this.#generation;
    this.#retryTimer = this.#env.setTimer(() => {
      this.#retryTimer = undefined;
      if (generation === this.#generation && this.#active) this.#start();
    }, delay);
  }

  #markRemoved(): void {
    this.#stop();
    const record: ComputerRecord = {
      ...this.#snapshot.record,
      removedAt: this.#env.now().toISOString(),
    };
    this.#env.saveRecord(record).catch(() => {});
    this.#update({ record, status: { kind: 'removed' }, sessions: { kind: 'none' } });
  }

  #sessionsChanged(change: SessionsChangeLike | undefined): void {
    const list = this.#list;
    const next =
      change === undefined || list === undefined ? undefined : applySessionsChange(list, change);
    if (next === undefined) {
      this.#readSessions(this.#generation);
      return;
    }
    this.#list = next;
    this.#update({ sessions: { kind: 'ready', sessions: next.sessions } });
  }

  #readSessions(generation: number): void {
    if (this.#reading !== undefined) {
      this.#rereadQueued = true;
      return;
    }
    const client = this.#client;
    if (client === undefined) return;
    if (this.#snapshot.sessions.kind !== 'ready') this.#update({ sessions: { kind: 'loading' } });
    this.#reading = client
      .listSessions()
      .then(
        (list) => {
          if (generation !== this.#generation) return;
          this.#list = { sessions: sortSessions(list.sessions), listVersion: list.listVersion };
          this.#update({ sessions: { kind: 'ready', sessions: this.#list.sessions } });
        },
        (error: unknown) => {
          if (generation !== this.#generation) return;
          const forbidden = error instanceof WevirRpcError && error.is('DEVICE_FORBIDDEN');
          this.#update({ sessions: { kind: forbidden ? 'forbidden' : 'failed' } });
        },
      )
      .finally(() => {
        this.#reading = undefined;
        if (this.#rereadQueued && generation === this.#generation) {
          this.#rereadQueued = false;
          this.#readSessions(generation);
        }
      });
  }

  #update(patch: Partial<LinkSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of [...this.#listeners]) listener();
  }
}

function offlineStatus(failure: Extract<LinkFailure, { kind: 'offline' }>): LinkStatus {
  return {
    kind: 'offline',
    reason: failure.reason,
    ...(failure.relay !== undefined && { relay: failure.relay }),
  };
}
