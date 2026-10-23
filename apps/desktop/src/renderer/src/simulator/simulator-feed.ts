// 模拟器的设备列表与画面流（0.122.0）在渲染进程这边的状态。
//
// 设备列表：第一次用到时读 `simulator.list`，之后跟着 `simulator.changed` 更新，重连后重读。
//
// 画面流：Host 对同一条连接、同一台设备只留一个 attach（再调一次会作废旧的流），所以一台设备在这个窗口里只 attach 一次，
// 几个窗格（分屏里两个会话都开着模拟器）共用：`subscribeFeed` 按设备计数，最后一个退订一秒后才断开（换会话、开发模式的
// effect 重跑不必重连）。后来的订阅者先收缓存的尺寸、配置与最近的关键帧组。流意外断开时先看设备还在不在运行：关机了就
// 停在“已关机”（再 attach 会把它开起来），否则按退避重连，连续失败 5 次后停下等用户重试。

import type { WevirClient } from '@wevir/client-sdk';
import { openSimulatorStream, type SimulatorFrame, type SimulatorStream } from '@wevir/client-sdk';
import type {
  SessionId,
  SimulatorDevice,
  SimulatorDeviceType,
  SimulatorRuntime,
  SimulatorUdid,
} from '@wevir/protocol';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { describe } from '@/host/host-connection';
import { createStore } from '@/lib/store';

// ── 设备列表 ─────────────────────────────────────────────────────────────

export interface SimulatorCatalog {
  status: 'loading' | 'ready' | 'failed';
  devices: readonly SimulatorDevice[];
  deviceTypes: readonly SimulatorDeviceType[];
  runtimes: readonly SimulatorRuntime[];
  error?: string;
}

const EMPTY_CATALOG: SimulatorCatalog = {
  status: 'loading',
  devices: [],
  deviceTypes: [],
  runtimes: [],
};

const catalog = createStore<SimulatorCatalog>(EMPTY_CATALOG);
let catalogClient: WevirClient | undefined;
let stopCatalog: (() => void) | undefined;

export function reloadCatalog(client: WevirClient): Promise<void> {
  return client.request('simulator.list', {}).then(
    (result) => catalog.set({ status: 'ready', ...result }),
    (error: unknown) =>
      catalog.set((current) => ({ ...current, status: 'failed', error: describe(error) })),
  );
}

/** 设备列表；换了客户端（重新连接）时重新订阅。 */
export function useSimulatorCatalog(client: WevirClient): SimulatorCatalog {
  useEffect(() => {
    if (catalogClient === client) return;
    stopCatalog?.();
    catalogClient = client;
    catalog.set(EMPTY_CATALOG);
    const off = client.onSimulatorsChanged((change) => {
      if (change === undefined) void reloadCatalog(client);
      else catalog.set((current) => ({ ...current, status: 'ready', devices: change.devices }));
    });
    stopCatalog = off;
    void reloadCatalog(client);
  }, [client]);
  return catalog.use();
}

export function currentDevices(): readonly SimulatorDevice[] {
  return catalog.get().devices;
}

// ── 每个会话选中的设备 ───────────────────────────────────────────────────

/** 窗格看的是哪台：按会话记（没有会话时用空串），`null` 是用户断开了。 */
const selections = createStore<ReadonlyMap<string, SimulatorUdid | null>>(new Map());

export function selectDevice(sessionId: string | undefined, udid: SimulatorUdid | null): void {
  selections.set((current) => new Map(current).set(sessionId ?? '', udid));
}

export function useSelectedDevice(sessionId: string | undefined): SimulatorUdid | null | undefined {
  return selections.use().get(sessionId ?? '');
}

// ── 每台设备的本地开关（Host 没有读回的接口，记住窗格里最后设的值） ─────────

export interface DeviceToggles {
  appearance?: 'light' | 'dark';
  statusBar?: 'live' | 'clean';
  slowAnimations?: boolean;
  hardwareKeyboard?: boolean;
}

const toggles = createStore<ReadonlyMap<string, DeviceToggles>>(new Map());

export function setDeviceToggles(udid: string, patch: DeviceToggles): void {
  toggles.set((current) => new Map(current).set(udid, { ...current.get(udid), ...patch }));
}

export function useDeviceToggles(udid: string): DeviceToggles {
  return toggles.use().get(udid) ?? {};
}

/** 粘贴时先把 Mac 的剪贴板发给设备（Edit 菜单的勾选项，默认开）。 */
export const useMacClipboard = createStore(true);

// ── 录像 ─────────────────────────────────────────────────────────────────

export interface Recording {
  recordingId: `rec_${string}`;
  startedAt: number;
  /** 正在停止（等 Host 写完文件）。 */
  stopping?: boolean;
}

/** 正在录的设备；换会话、窗格重新挂上时还在。 */
export const recordings = createStore<ReadonlyMap<string, Recording>>(new Map());

export function setRecording(udid: string, recording: Recording | undefined): void {
  recordings.set((current) => {
    const next = new Map(current);
    if (recording) next.set(udid, recording);
    else next.delete(udid);
    return next;
  });
}

// ── 画面流 ───────────────────────────────────────────────────────────────

export type FeedStatus =
  | { kind: 'connecting' }
  /** `scale` 是屏幕倍率（像素 = 点 × 倍率）。 */
  | { kind: 'live'; scale: number }
  | { kind: 'reconnecting'; attempt: number }
  | { kind: 'shutdown' }
  | { kind: 'failed'; error: string };

export interface FeedSubscriber {
  onFrame(frame: SimulatorFrame): void;
}

const MAX_ATTEMPTS = 5;
const RELEASE_MS = 1000;
/** 流断了之后等多久再看设备的状态。 */
const SETTLE_MS = 1000;
/** 缓存的关键帧组上限：超过就扔掉，等下一个关键帧（Host 最长 2 秒一个）。 */
const MAX_CACHED_FRAMES = 240;
/** attach 可能要先启动设备。 */
const ATTACH_TIMEOUT_MS = 120_000;

class DeviceFeed {
  readonly subscribers = new Set<FeedSubscriber>();
  readonly status = createStore<FeedStatus>({ kind: 'connecting' });
  #stream: SimulatorStream | undefined;
  #size: SimulatorFrame | undefined;
  #config: SimulatorFrame | undefined;
  #group: SimulatorFrame[] = [];
  #attempt = 0;
  #scale = 1;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #releaseTimer: ReturnType<typeof setTimeout> | undefined;
  #generation = 0;
  #offReconnect: () => void;

  constructor(
    readonly client: WevirClient,
    readonly udid: SimulatorUdid,
    readonly sessionId: SessionId | undefined,
  ) {
    // 重连上之后旧的令牌与流都不在了，重新 attach；设备在关机就停下（再 attach 会把它开起来）。
    this.#offReconnect = client.onSimulatorsChanged((change) => {
      if (change === undefined) {
        if (this.status.get().kind !== 'shutdown') this.restart();
        return;
      }
      // 只看已经连上的：正在 attach 的设备可能还没开起来（attach 会启动它）。
      const kind = this.status.get().kind;
      if (kind !== 'live' && kind !== 'reconnecting') return;
      const device = change.devices.find((candidate) => candidate.udid === this.udid);
      if (device === undefined || device.state === 'shutdown' || device.state === 'shuttingDown') {
        this.halt();
      }
    });
  }

  subscribe(subscriber: FeedSubscriber): () => void {
    clearTimeout(this.#releaseTimer);
    this.subscribers.add(subscriber);
    for (const frame of [this.#size, this.#config, ...this.#group]) {
      if (frame) subscriber.onFrame(frame);
    }
    if (this.#stream === undefined && this.#timer === undefined) void this.#connect();
    return () => {
      this.subscribers.delete(subscriber);
      if (this.subscribers.size === 0) {
        this.#releaseTimer = setTimeout(() => this.dispose(), RELEASE_MS);
      }
    };
  }

  /** 重新连接（用户点“重试”、关机后再启动、客户端重连）。 */
  restart(): void {
    this.#attempt = 0;
    this.#close();
    void this.#connect();
  }

  /** 停在“已关机”，不再重连（窗格里点了关机，或设备关机了）。 */
  halt(): void {
    if (this.status.get().kind === 'shutdown') return;
    this.#close();
    this.status.set({ kind: 'shutdown' });
  }

  dispose(): void {
    feeds.delete(this.udid);
    this.#offReconnect();
    this.#close();
    void this.client.request('simulator.detach', { udid: this.udid }).catch(() => {});
  }

  #close(): void {
    this.#generation++;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const stream = this.#stream;
    this.#stream = undefined;
    stream?.close();
  }

  async #connect(): Promise<void> {
    const generation = ++this.#generation;
    const retrying = this.#attempt > 0;
    this.status.set(
      retrying ? { kind: 'reconnecting', attempt: this.#attempt } : { kind: 'connecting' },
    );
    try {
      // 自动重连只连还在运行的设备：attach 会把关了的设备开起来，只有用户自己选、点“启动”时才这样。
      if (retrying && !(await this.#stillBooted(generation))) return;
      const attached = await this.client.request(
        'simulator.attach',
        { udid: this.udid, ...(this.sessionId !== undefined && { sessionId: this.sessionId }) },
        { timeoutMs: ATTACH_TIMEOUT_MS },
      );
      if (generation !== this.#generation) return;
      this.#scale = attached.screen.scale;
      this.#stream = openSimulatorStream(WebSocket, attached.streamUrl, {
        onFrame: (frame) => {
          if (generation !== this.#generation) return;
          if (this.#attempt > 0 || this.status.get().kind !== 'live') {
            this.#attempt = 0;
            this.status.set({ kind: 'live', scale: this.#scale });
          }
          this.#remember(frame);
          for (const subscriber of [...this.subscribers]) subscriber.onFrame(frame);
        },
        onClose: () => {
          if (generation !== this.#generation) return;
          this.#stream = undefined;
          void this.#retry(generation);
        },
      });
    } catch (error) {
      if (generation !== this.#generation) return;
      this.#fail(generation, describe(error));
    }
  }

  #remember(frame: SimulatorFrame): void {
    if (frame.kind === 'size') {
      this.#size = frame;
      this.#config = undefined;
      this.#group = [];
    } else if (frame.kind === 'config') {
      this.#config = frame;
      this.#group = [];
    } else if (frame.kind === 'key') {
      this.#group = [frame];
    } else if (this.#group.length > 0) {
      this.#group.push(frame);
      if (this.#group.length > MAX_CACHED_FRAMES) this.#group = [];
    }
  }

  /** 流断了：等一会儿（关机时 Host 先断流再关机），设备还在运行就重连，否则停下。 */
  async #retry(generation: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    if (generation !== this.#generation) return;
    if (await this.#stillBooted(generation)) this.#fail(generation, undefined);
  }

  /** 读一次设备列表：这台不在运行时停在“已关机”并返回 false。 */
  async #stillBooted(generation: number): Promise<boolean> {
    let device: SimulatorDevice | undefined;
    try {
      const listed = await this.client.request('simulator.list', {});
      catalog.set({ status: 'ready', ...listed });
      device = listed.devices.find((candidate) => candidate.udid === this.udid);
    } catch {
      device = currentDevices().find((candidate) => candidate.udid === this.udid);
    }
    if (generation !== this.#generation) return false;
    if (device?.state === 'booted' || device?.state === 'booting') return true;
    this.status.set({ kind: 'shutdown' });
    return false;
  }

  #fail(generation: number, error: string | undefined): void {
    this.#attempt++;
    if (this.#attempt > MAX_ATTEMPTS) {
      this.status.set({ kind: 'failed', error: error ?? '' });
      return;
    }
    this.status.set({ kind: 'reconnecting', attempt: this.#attempt });
    this.#timer = setTimeout(
      () => {
        this.#timer = undefined;
        if (generation === this.#generation) void this.#connect();
      },
      Math.min(500 * 2 ** (this.#attempt - 1), 8000),
    );
  }
}

const feeds = new Map<SimulatorUdid, DeviceFeed>();

function feedFor(client: WevirClient, udid: SimulatorUdid, sessionId: SessionId | undefined) {
  let feed = feeds.get(udid);
  if (feed && feed.client !== client) {
    feed.dispose();
    feed = undefined;
  }
  if (!feed) {
    feed = new DeviceFeed(client, udid, sessionId);
    feeds.set(udid, feed);
  }
  return feed;
}

/** 订阅一台设备的画面帧，返回退订函数。 */
export function subscribeFeed(
  client: WevirClient,
  udid: SimulatorUdid,
  sessionId: SessionId | undefined,
  subscriber: FeedSubscriber,
): () => void {
  return feedFor(client, udid, sessionId).subscribe(subscriber);
}

const CONNECTING: FeedStatus = { kind: 'connecting' };

/** 一台设备的画面流状态。 */
export function useFeedStatus(
  client: WevirClient,
  udid: SimulatorUdid | undefined,
  sessionId: SessionId | undefined,
): FeedStatus {
  const subscribe = useCallback(
    (listener: () => void) =>
      udid === undefined ? () => {} : feedFor(client, udid, sessionId).status.subscribe(listener),
    [client, udid, sessionId],
  );
  return useSyncExternalStore(
    subscribe,
    () => (udid === undefined ? undefined : feeds.get(udid)?.status.get()) ?? CONNECTING,
  );
}

export function restartFeed(udid: SimulatorUdid): void {
  feeds.get(udid)?.restart();
}

/** 窗格里点了关机：先停下画面流，免得断流后又自动连上把设备开起来。 */
export function haltFeed(udid: SimulatorUdid): void {
  feeds.get(udid)?.halt();
}
