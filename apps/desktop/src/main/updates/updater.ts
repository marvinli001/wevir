// 自动更新的状态机（ADR-0007 补记 4）。检查：所有线路竞速取清单并验签（feed.ts），有新版本时在给出同一版本的线路之间按下载
// 速度选一条；下载与安装交给 electron-updater（mirror-provider.ts）。下载失败时换另一条线路重试一次。状态经 `onState` 推给
// 渲染进程，界面在侧栏左下角与设置 → 关于里显示。
//
// 不依赖 Electron 本身：electron-updater 的实例、网络请求、偏好的读写与计时器都从参数注入（index.ts 接上真实的），单元测试
// 换成假的。

import { compare, prerelease } from 'semver';
import type {
  UpdateChannel,
  UpdateErrorCode,
  UpdatePhase,
  UpdateState,
} from '../../shared/desktop-api.js';
import {
  type Fetcher,
  installerFile,
  type MirrorManifest,
  pickDownloadMirror,
  raceMirrors,
  readMirror,
  UpdateFeedError,
  type UpdateMirror,
} from './feed.js';
import { type FeedSource, MirrorProvider } from './mirror-provider.js';

/** 用到的 electron-updater 的部分（`AppUpdater`）。 */
export interface UpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowDowngrade: boolean;
  logger: {
    info(message?: unknown): void;
    warn(message?: unknown): void;
    error(message?: unknown): void;
  } | null;
  setFeedURL(options: Record<string, unknown>): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(
    event: 'update-available' | 'update-downloaded',
    listener: (info: { version: string }) => void,
  ): unknown;
  on(event: 'update-not-available', listener: () => void): unknown;
  on(
    event: 'download-progress',
    listener: (progress: { percent: number; bytesPerSecond: number }) => void,
  ): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

/** 存在 `<userData>/updates.json` 的偏好。 */
export interface UpdatePrefs {
  channel?: UpdateChannel;
}

export type UpdateLog = (
  level: 'info' | 'warn' | 'error',
  message: string,
  fields?: Record<string, unknown>,
) => void;

export interface UpdateControllerOptions {
  updater: UpdaterLike;
  currentVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  mirrors: readonly UpdateMirror[];
  /** 验清单签名的公钥（SPKI DER base64）；空表时更新关闭（`disabled: unsigned`）。 */
  publicKeys: readonly string[];
  fetcher: Fetcher;
  /** 不是安装包（开发构建）时为 false：更新关闭。 */
  packaged: boolean;
  /** macOS 上应用在只读或临时的位置运行（被系统转移、从 dmg 直接打开）：更新关闭，可以移到“应用程序”。 */
  readOnlyLocation: boolean;
  readPrefs(): UpdatePrefs;
  writePrefs(prefs: UpdatePrefs): void;
  log: UpdateLog;
  /** 启动后第一次检查的延迟，默认 30 s。 */
  firstCheckMs?: number;
  /** 之后每隔多久检查一次，默认 1 h。 */
  intervalMs?: number;
  /** 唤醒或回到前台时，上次检查早于这么久就补查一次（checkIfStale），默认 15 min。 */
  staleAfterMs?: number;
  /** 取清单的整体超时，默认 15 s。 */
  checkTimeoutMs?: number;
  /** 测速的超时，默认 8 s。 */
  probeTimeoutMs?: number;
  now?: () => number;
}

/** 当前版本是预发布（`-beta.N`）时默认开发版通道，否则正式版。 */
export function defaultChannel(version: string): UpdateChannel {
  return prerelease(version) === null ? 'stable' : 'dev';
}

export class UpdateController implements FeedSource {
  readonly #options: UpdateControllerOptions;
  readonly #listeners = new Set<(state: UpdateState) => void>();
  #state: UpdateState;
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** 本轮下载失败过的线路，重试时不再选它。 */
  readonly #failedMirrors = new Set<string>();
  #retried = false;
  #chosen: MirrorManifest | undefined;
  #checking: Promise<void> | undefined;

  constructor(options: UpdateControllerOptions) {
    this.#options = options;
    const channel = options.readPrefs().channel ?? defaultChannel(options.currentVersion);
    const base = { currentVersion: options.currentVersion, channel };
    if (!options.packaged) this.#state = { ...base, phase: 'disabled', reason: 'development' };
    else if (options.publicKeys.length === 0)
      this.#state = { ...base, phase: 'disabled', reason: 'unsigned' };
    else if (options.readOnlyLocation)
      this.#state = { ...base, phase: 'disabled', reason: 'location' };
    else this.#state = { ...base, phase: 'idle' };
    if (this.#state.phase === 'disabled') return;

    const { updater } = options;
    updater.autoDownload = false;
    // 下载好了但用户没点“重启以更新”就退出应用时，退出时安装（Codex 桌面端也是这样）。
    updater.autoInstallOnAppQuit = true;
    updater.allowDowngrade = false;
    updater.logger = {
      info: (message) => options.log('info', `updater: ${String(message)}`),
      warn: (message) => options.log('warn', `updater: ${String(message)}`),
      error: (message) => options.log('error', `updater: ${String(message)}`),
    };
    updater.setFeedURL({ provider: 'custom', updateProvider: MirrorProvider, feed: this });
    updater.on('update-available', (info) =>
      this.#set({ phase: 'available', version: info.version }),
    );
    updater.on('update-not-available', () => this.#set({ phase: 'latest' }));
    updater.on('download-progress', (progress) => {
      const version = 'version' in this.#state ? this.#state.version : '';
      this.#set({
        phase: 'downloading',
        version: version ?? '',
        percent: Math.max(0, Math.min(100, progress.percent)),
        bytesPerSecond: progress.bytesPerSecond,
      });
    });
    updater.on('update-downloaded', (info) =>
      this.#set({ phase: 'downloaded', version: info.version }),
    );
    updater.on('error', (error) => this.#onUpdaterError(error));
  }

  get state(): UpdateState {
    return this.#state;
  }

  onState(listener: (state: UpdateState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** 启动定时检查。 */
  start(): void {
    if (this.#state.phase === 'disabled') return;
    this.#schedule(this.#options.firstCheckMs ?? 30_000);
  }

  stop(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /**
   * 唤醒或回到前台时调用：上次检查已过去 `staleAfterMs` 以上就马上补查，并从现在重新计时。睡眠时计时器不走（macOS 的单调
   * 时钟睡眠时停住），只靠定时检查的话，常合盖的机器要隔很久才查到。第一次检查之前不补查（启动后的 30 s 延迟照旧）。
   */
  checkIfStale(): void {
    if (this.#timer === undefined) return;
    const { lastCheckedAt } = this.#state;
    if (lastCheckedAt === undefined) return;
    const staleAfterMs = this.#options.staleAfterMs ?? 15 * 60 * 1000;
    if (this.#now() - Date.parse(lastCheckedAt) < staleAfterMs) return;
    this.#schedule(0);
  }

  /** 检查更新。下载中、已下载或正在安装时不做（不打断）。每次从头来：之前失败过的线路重新参加竞速。 */
  check(): Promise<void> {
    const { phase } = this.#state;
    if (
      phase === 'disabled' ||
      phase === 'downloading' ||
      phase === 'downloaded' ||
      phase === 'installing'
    ) {
      return Promise.resolve();
    }
    if (this.#checking === undefined) this.#retried = false;
    this.#checking ??= this.#runCheck().finally(() => {
      this.#checking = undefined;
    });
    return this.#checking;
  }

  /** 下载已发现的版本（只在 `available` 时）。下载失败后先重新检查，再下载。 */
  async download(): Promise<void> {
    if (this.#state.phase !== 'available') return;
    const { version } = this.#state;
    this.#set({ phase: 'downloading', version, percent: 0, bytesPerSecond: 0 });
    try {
      await this.#options.updater.downloadUpdate();
    } catch (error) {
      this.#onUpdaterError(error as Error);
    }
  }

  install(): void {
    if (this.#state.phase !== 'downloaded') return;
    this.#set({ phase: 'installing', version: this.#state.version });
    this.#options.log('info', 'installing update', { version: this.#state.version });
    try {
      // macOS 的 Squirrel 在应用退出后替换并重新打开；Windows 静默运行 NSIS 安装程序，装完重新打开。
      this.#options.updater.quitAndInstall(true, true);
    } catch (error) {
      this.#set({ phase: 'error', code: 'install', detail: (error as Error).message });
    }
  }

  async setChannel(channel: UpdateChannel): Promise<void> {
    if (channel === this.#state.channel) return;
    this.#options.writePrefs({ ...this.#options.readPrefs(), channel });
    this.#state = { ...this.#state, channel };
    if (this.#state.phase === 'disabled') {
      this.#emit();
      return;
    }
    // 已发现但还没下载的版本可能不属于新通道，重新检查。
    if (
      this.#state.phase === 'available' ||
      this.#state.phase === 'latest' ||
      this.#state.phase === 'error'
    ) {
      this.#set({ phase: 'idle' });
    } else {
      this.#emit();
    }
    await this.check();
  }

  /** FeedSource：provider 每次检查时来要结果（feed.ts 的竞速、验签与测速）。 */
  async latest(): Promise<MirrorManifest> {
    const { mirrors, platform, arch, publicKeys, fetcher } = this.#options;
    const usable = mirrors.filter((mirror) => !this.#failedMirrors.has(mirror.id));
    const candidates = usable.length > 0 ? usable : mirrors;
    const { first, rest } = await raceMirrors({
      mirrors: candidates,
      timeoutMs: this.#options.checkTimeoutMs ?? 15_000,
      read: (mirror, signal) =>
        readMirror({
          mirror,
          channel: this.#state.channel,
          platform,
          arch,
          publicKeys,
          fetcher,
          signal,
          ...(this.#options.now !== undefined && { now: this.#options.now }),
        }),
    });
    let chosen = first;
    if (compare(first.info.version, this.#options.currentVersion) > 0) {
      // 有新版本：等其他线路的结果，在给出同一版本的线路之间测速。
      const others = await rest;
      const same = [first, ...others.filter((other) => other.info.version === first.info.version)];
      const picked = await pickDownloadMirror({
        candidates: same,
        file: (candidate) => candidate.baseUrl + installerFile(candidate.info, platform),
        fetcher,
        timeoutMs: this.#options.probeTimeoutMs ?? 8_000,
        ...(this.#options.now !== undefined && { now: this.#options.now }),
      });
      chosen = picked.chosen;
      this.#options.log('info', 'update mirror chosen', {
        version: first.info.version,
        mirror: chosen.mirror.id,
        latencyMs: Object.fromEntries(same.map((c) => [c.mirror.id, c.latencyMs])),
        bytesPerMs: Object.fromEntries(picked.bytesPerMs),
      });
    }
    this.#chosen = chosen;
    this.#state = { ...this.#state, mirror: { id: chosen.mirror.id, latencyMs: chosen.latencyMs } };
    return chosen;
  }

  async #runCheck(): Promise<void> {
    this.#set({ phase: 'checking' });
    try {
      await this.#options.updater.checkForUpdates();
    } catch (error) {
      this.#onUpdaterError(error as Error);
    } finally {
      this.#state = { ...this.#state, lastCheckedAt: new Date(this.#now()).toISOString() };
      this.#emit();
    }
  }

  #onUpdaterError(error: Error): void {
    const phase = this.#state.phase;
    const version = 'version' in this.#state ? this.#state.version : undefined;
    if (phase === 'downloading' && this.#chosen !== undefined && !this.#retried) {
      // 下载失败：这条线路记为失败，重新检查（换到另一条），再下载一次。
      this.#retried = true;
      this.#failedMirrors.add(this.#chosen.mirror.id);
      this.#options.log('warn', 'update download failed; retrying on another mirror', {
        mirror: this.#chosen.mirror.id,
        error: error.message,
      });
      void this.#retryDownload();
      return;
    }
    if (phase === 'checking' && error instanceof UpdateFeedError && error.empty) {
      this.#options.log('info', 'no release published on this channel yet', {
        error: error.message,
      });
      this.#set({ phase: 'latest' });
      return;
    }
    const code: UpdateErrorCode =
      error instanceof UpdateFeedError
        ? error.tampered
          ? 'signature'
          : 'unreachable'
        : phase === 'downloading'
          ? 'download'
          : phase === 'installing'
            ? 'install'
            : phase === 'checking'
              ? 'unreachable'
              : 'internal';
    this.#options.log('error', 'update failed', { code, error: error.message });
    this.#set({
      phase: 'error',
      code,
      detail: error.message,
      ...(version !== undefined && phase !== 'checking' && { version }),
    });
  }

  async #retryDownload(): Promise<void> {
    this.#set({ phase: 'checking' });
    try {
      await this.#options.updater.checkForUpdates();
      if (this.#state.phase === 'available') await this.download();
    } catch (error) {
      this.#onUpdaterError(error as Error);
    }
  }

  #schedule(delayMs: number): void {
    this.stop();
    this.#timer = setTimeout(() => {
      void this.check().finally(() => this.#schedule(this.#options.intervalMs ?? 60 * 60 * 1000));
    }, delayMs);
    this.#timer.unref?.();
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  #set(phase: UpdatePhase): void {
    const { currentVersion, channel, lastCheckedAt, mirror } = this.#state;
    // 新的一轮检查从头开始：清掉上一轮的线路失败记录。
    if (phase.phase === 'checking' && !this.#retried) this.#failedMirrors.clear();
    if (phase.phase === 'downloaded' || phase.phase === 'latest') this.#retried = false;
    this.#state = {
      ...phase,
      currentVersion,
      channel,
      ...(lastCheckedAt !== undefined && { lastCheckedAt }),
      ...(mirror !== undefined && { mirror }),
    };
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener(this.#state);
  }
}
