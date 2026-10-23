// iOS 模拟器（0.122.0，Host 功能 `ios_simulator`，domain-model §3.15.9）：设备列表与生命周期走 simctl，画面、输入、录像与辅助功能树
// 走 helper（helper.ts）。窗格（`simulator.*`）与 agent（`simulator_control`）操作的是同一台设备、同一路流。
//
// 画面：一台设备一路流，Host 向 helper 要（`stream_start`），按订阅者转发到 `/simulator/stream` 的 WebSocket。新订阅者先收最近的尺寸、
// 编解码配置与从最近关键帧起的帧（缓存超过上限时改向 helper 要一个关键帧）；某个订阅者积压超过上限时丢它的非关键帧直到下一个关键帧，
// 不断开。没有订阅者、agent 也 30 秒没用这台设备时停流。helper 闲着（没流、没录像）5 分钟就退出，下次用时再起；意外退出时在有人看的
// 情况下按退避重启并重新起流。

import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  type MethodParams,
  type MethodResult,
  type NotificationParams,
  type SessionId,
  SIMULATOR_FRAME_KIND,
  SIMULATOR_STREAM_PATH,
  type SimulatorDevice,
  type SimulatorInput,
  type SimulatorOrientation,
  SimulatorOrientationSchema,
  type SimulatorRecordingId,
  type SimulatorScreen,
  SimulatorScreenSchema,
} from '@wevir/protocol';
import { newId } from '../ids.js';
import { SimulatorError } from './errors.js';
import { type HelperEvent, type HelperFrame, SimulatorHelper } from './helper.js';
import { Simctl, type SimctlList } from './simctl.js';

/** 没有订阅者、agent 也不用之后多久停流。 */
export const SIMULATOR_STREAM_IDLE_MS = 30_000;
/** helper 没流、没录像之后多久退出。 */
export const SIMULATOR_HELPER_IDLE_MS = 5 * 60_000;
/** 一个订阅者的积压上限；超过时丢非关键帧到下一个关键帧。缓存的关键帧组也以它为上限。 */
export const SIMULATOR_BACKLOG_BYTES = 4 * 1024 * 1024;
/** `simulator.attach` 的令牌多久不连就作废。 */
export const SIMULATOR_TOKEN_TTL_MS = 30_000;
/** 有连接关心设备列表时多久重读一次（发现别处的启动、关机）。 */
export const SIMULATOR_POLL_MS = 10_000;
/** 流的帧率。 */
export const SIMULATOR_STREAM_FPS = 60;
/** 两次向 helper 要关键帧的最短间隔。 */
const KEYFRAME_INTERVAL_MS = 500;

/** `/simulator/stream` 用到的 WebSocket 的部分。 */
export interface SimulatorStreamSocket {
  readonly bufferedAmount: number;
  send(data: Buffer): void;
  close(code?: number, reason?: string): void;
  once(event: 'close', listener: () => void): unknown;
}

export type SimulatorNotice =
  | { method: 'simulator.changed'; params: NotificationParams<'simulator.changed'> }
  | { method: 'simulator.orientation'; params: NotificationParams<'simulator.orientation'> };

export interface SimulatorServiceOptions {
  /** helper 可执行文件（`WEVIR_IOS_SIMULATOR_BIN`）。 */
  bin: string;
  /** `<数据目录>/simulator`：`output/`（截图与录像，Host 启动与退出时清空）、`derived/`（构建）。 */
  dir: string;
  /** RPC 端口的 `ws://127.0.0.1:<端口>`；还没监听时 undefined。 */
  streamBase: () => string | undefined;
  simctl?: Simctl;
  /** 默认 true；测试关掉。 */
  sandbox?: boolean;
  onWarning?: (message: string, fields?: Record<string, unknown>) => void;
  /** helper 的 stderr（调试日志）。 */
  onLog?: (line: string) => void;
  streamIdleMs?: number;
  helperIdleMs?: number;
  backlogBytes?: number;
  pollMs?: number;
  /** 启动 helper 时的环境；默认 `process.env`。 */
  env?: NodeJS.ProcessEnv;
}

interface Subscriber {
  socket: SimulatorStreamSocket;
  owner: string;
  /** 在等关键帧：之前的非关键帧都不发。 */
  waitingKey: boolean;
}

/** 一台设备的流。 */
interface Hub {
  udid: string;
  streamId: number | undefined;
  starting: Promise<void> | undefined;
  subscribers: Map<string, Subscriber>;
  /** 窗格 attach 时给的会话（连接 → 会话）。 */
  paneSessions: Map<string, SessionId>;
  size: Buffer | undefined;
  config: Buffer | undefined;
  /** 最近的关键帧与之后的帧；超过上限时丢掉，新订阅者改要关键帧。 */
  gop: Buffer[] | undefined;
  gopBytes: number;
  lastUse: number;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  keyframeAt: number;
  /** 两次要关键帧至少隔 `KEYFRAME_INTERVAL_MS`；隔得太近的推迟到那时再要。 */
  keyframeTimer: ReturnType<typeof setTimeout> | undefined;
  /** 流意外结束后连着重启了几次。 */
  restarts: number;
}

interface Token {
  udid: string;
  owner: string;
  timer: ReturnType<typeof setTimeout>;
}

interface Recording {
  udid: string;
  helperId: unknown;
  path: string;
}

/** 已知的设备信息（`describe_device`），转向后作废。 */
interface Described {
  screen: SimulatorScreen;
  orientation: SimulatorOrientation;
}

export class SimulatorService {
  readonly #options: SimulatorServiceOptions;
  readonly #simctl: Simctl;
  readonly #outputDir: string;
  readonly #hubs = new Map<string, Hub>();
  readonly #byStream = new Map<number, Hub>();
  /** 回答 `stream_start` 之前就到了的帧（fd 3 与 stdout 是两条管道，先后不定），登记流之后补上。 */
  readonly #early = new Map<number, HelperFrame[]>();
  readonly #tokens = new Map<string, Token>();
  readonly #recordings = new Map<SimulatorRecordingId, Recording>();
  readonly #described = new Map<string, Described>();
  readonly #orientations = new Map<string, SimulatorOrientation>();
  /** agent 在哪些会话里 attach 了哪台设备：会话 → UDID（最近的）。 */
  readonly #agentDevices = new Map<SessionId, string>();
  readonly #listeners = new Set<(notice: SimulatorNotice) => void>();
  readonly #showListeners = new Set<(params: NotificationParams<'simulator.show'>) => void>();
  #helper: SimulatorHelper | undefined;
  #starting: Promise<SimulatorHelper> | undefined;
  /** 正在等 `ready` 的 helper（退出时也要结束它）。 */
  #launching: SimulatorHelper | undefined;
  #helperIdle: ReturnType<typeof setTimeout> | undefined;
  #crashes: number[] = [];
  #restartTimer: ReturnType<typeof setTimeout> | undefined;
  #list: SimctlList | undefined;
  #lastChanged = '';
  #poll: ReturnType<typeof setInterval> | undefined;
  #disposed = false;

  constructor(options: SimulatorServiceOptions) {
    this.#options = options;
    this.#simctl = options.simctl ?? new Simctl();
    this.#outputDir = join(options.dir, 'output');
  }

  /** helper 在不在、能不能执行（Host 据此声明 `ios_simulator`）。 */
  static async available(bin: string | undefined, platform = process.platform): Promise<boolean> {
    if (platform !== 'darwin' || bin === undefined || bin === '' || !isAbsolute(bin)) return false;
    try {
      await access(bin, constants.X_OK);
      return (await stat(bin)).isFile();
    } catch {
      return false;
    }
  }

  /** 清空上次留下的输出目录。 */
  async init(): Promise<void> {
    await rm(this.#outputDir, { recursive: true, force: true });
    await mkdir(this.#outputDir, { recursive: true, mode: 0o700 });
  }

  /** 构建的 DerivedData 目录。 */
  derivedDataDir(key: string): string {
    return join(this.#options.dir, 'derived', key);
  }

  // ── 设备 ──────────────────────────────────────────────────────────────

  async list(): Promise<MethodResult<'simulator.list'>> {
    const list = await this.#simctl.list();
    this.#list = list;
    const result = { ...list, devices: this.#withAttached(list) };
    this.#emitChangedIfNew(result.devices);
    return result;
  }

  async boot(udid: string): Promise<void> {
    await this.#simctl.boot(udid);
    await this.#refresh();
  }

  async shutdown(udid: string): Promise<void> {
    const hub = this.#hubs.get(udid);
    if (hub !== undefined) await this.#stopStream(hub, 'shutdown');
    await this.#simctl.shutdown(udid);
    this.#described.delete(udid);
    await this.#refresh();
  }

  async create(params: MethodParams<'simulator.create'>): Promise<SimulatorDevice> {
    const udid = await this.#simctl.create(params.name, params.deviceTypeId, params.runtimeId);
    const devices = (await this.list()).devices;
    const device = devices.find((candidate) => candidate.udid === udid);
    if (device === undefined)
      throw new SimulatorError('sim_not_found', 'the new simulator is missing');
    return device;
  }

  /** 设备；不在时抛 `sim_not_found`。 */
  async device(udid: string): Promise<SimulatorDevice> {
    const devices = (await this.list()).devices;
    const device = devices.find((candidate) => candidate.udid === udid);
    if (device === undefined) {
      throw new SimulatorError('sim_not_found', `no simulator with UDID ${udid}`);
    }
    return device;
  }

  /** 设备没启动时启动它。 */
  async ensureBooted(udid: string): Promise<SimulatorDevice> {
    const device = await this.device(udid);
    if (device.state === 'booted') return device;
    if (!device.available) {
      throw new SimulatorError(
        'sim_not_found',
        `${device.name} cannot boot: its runtime is not installed in the current Xcode`,
      );
    }
    await this.#simctl.boot(udid);
    await this.#refresh();
    return { ...device, state: 'booted' };
  }

  get simctl(): Simctl {
    return this.#simctl;
  }

  // ── 窗格的画面 ───────────────────────────────────────────────────────

  /**
   * `simulator.attach`：`owner` 是发起的连接。同一连接对同一台设备再 attach 时作废旧令牌、断开旧的流。返回的令牌只连一次，
   * `SIMULATOR_TOKEN_TTL_MS` 内不连就作废。
   */
  async attach(
    params: MethodParams<'simulator.attach'>,
    owner: string,
  ): Promise<MethodResult<'simulator.attach'>> {
    const base = this.#options.streamBase();
    if (base === undefined)
      throw new SimulatorError('sim_stream_failed', 'the host is not listening');
    await this.ensureBooted(params.udid);
    const hub = this.#hub(params.udid);
    hub.lastUse = Date.now();
    await this.#ensureStream(hub);
    const described = await this.describe(params.udid);
    this.#dropOwner(hub, owner);
    if (params.sessionId !== undefined) {
      hub.paneSessions.set(owner, params.sessionId);
      this.#emitChanged();
    }
    const token = randomBytes(24).toString('base64url');
    const timer = setTimeout(() => {
      this.#tokens.delete(token);
      this.#scheduleIdle(hub);
    }, SIMULATOR_TOKEN_TTL_MS);
    timer.unref();
    this.#tokens.set(token, { udid: params.udid, owner, timer });
    return {
      streamUrl: `${base}${SIMULATOR_STREAM_PATH}?token=${token}`,
      token,
      screen: described.screen,
      orientation: described.orientation,
    };
  }

  /** `simulator.detach`：这条连接不再看这台设备。 */
  detach(udid: string, owner: string): void {
    const hub = this.#hubs.get(udid);
    if (hub === undefined) return;
    this.#dropOwner(hub, owner);
    this.#scheduleIdle(hub);
  }

  /** 连接关闭：撤掉它在所有设备上的订阅与令牌。 */
  detachOwner(owner: string): void {
    for (const hub of this.#hubs.values()) {
      if (hub.subscribers.has(owner) || hub.paneSessions.has(owner)) this.detach(hub.udid, owner);
    }
    for (const [token, entry] of this.#tokens) {
      if (entry.owner !== owner) continue;
      clearTimeout(entry.timer);
      this.#tokens.delete(token);
    }
  }

  /**
   * `GET /simulator/stream?token=…`：令牌有效时返回接上 WebSocket 的函数（令牌随即作废），否则 undefined（Host 回 403）。
   */
  acceptStream(token: string): ((socket: SimulatorStreamSocket) => void) | undefined {
    const entry = this.#tokens.get(token);
    if (entry === undefined) return undefined;
    this.#tokens.delete(token);
    clearTimeout(entry.timer);
    return (socket) => {
      const hub = this.#hubs.get(entry.udid);
      if (hub === undefined || this.#disposed) {
        socket.close(1011, 'stream ended');
        return;
      }
      hub.subscribers.get(entry.owner)?.socket.close(1000, 'replaced');
      const subscriber: Subscriber = { socket, owner: entry.owner, waitingKey: false };
      hub.subscribers.set(entry.owner, subscriber);
      socket.once('close', () => {
        if (hub.subscribers.get(entry.owner) !== subscriber) return;
        hub.subscribers.delete(entry.owner);
        hub.lastUse = Date.now();
        this.#scheduleIdle(hub);
      });
      this.#clearIdle(hub);
      this.#prime(hub, subscriber);
      if (hub.streamId === undefined) void this.#ensureStream(hub).catch(() => {});
    };
  }

  // ── 输入与读取 ───────────────────────────────────────────────────────

  /** 屏幕的点尺寸与方向（缓存到转向）。 */
  async describe(udid: string): Promise<Described> {
    const cached = this.#described.get(udid);
    if (cached !== undefined) return cached;
    const result = await this.#request('describe_device', { udid });
    const screen = result.screen as Partial<SimulatorScreen> | undefined;
    if (
      typeof screen?.width !== 'number' ||
      typeof screen.height !== 'number' ||
      typeof screen.scale !== 'number'
    ) {
      throw new SimulatorError('sim_unknown_error', 'the simulator helper returned no screen size');
    }
    const orientation = SimulatorOrientationSchema.catch('portrait').parse(result.orientation);
    const described = {
      screen: { width: screen.width, height: screen.height, scale: screen.scale },
      orientation,
    };
    this.#described.set(udid, described);
    this.#orientations.set(udid, orientation);
    return described;
  }

  async input(udid: string, input: SimulatorInput): Promise<MethodResult<'simulator.input'>> {
    this.touch(udid);
    const { type, ...args } = input;
    switch (type) {
      case 'touch': {
        const touch = input as Extract<SimulatorInput, { type: 'touch' }>;
        if ((touch.points === undefined) === (touch.points2 === undefined)) {
          throw new SimulatorError('sim_invalid_argument', 'touch needs either points or points2');
        }
        await this.#request('touch', { udid, ...args });
        return {};
      }
      case 'rotate': {
        const result = await this.#request('rotate', { udid, ...args });
        this.#described.delete(udid);
        const orientation = SimulatorOrientationSchema.safeParse(result.orientation);
        if (!orientation.success) return {};
        const screen = SimulatorScreenSchema.safeParse(result.screen);
        if (screen.success) {
          this.#described.set(udid, { screen: screen.data, orientation: orientation.data });
        }
        this.#orientationChanged(udid, orientation.data, screen.success ? screen.data : undefined);
        return { orientation: orientation.data };
      }
      default:
        await this.#request(type, { udid, ...args });
        return {};
    }
  }

  /**
   * 一张截图。`path` 给了时写到那里（绝对路径），否则结果带 base64。`scale` 相对点尺寸（默认 1：图片的像素就是点）。
   */
  async screenshot(
    params: MethodParams<'simulator.screenshot'>,
  ): Promise<MethodResult<'simulator.screenshot'>> {
    const format = params.format ?? 'png';
    if (params.path !== undefined && !isAbsolute(params.path)) {
      throw new SimulatorError('sim_invalid_argument', 'path must be absolute');
    }
    await mkdir(this.#outputDir, { recursive: true, mode: 0o700 });
    const result = await this.#request('screenshot', {
      udid: params.udid,
      format,
      ...(params.quality !== undefined && { quality: params.quality }),
      scale: params.scale ?? 1,
    });
    this.touch(params.udid);
    let data: Buffer;
    if (typeof result.base64 === 'string') {
      data = Buffer.from(result.base64, 'base64');
    } else if (typeof result.path === 'string') {
      data = await readFile(result.path);
      await rm(result.path, { force: true });
    } else {
      throw new SimulatorError('sim_unknown_error', 'the simulator helper returned no image');
    }
    const width = Math.round(Number(result.width));
    const height = Math.round(Number(result.height));
    if (!(width > 0 && height > 0)) {
      throw new SimulatorError('sim_unknown_error', 'the simulator helper returned no image size');
    }
    const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';
    if (params.path !== undefined) {
      await writeFile(params.path, data);
      return { path: params.path, mimeType, width, height };
    }
    return { data: data.toString('base64'), mimeType, width, height };
  }

  async recordStart(udid: string): Promise<SimulatorRecordingId> {
    for (const recording of this.#recordings.values()) {
      if (recording.udid === udid) {
        throw new SimulatorError('sim_invalid_argument', 'this simulator is already recording');
      }
    }
    await mkdir(this.#outputDir, { recursive: true, mode: 0o700 });
    const id = newId('rec') as SimulatorRecordingId;
    const path = join(this.#outputDir, `${id}.mp4`);
    const result = await this.#request('record_start', { udid, path });
    this.#recordings.set(id, { udid, helperId: result.recordingId, path });
    this.#clearHelperIdle();
    return id;
  }

  async recordStop(
    recordingId: SimulatorRecordingId,
  ): Promise<MethodResult<'simulator.record.stop'>> {
    const recording = this.#recordings.get(recordingId);
    if (recording === undefined) {
      throw new SimulatorError('sim_invalid_argument', 'no such recording');
    }
    this.#recordings.delete(recordingId);
    const result = await this.#request(
      'record_stop',
      { recordingId: recording.helperId },
      60_000,
    ).finally(() => this.#scheduleHelperIdle());
    const durationMs = Math.max(0, Math.round(Number(result.durationMs) || 0));
    const path = typeof result.path === 'string' ? result.path : recording.path;
    return { path, durationMs };
  }

  async configure(params: MethodParams<'simulator.configure'>): Promise<void> {
    const { udid } = params;
    if (params.appearance !== undefined) await this.#simctl.appearance(udid, params.appearance);
    if (params.statusBar !== undefined) await this.#simctl.statusBar(udid, params.statusBar);
    if (params.slowAnimations !== undefined) {
      await this.#request('slow_animations', { udid, enabled: params.slowAnimations });
    }
    if (params.hardwareKeyboard !== undefined) {
      await this.#request('set_keyboard', { udid, hardware: params.hardwareKeyboard });
    }
    if (params.softwareKeyboard !== undefined) {
      await this.#request('set_keyboard', { udid, software: params.softwareKeyboard });
    }
  }

  /** 辅助功能树（`point` 给了时只取那个点上的元素）。 */
  async axTree(udid: string, point?: { x: number; y: number }): Promise<Record<string, unknown>> {
    this.touch(udid);
    return this.#request('ax_tree', { udid, ...(point !== undefined && { point }) });
  }

  /** helper 的其他命令（agent 工具用）。 */
  helperCommand(cmd: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.#request(cmd, params);
  }

  // ── agent ────────────────────────────────────────────────────────────

  /** agent 在会话里 attach 了设备：起流（窗格打开后直接有画面）、记进 `attachedBy`、请界面打开窗格。 */
  async agentAttach(sessionId: SessionId, udid: string): Promise<Described> {
    await this.ensureBooted(udid);
    const hub = this.#hub(udid);
    await this.#ensureStream(hub);
    const described = await this.describe(udid);
    hub.lastUse = Date.now();
    this.#scheduleIdle(hub);
    const before = this.#agentDevices.get(sessionId);
    this.#agentDevices.set(sessionId, udid);
    if (before !== udid) this.#emitChanged();
    for (const listener of this.#showListeners) listener({ udid, sessionId });
    return described;
  }

  /** agent 不再用这台设备（省略时是这个会话 attach 的那台）。 */
  agentDetach(sessionId: SessionId): string | undefined {
    const udid = this.#agentDevices.get(sessionId);
    if (udid === undefined) return undefined;
    this.#agentDevices.delete(sessionId);
    this.#emitChanged();
    return udid;
  }

  /** 这个会话里 agent attach 的设备。 */
  agentDevice(sessionId: SessionId): string | undefined {
    return this.#agentDevices.get(sessionId);
  }

  /** agent 用了这台设备：有流时推迟停流。 */
  touch(udid: string): void {
    const hub = this.#hubs.get(udid);
    if (hub === undefined) return;
    hub.lastUse = Date.now();
    if (hub.idleTimer !== undefined) this.#scheduleIdle(hub);
  }

  /** 删除会话时忘掉它的 attach。 */
  removeSessions(sessionIds: readonly SessionId[]): void {
    let changed = false;
    for (const sessionId of sessionIds) changed = this.#agentDevices.delete(sessionId) || changed;
    for (const hub of this.#hubs.values()) {
      for (const [owner, sessionId] of hub.paneSessions) {
        if (sessionIds.includes(sessionId)) {
          hub.paneSessions.delete(owner);
          changed = true;
        }
      }
    }
    if (changed) this.#emitChanged();
  }

  // ── 通知 ──────────────────────────────────────────────────────────────

  /** `simulator.changed` 与 `simulator.orientation`。有监听者时定时重读设备列表。 */
  watch(listener: (notice: SimulatorNotice) => void): () => void {
    this.#listeners.add(listener);
    if (this.#poll === undefined && !this.#disposed) {
      this.#poll = setInterval(() => void this.#refresh().catch(() => {}), this.#pollMs);
      this.#poll.unref();
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0 && this.#poll !== undefined) {
        clearInterval(this.#poll);
        this.#poll = undefined;
      }
    };
  }

  /** `simulator.show`：agent attach 了设备。 */
  watchShow(listener: (params: NotificationParams<'simulator.show'>) => void): () => void {
    this.#showListeners.add(listener);
    return () => this.#showListeners.delete(listener);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#poll !== undefined) clearInterval(this.#poll);
    clearTimeout(this.#restartTimer);
    this.#clearHelperIdle();
    for (const entry of this.#tokens.values()) clearTimeout(entry.timer);
    this.#tokens.clear();
    for (const hub of this.#hubs.values()) {
      this.#clearIdle(hub);
      for (const subscriber of hub.subscribers.values())
        subscriber.socket.close(1001, 'going away');
      hub.subscribers.clear();
    }
    this.#helper?.stop();
    this.#helper = undefined;
    this.#launching?.stop();
    this.#listeners.clear();
    this.#showListeners.clear();
    await rm(this.#outputDir, { recursive: true, force: true }).catch(() => {});
  }

  // ── 内部 ──────────────────────────────────────────────────────────────

  get #pollMs(): number {
    return this.#options.pollMs ?? SIMULATOR_POLL_MS;
  }

  get #backlog(): number {
    return this.#options.backlogBytes ?? SIMULATOR_BACKLOG_BYTES;
  }

  #hub(udid: string): Hub {
    let hub = this.#hubs.get(udid);
    if (hub === undefined) {
      hub = {
        udid,
        streamId: undefined,
        starting: undefined,
        subscribers: new Map(),
        paneSessions: new Map(),
        size: undefined,
        config: undefined,
        gop: undefined,
        gopBytes: 0,
        lastUse: Date.now(),
        idleTimer: undefined,
        keyframeAt: 0,
        keyframeTimer: undefined,
        restarts: 0,
      };
      this.#hubs.set(udid, hub);
    }
    return hub;
  }

  #dropOwner(hub: Hub, owner: string): void {
    for (const [token, entry] of this.#tokens) {
      if (entry.owner === owner && entry.udid === hub.udid) {
        clearTimeout(entry.timer);
        this.#tokens.delete(token);
      }
    }
    const subscriber = hub.subscribers.get(owner);
    if (subscriber !== undefined) {
      hub.subscribers.delete(owner);
      subscriber.socket.close(1000, 'detached');
    }
    if (hub.paneSessions.delete(owner)) this.#emitChanged();
  }

  async #ensureStream(hub: Hub): Promise<void> {
    if (hub.streamId !== undefined) return;
    hub.starting ??= (async () => {
      try {
        const result = await this.#request('stream_start', {
          udid: hub.udid,
          codec: 'h264',
          fps: SIMULATOR_STREAM_FPS,
        });
        const streamId = Number(result.streamId);
        if (!Number.isInteger(streamId)) {
          throw new SimulatorError('sim_stream_failed', 'the simulator helper returned no stream');
        }
        hub.streamId = streamId;
        this.#byStream.set(streamId, hub);
        const early = this.#early.get(streamId) ?? [];
        this.#early.delete(streamId);
        for (const frame of early) this.#frame(frame);
        this.#clearHelperIdle();
      } finally {
        hub.starting = undefined;
      }
    })();
    return hub.starting;
  }

  async #stopStream(hub: Hub, reason: string): Promise<void> {
    this.#clearIdle(hub);
    const streamId = hub.streamId;
    this.#resetStream(hub);
    for (const subscriber of hub.subscribers.values()) subscriber.socket.close(1000, reason);
    hub.subscribers.clear();
    if (streamId !== undefined) {
      await this.#helper?.request('stream_stop', { streamId }).catch(() => {});
    }
    this.#scheduleHelperIdle();
  }

  #resetStream(hub: Hub): void {
    if (hub.streamId !== undefined) this.#byStream.delete(hub.streamId);
    hub.streamId = undefined;
    hub.size = undefined;
    hub.config = undefined;
    hub.gop = undefined;
    hub.gopBytes = 0;
  }

  /** 新订阅者：先发最近的尺寸与配置，再发缓存的关键帧组；没有缓存时等下一个关键帧并向 helper 要一个。 */
  #prime(hub: Hub, subscriber: Subscriber): void {
    if (hub.size !== undefined) subscriber.socket.send(hub.size);
    if (hub.config !== undefined) subscriber.socket.send(hub.config);
    if (hub.gop !== undefined && hub.gop.length > 0) {
      for (const frame of hub.gop) subscriber.socket.send(frame);
      return;
    }
    subscriber.waitingKey = true;
    this.#requestKeyframe(hub);
  }

  #requestKeyframe(hub: Hub): void {
    if (hub.streamId === undefined || hub.keyframeTimer !== undefined) return;
    const wait = hub.keyframeAt + KEYFRAME_INTERVAL_MS - Date.now();
    if (wait > 0) {
      hub.keyframeTimer = setTimeout(() => {
        hub.keyframeTimer = undefined;
        if ([...hub.subscribers.values()].some((subscriber) => subscriber.waitingKey)) {
          this.#requestKeyframe(hub);
        }
      }, wait);
      hub.keyframeTimer.unref();
      return;
    }
    hub.keyframeAt = Date.now();
    void this.#helper?.request('keyframe', { streamId: hub.streamId }).catch(() => {});
  }

  #frame(frame: HelperFrame): void {
    const hub = this.#byStream.get(frame.streamId);
    if (hub === undefined) {
      if ([...this.#hubs.values()].some((candidate) => candidate.starting !== undefined)) {
        const early = this.#early.get(frame.streamId) ?? [];
        if (early.length < 16) early.push({ ...frame, wire: Buffer.from(frame.wire) });
        this.#early.set(frame.streamId, early);
      }
      return;
    }
    hub.restarts = 0;
    switch (frame.kind) {
      case SIMULATOR_FRAME_KIND.size: {
        hub.size = Buffer.from(frame.wire);
        hub.config = undefined;
        hub.gop = undefined;
        hub.gopBytes = 0;
        this.#described.delete(hub.udid);
        for (const subscriber of hub.subscribers.values()) {
          subscriber.waitingKey = true;
          subscriber.socket.send(hub.size);
        }
        return;
      }
      case SIMULATOR_FRAME_KIND.config: {
        hub.config = Buffer.from(frame.wire);
        for (const subscriber of hub.subscribers.values()) subscriber.socket.send(hub.config);
        return;
      }
      case SIMULATOR_FRAME_KIND.key: {
        const copy = Buffer.from(frame.wire);
        hub.gop = [copy];
        hub.gopBytes = copy.length;
        for (const subscriber of hub.subscribers.values()) {
          subscriber.waitingKey = false;
          subscriber.socket.send(copy);
        }
        return;
      }
      default: {
        if (hub.gop !== undefined) {
          if (hub.gopBytes + frame.wire.length > this.#backlog) {
            hub.gop = undefined;
            hub.gopBytes = 0;
          } else {
            const copy = Buffer.from(frame.wire);
            hub.gop.push(copy);
            hub.gopBytes += copy.length;
          }
        }
        for (const subscriber of hub.subscribers.values()) {
          if (subscriber.waitingKey) continue;
          if (subscriber.socket.bufferedAmount > this.#backlog) {
            subscriber.waitingKey = true;
            this.#requestKeyframe(hub);
            continue;
          }
          subscriber.socket.send(frame.wire);
        }
      }
    }
  }

  #event(event: HelperEvent): void {
    if (event.event === 'orientation') {
      const udid = String(event.udid ?? '');
      const parsed = SimulatorOrientationSchema.safeParse(event.orientation);
      if (udid === '' || !parsed.success) return;
      if (this.#orientations.get(udid) === parsed.data) return;
      // 先记下方向（`rotate` 的回答随后到时不再重发），再带上转向后的点尺寸发通知；读不到尺寸时只发方向。
      this.#orientations.set(udid, parsed.data);
      if (this.#described.get(udid)?.orientation !== parsed.data) this.#described.delete(udid);
      const orientation = parsed.data;
      this.describe(udid).then(
        (described) => this.#notifyOrientation(udid, orientation, described.screen),
        () => this.#notifyOrientation(udid, orientation),
      );
      return;
    }
    if (event.event === 'stream_ended') {
      const hub =
        (typeof event.streamId === 'number' ? this.#byStream.get(event.streamId) : undefined) ??
        this.#hubs.get(String(event.udid ?? ''));
      if (hub === undefined) return;
      this.#options.onWarning?.('ios simulator stream ended', {
        udid: hub.udid,
        reason: event.reason,
      });
      this.#resetStream(hub);
      if (hub.subscribers.size === 0) return;
      hub.restarts += 1;
      if (hub.restarts > 3) {
        for (const subscriber of hub.subscribers.values()) {
          subscriber.socket.close(1011, 'stream ended');
        }
        hub.subscribers.clear();
        return;
      }
      setTimeout(() => {
        if (hub.subscribers.size > 0) {
          for (const subscriber of hub.subscribers.values()) subscriber.waitingKey = true;
          void this.#ensureStream(hub).catch(() => {});
        }
      }, 500 * hub.restarts).unref();
    }
  }

  #orientationChanged(
    udid: string,
    orientation: SimulatorOrientation,
    screen?: SimulatorScreen,
  ): void {
    if (this.#orientations.get(udid) === orientation) return;
    this.#orientations.set(udid, orientation);
    this.#notifyOrientation(udid, orientation, screen);
  }

  #notifyOrientation(
    udid: string,
    orientation: SimulatorOrientation,
    screen?: SimulatorScreen,
  ): void {
    this.#notify({
      method: 'simulator.orientation',
      params: { udid, orientation, ...(screen !== undefined && { screen }) },
    });
  }

  #scheduleIdle(hub: Hub): void {
    this.#clearIdle(hub);
    if (hub.subscribers.size > 0 || hub.streamId === undefined) return;
    for (const entry of this.#tokens.values()) if (entry.udid === hub.udid) return;
    const idleMs = this.#options.streamIdleMs ?? SIMULATOR_STREAM_IDLE_MS;
    const wait = Math.max(0, hub.lastUse + idleMs - Date.now());
    hub.idleTimer = setTimeout(() => {
      hub.idleTimer = undefined;
      if (hub.subscribers.size > 0) return;
      if (Date.now() - hub.lastUse < idleMs) {
        this.#scheduleIdle(hub);
        return;
      }
      void this.#stopStream(hub, 'idle');
    }, wait);
    hub.idleTimer.unref();
  }

  #clearIdle(hub: Hub): void {
    clearTimeout(hub.idleTimer);
    hub.idleTimer = undefined;
    clearTimeout(hub.keyframeTimer);
    hub.keyframeTimer = undefined;
  }

  #scheduleHelperIdle(): void {
    this.#clearHelperIdle();
    if (this.#helper === undefined || this.#disposed) return;
    if (this.#byStream.size > 0 || this.#recordings.size > 0) return;
    this.#helperIdle = setTimeout(() => {
      this.#helperIdle = undefined;
      if (this.#byStream.size > 0 || this.#recordings.size > 0) return;
      this.#helper?.stop();
      this.#helper = undefined;
    }, this.#options.helperIdleMs ?? SIMULATOR_HELPER_IDLE_MS);
    this.#helperIdle.unref();
  }

  #clearHelperIdle(): void {
    clearTimeout(this.#helperIdle);
    this.#helperIdle = undefined;
  }

  async #request(
    cmd: string,
    params: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<Record<string, unknown>> {
    const helper = await this.#ensureHelper();
    try {
      return await helper.request(cmd, params, timeoutMs);
    } finally {
      this.#scheduleHelperIdle();
    }
  }

  #ensureHelper(): Promise<SimulatorHelper> {
    if (this.#disposed) {
      return Promise.reject(
        new SimulatorError('sim_helper_unavailable', 'the host is shutting down'),
      );
    }
    if (this.#helper !== undefined && !this.#helper.exited && this.#helper.ready !== undefined) {
      return Promise.resolve(this.#helper);
    }
    this.#starting ??= (async () => {
      try {
        await mkdir(this.#outputDir, { recursive: true, mode: 0o700 });
        const helper: SimulatorHelper = new SimulatorHelper({
          bin: this.#options.bin,
          outputDir: this.#outputDir,
          ...(this.#options.sandbox !== undefined && { sandbox: this.#options.sandbox }),
          env: {
            ...(this.#options.env ?? process.env),
            WEVIR_IOS_SIMULATOR_OUTPUT_DIR: this.#outputDir,
          },
          onFrame: (frame) => this.#frame(frame),
          onEvent: (event) => this.#event(event),
          onExit: (info) => this.#helperExited(helper, info),
          ...(this.#options.onWarning !== undefined && { onWarning: this.#options.onWarning }),
          ...(this.#options.onLog !== undefined && { onLog: this.#options.onLog }),
        });
        this.#launching = helper;
        await helper.start().finally(() => {
          this.#launching = undefined;
        });
        if (this.#disposed) {
          helper.stop();
          throw new SimulatorError('sim_helper_unavailable', 'the host is shutting down');
        }
        this.#helper = helper;
        return helper;
      } finally {
        this.#starting = undefined;
      }
    })();
    return this.#starting;
  }

  #helperExited(
    helper: SimulatorHelper,
    info: { code: number | null; signal: string | null; expected: boolean; stderr: string[] },
  ): void {
    if (this.#helper === helper) this.#helper = undefined;
    this.#early.clear();
    // 这个 helper 起的流与录像都没了。
    for (const hub of this.#hubs.values()) {
      if (hub.streamId !== undefined) this.#resetStream(hub);
    }
    this.#recordings.clear();
    if (info.expected || this.#disposed) return;
    this.#options.onWarning?.('ios simulator helper exited', {
      code: info.code,
      signal: info.signal,
      stderr: info.stderr,
    });
    const now = Date.now();
    this.#crashes = [...this.#crashes.filter((at) => now - at < 60_000), now];
    const watched = [...this.#hubs.values()].filter((hub) => hub.subscribers.size > 0);
    if (watched.length === 0) return;
    if (this.#crashes.length > 5) {
      for (const hub of watched) {
        for (const subscriber of hub.subscribers.values()) {
          subscriber.socket.close(1011, 'helper crashed');
        }
        hub.subscribers.clear();
      }
      return;
    }
    const delay = Math.min(30_000, 500 * 2 ** (this.#crashes.length - 1));
    clearTimeout(this.#restartTimer);
    this.#restartTimer = setTimeout(() => {
      for (const hub of watched) {
        if (hub.subscribers.size === 0) continue;
        for (const subscriber of hub.subscribers.values()) subscriber.waitingKey = true;
        void this.#ensureStream(hub).catch((error: unknown) => {
          this.#options.onWarning?.('ios simulator stream restart failed', {
            udid: hub.udid,
            error,
          });
        });
      }
    }, delay);
    this.#restartTimer.unref();
  }

  async #refresh(): Promise<void> {
    if (this.#listeners.size === 0) return;
    await this.list();
  }

  #withAttached(list: SimctlList): SimulatorDevice[] {
    const attached = new Map<string, Set<SessionId>>();
    const add = (udid: string, sessionId: SessionId) => {
      const set = attached.get(udid) ?? new Set();
      set.add(sessionId);
      attached.set(udid, set);
    };
    for (const [sessionId, udid] of this.#agentDevices) add(udid, sessionId);
    for (const hub of this.#hubs.values()) {
      for (const sessionId of hub.paneSessions.values()) add(hub.udid, sessionId);
    }
    return list.devices.map((device) => ({
      ...device,
      attachedBy: [...(attached.get(device.udid) ?? [])],
    }));
  }

  #emitChanged(): void {
    if (this.#list === undefined) return;
    this.#emitChangedIfNew(this.#withAttached(this.#list));
  }

  #emitChangedIfNew(devices: SimulatorDevice[]): void {
    const text = JSON.stringify(devices);
    if (text === this.#lastChanged) return;
    const first = this.#lastChanged === '';
    this.#lastChanged = text;
    if (!first) this.#notify({ method: 'simulator.changed', params: { devices } });
  }

  #notify(notice: SimulatorNotice): void {
    for (const listener of this.#listeners) listener(notice);
  }
}
