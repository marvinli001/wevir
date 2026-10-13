// 桌面主进程里 Host 的发现、拉起、重新拉起与停止（ADR-0002 §6、补记 3，Paseo A17）。不依赖 Electron，单独可测。
//
// - 先读 run/host.json 并探活（连接 + hello）：Host 在运行就附着，退出时不停它。
// - 否则用开发者本机的 Node 以子进程启动 wevir-host，带归属管道参数 --exit-on-stdin-eof 并持有其 stdin，
//   等 stdout 的就绪行或 host.json 出现 url，记下 {pid, startedAt}，视为拥有。退出码 3 说明有别的 Host
//   抢先占住了数据目录，改为等它就绪后附着。
// - 拥有的 Host 意外退出（T5.5）：按 host.json 的 {pid, startedAt} 确认旧进程已退出后重新拉起，最多 3 次；
//   这期间别人启动了 Host 就附着它。都失败了进入 failed，界面显示原因与日志路径，可以手动重试。
// - 附着的 Host 不在了（T5.5）：不替它拉起，等 host.json 出现新的地址再附着。
// - 退出时只停自己拉起的 Host：先关归属管道，超时再 host.shutdown，仍不退出才强制结束。

import { type ChildProcess, spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  type HostEndpoint,
  type HostHello,
  WevirClient,
  webSocketTransport,
} from '@wevir/client-sdk';
import { readHostEndpoint } from '@wevir/client-sdk/node';
import {
  EXIT_CODE,
  HOME_LAYOUT,
  type HostRuntimeInfo,
  isProcessAlive,
  LOG_FILE,
  parseRuntimeInfo,
  RUNTIME_FILE,
} from '@wevir/host/runtime';
import type { ClientIdentity } from '@wevir/protocol';
import {
  type HostOwnership,
  type HostProcessStatus,
  MAX_HOST_RESTARTS,
} from '../shared/desktop-api.js';

export type { HostOwnership, HostProcessStatus } from '../shared/desktop-api.js';

export interface HostReady {
  ownership: HostOwnership;
  hello: HostHello;
}

export interface HostLifecycleTimeouts {
  /** 探活（连接 + hello）的上限。 */
  probeMs: number;
  /** 拉起后等就绪、或退出码 3 之后等已有 Host 写出 url 的上限。 */
  startMs: number;
  /** 关闭归属管道后等 Host 自己退出的时间；超过就发 `host.shutdown`。 */
  pipeCloseMs: number;
  /** 发出 `host.shutdown` 后再等的时间（Host 自己的优雅退出上限是 10 s）；超过就强制结束。 */
  shutdownMs: number;
  /**
   * 拥有的 Host 意外退出后，第 n 次重新拉起之前等待的时间（T5.5）。长度就是最多重试的次数
   * （`MAX_HOST_RESTARTS`）。
   */
  restartDelaysMs: readonly number[];
  /** 重新拉起的 Host 连续运行这么久之后，重试次数清零：隔很久的偶发崩溃不会耗尽次数。 */
  stableMs: number;
  /** 重新拉起之前，host.json 仍记着旧进程时，等它退出的上限。 */
  exitConfirmMs: number;
  /** 附着时检查 Host 进程是否还在、等它回来时重读 host.json 的间隔。 */
  watchMs: number;
}

export const DEFAULT_HOST_LIFECYCLE_TIMEOUTS: HostLifecycleTimeouts = {
  probeMs: 3000,
  startMs: 30_000,
  pipeCloseMs: 5000,
  shutdownMs: 12_000,
  restartDelaysMs: [1000, 2000, 4000],
  stableMs: 60_000,
  exitConfirmMs: 5000,
  watchMs: 1000,
};

export type LogLevel = 'info' | 'warn' | 'error';
export type Log = (level: LogLevel, message: string, detail?: Record<string, unknown>) => void;

export interface HostLifecycleOptions {
  /** Host 的数据目录（绝对路径），与 wevir-host 的解析规则相同（`resolveHome`）。 */
  home: string;
  /** 探活与 `host.shutdown` 时 hello 用的身份。 */
  identity: ClientIdentity;
  /** 启动 Host 的 Node 可执行文件：开发者本机的 Node，不是 Electron（ADR-0002 §6“运行时”）。 */
  nodePath: string;
  /** wevir-host 的入口（`@wevir/host` 的 `bin['wevir-host']`，见 `resolveHostEntry`）。 */
  hostEntry: string;
  /** 追加给 wevir-host 的参数，例如测试用的 `--adapter echo`。 */
  hostArgs?: readonly string[];
  /** Host 子进程的环境，默认 `hostEnvironment(process.env)`。 */
  env?: NodeJS.ProcessEnv;
  timeouts?: Partial<HostLifecycleTimeouts>;
  log?: Log;
}

/** 拉起的子进程在就绪前退出、超时，或 Host 不可用。`message` 是给人看的中文说明。 */
export class HostStartError extends Error {
  override readonly name = 'HostStartError';
}

const STDERR_TAIL_LIMIT = 4096;
const POLL_INTERVAL_MS = 100;

interface OwnedChild {
  process: ChildProcess;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  hasExited: () => boolean;
  stderrTail: () => string;
}

export class HostLifecycle {
  readonly #options: HostLifecycleOptions;
  readonly #timeouts: HostLifecycleTimeouts;
  readonly #log: Log;
  /** 首次附着或拉起。 */
  #initial: Promise<HostReady> | undefined;
  /** 首次之后正在进行的重新拉起、等外部 Host 回来或手动重试。 */
  #recovery: Promise<void> | undefined;
  #stopping: Promise<void> | undefined;
  /** 退出时中止重新拉起的等待与附着的检查。 */
  readonly #shutdown = new AbortController();
  #ready: HostReady | undefined;
  #readyAt = 0;
  /** 自上次稳定运行以来重新拉起的次数。 */
  #restarts = 0;
  #status: HostProcessStatus = { phase: 'starting' };
  readonly #listeners = new Set<(status: HostProcessStatus) => void>();
  #watchTimer: ReturnType<typeof setInterval> | undefined;
  /** 最近一次拉起的子进程（含就绪前、退出码 3 的那个）。 */
  #child: OwnedChild | undefined;

  constructor(options: HostLifecycleOptions) {
    this.#options = options;
    this.#timeouts = { ...DEFAULT_HOST_LIFECYCLE_TIMEOUTS, ...options.timeouts };
    this.#log = options.log ?? (() => {});
  }

  get ownership(): HostOwnership | undefined {
    return this.#ready?.ownership;
  }

  get status(): HostProcessStatus {
    return this.#status;
  }

  /** Host 的结构化日志（`<数据目录>/logs/host.log`），起不来时告诉用户去看它。 */
  get logPath(): string {
    return join(this.#options.home, HOME_LAYOUT.logsDir, LOG_FILE);
  }

  /** 订阅 Host 进程状态的变化，返回取消订阅的函数。 */
  onStatus(listener: (status: HostProcessStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * 首次附着到已有的 Host，或拉起一个。只尝试一次，重复调用返回同一个 Promise（失败也一样）；之后 Host 意外
   * 退出、附着的 Host 不在了由生命周期自己处理，失败后的重试走 `retry()`。
   */
  start(): Promise<HostReady> {
    if (this.#stopping) return Promise.reject(new HostStartError('桌面端正在退出'));
    if (!this.#initial) {
      this.#initial = this.#start();
      this.#initial.then(
        (ready) => this.#becomeReady(ready),
        (error: unknown) => this.#fail(error),
      );
    }
    return this.#initial;
  }

  /**
   * Host 起不来（`failed`）之后手动重试：重试次数清零，重新附着或拉起。其他状态下什么也不做（附着的 Host
   * 不在了只等它回来，不替它拉起）。
   */
  retry(): Promise<void> {
    if (this.#stopping || this.#status.phase !== 'failed' || this.#recovery) {
      return this.#recovery ?? Promise.resolve();
    }
    this.#restarts = 0;
    this.#setStatus({ phase: 'starting' });
    return this.#runRecovery(async () => {
      try {
        this.#becomeReady(await this.#start());
      } catch (error) {
        this.#fail(error);
      }
    });
  }

  /**
   * 渲染进程连接用的端点：首次等 Host 就绪；之后重读 `run/host.json`，所以 Host 被重新拉起或附着的 Host 被别人
   * 重启（换了端口与令牌）之后也能拿到新的（ADR-0002 补记 4）。正在重新拉起或起不来时 reject：client-sdk
   * 按退避重试，界面收到 `running` 后立即重连。
   */
  async endpoint(): Promise<HostEndpoint> {
    await this.start().catch(() => {});
    const status = this.#status;
    switch (status.phase) {
      case 'failed':
        throw new HostStartError(status.error);
      case 'starting':
      case 'restarting':
        throw new HostStartError('Host 正在重新启动');
      case 'running':
      case 'waiting':
        // waiting 时 host.json 可能已经回来、只是还没轮到检查，照读；没有就 reject。
        return readHostEndpoint(this.#options.home);
    }
  }

  /**
   * 退出时调用：只停止本次拉起的 Host（含还没就绪的）；附着的 Host 不动。先关归属管道（Host 读到 EOF
   * 即优雅退出），`pipeCloseMs` 内没退出就确认 host.json 仍是它之后发 `host.shutdown`，再过
   * `shutdownMs` 仍没退出才 SIGKILL。可重复调用。
   */
  stop(): Promise<void> {
    this.#stopping ??= this.#stop();
    return this.#stopping;
  }

  // ── 状态 ────────────────────────────────────────────────────────────

  #setStatus(status: HostProcessStatus): void {
    this.#status = status;
    for (const listener of [...this.#listeners]) {
      try {
        listener(status);
      } catch (error) {
        this.#log('warn', 'a host status listener threw', { error: describe(error) });
      }
    }
  }

  #becomeReady(ready: HostReady): void {
    this.#ready = ready;
    this.#readyAt = performance.now();
    // 退出期间就绪的（重新拉起刚好完成）：记下归属给 stop 用，不再报状态、不开始检查。
    if (this.#stopping) return;
    this.#log('info', `host ${ready.ownership.kind}`, {
      pid: ready.ownership.pid,
      startedAt: ready.ownership.startedAt,
      hostVersion: ready.hello.hostVersion,
      protocolVersion: ready.hello.protocolVersion,
    });
    this.#setStatus({ phase: 'running', ownership: ready.ownership });
    if (ready.ownership.kind === 'attached') this.#watchAttached(ready.ownership);
  }

  #fail(error: unknown): void {
    this.#ready = undefined;
    if (this.#stopping) return;
    const message = describe(error);
    this.#log('error', 'host unavailable', { error: message, logPath: this.logPath });
    this.#setStatus({ phase: 'failed', error: message, logPath: this.logPath });
  }

  #runRecovery(task: () => Promise<void>): Promise<void> {
    const run = task().finally(() => {
      if (this.#recovery === run) this.#recovery = undefined;
    });
    this.#recovery = run;
    return run;
  }

  // ── 意外退出与重新拉起（T5.5） ──────────────────────────────────────

  /** 拥有的 Host 在就绪之后退出了，而不是本端要它退出。 */
  #onOwnedExit(
    ownership: HostOwnership,
    child: OwnedChild,
    exit: { code: number | null; signal: NodeJS.Signals | null },
  ): void {
    const reason = exit.code === null ? `信号 ${exit.signal}` : `退出码 ${exit.code}`;
    this.#log('error', 'owned host exited unexpectedly', {
      pid: ownership.pid,
      code: exit.code,
      signal: exit.signal,
      stderr: child.stderrTail(),
    });
    this.#ready = undefined;
    if (performance.now() - this.#readyAt >= this.#timeouts.stableMs) this.#restarts = 0;
    void this.#runRecovery(() => this.#restartLoop(ownership, `Host 意外退出（${reason}）`));
  }

  async #restartLoop(previous: HostOwnership, firstReason: string): Promise<void> {
    const delays = this.#timeouts.restartDelaysMs;
    const maxAttempts = Math.min(delays.length, MAX_HOST_RESTARTS);
    let reason = firstReason;
    while (this.#restarts < maxAttempts) {
      const attempt = ++this.#restarts;
      this.#setStatus({ phase: 'restarting', attempt, maxAttempts, reason });
      try {
        await sleep(delays[attempt - 1] ?? 0, undefined, { signal: this.#shutdown.signal });
      } catch {
        return; // 桌面端在退出。
      }
      try {
        this.#log('info', 'restarting host', { attempt, maxAttempts });
        this.#becomeReady(await this.#relaunch(previous));
        return;
      } catch (error) {
        if (this.#stopping) return;
        reason = describe(error);
        this.#log('warn', 'host restart failed', { attempt, error: reason });
      }
    }
    this.#fail(
      new HostStartError(`${firstReason}，重新拉起 ${maxAttempts} 次都没有成功：${reason}`),
    );
  }

  /**
   * 重新拉起之前按 host.json 的 `{pid, startedAt}` 确认旧进程已退出（Paseo A17）：仍记着旧进程就等它退出（超时
   * 报错，不会同时跑两个 Host），新 Host 会把这份陈旧的 host.json 换掉。host.json 已经是别人的 Host（这期间
   * `wevir host start` 等）就附着它；没有 host.json 就拉起。
   */
  async #relaunch(previous: HostOwnership): Promise<HostReady> {
    const info = await this.#readRuntimeInfo();
    if (info?.pid === previous.pid && info.startedAt === previous.startedAt) {
      const deadline = performance.now() + this.#timeouts.exitConfirmMs;
      while (isProcessAlive(info.pid)) {
        if (performance.now() >= deadline) {
          throw new HostStartError(`旧的 Host 进程（pid ${info.pid}）还没有退出`);
        }
        await sleep(POLL_INTERVAL_MS, undefined, { signal: this.#shutdown.signal });
      }
      this.#log('info', 'the previous host has exited; launching a new one', { pid: info.pid });
      return this.#launch();
    }
    return this.#start();
  }

  // ── 附着的 Host（T5.5） ──────────────────────────────────────────────

  /** 定时检查附着的 Host 进程还在不在；不在了就进入 waiting，等 host.json 出现新的地址。 */
  #watchAttached(ownership: HostOwnership): void {
    clearInterval(this.#watchTimer);
    this.#watchTimer = setInterval(() => {
      if (this.#stopping || this.#ready?.ownership !== ownership) {
        clearInterval(this.#watchTimer);
        return;
      }
      if (isProcessAlive(ownership.pid)) return;
      clearInterval(this.#watchTimer);
      this.#log('warn', 'attached host is gone; waiting for it to come back', {
        pid: ownership.pid,
      });
      this.#ready = undefined;
      this.#setStatus({ phase: 'waiting', pid: ownership.pid });
      void this.#runRecovery(() => this.#waitForHost(ownership));
    }, this.#timeouts.watchMs);
    this.#watchTimer.unref?.();
  }

  /** 等 host.json 出现一个活着、能 hello 的 Host（不是刚消失的那个），附着它。不限时，直到桌面端退出。 */
  async #waitForHost(gone: HostOwnership): Promise<void> {
    const { signal } = this.#shutdown;
    while (!signal.aborted) {
      try {
        await sleep(this.#timeouts.watchMs, undefined, { signal });
      } catch {
        return;
      }
      const info = await this.#readRuntimeInfo();
      if (info?.url === undefined || info.pid === gone.pid || !isProcessAlive(info.pid)) continue;
      try {
        const hello = await this.#probe();
        this.#becomeReady({
          ownership: { kind: 'attached', pid: info.pid, startedAt: info.startedAt },
          hello,
        });
        return;
      } catch (error) {
        this.#log('warn', 'a host is back in host.json but did not answer yet', {
          pid: info.pid,
          error: describe(error),
        });
      }
    }
  }

  // ── 附着与拉起 ──────────────────────────────────────────────────────

  async #start(): Promise<HostReady> {
    const attached = await this.#tryAttach();
    if (attached) return attached;
    return this.#launch();
  }

  /** host.json 里有地址且探活成功就附着；没有文件、正在启动、探活失败都返回 undefined。 */
  async #tryAttach(): Promise<HostReady | undefined> {
    const info = await this.#readRuntimeInfo();
    if (info?.url === undefined) return undefined;
    try {
      const hello = await this.#probe();
      return { ownership: { kind: 'attached', pid: info.pid, startedAt: info.startedAt }, hello };
    } catch (error) {
      this.#log('warn', 'host.json has a url but the host did not answer; launching one', {
        pid: info.pid,
        error: describe(error),
      });
      return undefined;
    }
  }

  async #launch(): Promise<HostReady> {
    const { home, nodePath, hostEntry } = this.#options;
    const args = [
      hostEntry,
      '--home',
      home,
      '--exit-on-stdin-eof',
      ...(this.#options.hostArgs ?? []),
    ];
    this.#log('info', 'launching host', { node: nodePath, args });
    const child = this.#spawn(nodePath, args);
    const deadline = performance.now() + this.#timeouts.startMs;

    const outcome = await Promise.race([
      this.#waitReady(child, deadline).then((info) => ({ kind: 'ready' as const, info })),
      child.exited.then((exit) => ({ kind: 'exited' as const, exit })),
    ]);

    if (outcome.kind === 'exited') {
      const { code, signal } = outcome.exit;
      if (code === EXIT_CODE.alreadyRunning) {
        // 别的 Host（例如同时运行的 wevir host start）先占住了数据目录：等它写出地址后附着。
        this.#log('info', 'another host owns the data directory; waiting to attach');
        return this.#waitAttach(deadline);
      }
      throw new HostStartError(
        `Host 启动失败（${code === null ? `信号 ${signal}` : `退出码 ${code}`}）` +
          (child.stderrTail() ? `：${child.stderrTail()}` : ''),
      );
    }
    if (outcome.info === undefined) {
      this.#log('error', 'host did not become ready in time; stopping it', {
        timeoutMs: this.#timeouts.startMs,
      });
      await this.#terminate(child);
      throw new HostStartError(`Host 在 ${this.#timeouts.startMs / 1000} 秒内没有就绪`);
    }
    const hello = await this.#probe();
    return {
      ownership: { kind: 'owned', pid: outcome.info.pid, startedAt: outcome.info.startedAt },
      hello,
    };
  }

  #spawn(nodePath: string, args: string[]): OwnedChild {
    const proc = spawn(nodePath, args, {
      // stdin 是归属管道：本进程退出或崩溃时操作系统关闭它，Host 读到 EOF 即优雅退出。
      stdio: ['pipe', 'pipe', 'pipe'],
      // wevir-host 的数据目录 WEVIR_HOME 优先于 --home：两处都给同一个值，继承来的 WEVIR_HOME 不会让它
      // 用到别的目录。
      env: {
        ...(this.#options.env ?? hostEnvironment(process.env)),
        WEVIR_HOME: this.#options.home,
      },
      windowsHide: true,
    });
    let exitInfo: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let stderr = '';
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolveExit) => {
        proc.once('exit', (code, signal) => {
          exitInfo = { code, signal };
          resolveExit(exitInfo);
        });
        proc.once('error', (error) => {
          // 多半是 Node 可执行文件不存在（ENOENT）；不会再有 exit 事件。
          stderr = `无法启动 ${nodePath}：${error.message}`;
          exitInfo = { code: null, signal: null };
          resolveExit(exitInfo);
        });
      },
    );
    // Host 退出后再写 stdin 会 EPIPE；归属管道只用来传 EOF，写失败无关紧要。
    proc.stdin?.on('error', () => {});
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-STDERR_TAIL_LIMIT);
    });
    const child: OwnedChild = {
      process: proc,
      exited,
      hasExited: () => exitInfo !== undefined,
      stderrTail: () => stderr.trim(),
    };
    void exited.then((exit) => {
      // 就绪之前的退出由 #launch 处理；这里只管已经就绪、视为拥有的那个子进程。
      const ownership = this.#ready?.ownership;
      if (
        this.#stopping ||
        this.#child !== child ||
        ownership?.kind !== 'owned' ||
        ownership.pid !== proc.pid
      ) {
        return;
      }
      this.#onOwnedExit(ownership, child, exit);
    });
    this.#child = child;
    return child;
  }

  /**
   * 等就绪：stdout 的 `{"event":"ready",…}` 行或 host.json 出现 `url`，以先到者为准，再从 host.json 读出
   * `{pid, startedAt}`（必须是这个子进程）。超时返回 undefined。
   */
  async #waitReady(child: OwnedChild, deadline: number): Promise<HostRuntimeInfo | undefined> {
    // 轮询 host.json；收到就绪行时立即重读，不等下一轮。Host 先原子替换 host.json 再写就绪行（T2.5）。
    let wake: (() => void) | undefined;
    const stdout = child.process.stdout;
    if (stdout) {
      // 就绪行之后 Host 不再写 stdout，但仍读到底，避免管道写满。
      createInterface({ input: stdout }).on('line', (line) => {
        try {
          const value = JSON.parse(line) as { event?: unknown; pid?: unknown };
          if (value.event === 'ready' && value.pid === child.process.pid) wake?.();
        } catch {
          // 不是 JSON 的行忽略。
        }
      });
    }
    while (performance.now() < deadline && !child.hasExited()) {
      const info = await this.#readRuntimeInfo();
      if (info?.url !== undefined && info.pid === child.process.pid) return info;
      await new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, POLL_INTERVAL_MS);
        wake = () => {
          clearTimeout(timer);
          resolveWait();
        };
      });
      wake = undefined;
    }
    return undefined;
  }

  /** 退出码 3 之后：等 host.json 出现地址并探活成功。 */
  async #waitAttach(deadline: number): Promise<HostReady> {
    let lastError: unknown;
    while (performance.now() < deadline) {
      const info = await this.#readRuntimeInfo();
      if (info?.url !== undefined) {
        try {
          const hello = await this.#probe();
          return {
            ownership: { kind: 'attached', pid: info.pid, startedAt: info.startedAt },
            hello,
          };
        } catch (error) {
          lastError = error;
        }
      }
      await sleep(POLL_INTERVAL_MS);
    }
    throw new HostStartError(
      '数据目录已有 Host 在运行，但它没有就绪' +
        (lastError === undefined ? '' : `：${describe(lastError)}`),
    );
  }

  /** 连接 + hello 后立即断开。 */
  async #probe(): Promise<HostHello> {
    const client = await WevirClient.connect({
      endpoint: () => readHostEndpoint(this.#options.home),
      transport: webSocketTransport(WebSocket),
      identity: this.#options.identity,
      timeouts: { connectMs: this.#timeouts.probeMs },
    });
    try {
      return client.hello;
    } finally {
      client.close();
    }
  }

  async #stop(): Promise<void> {
    this.#shutdown.abort();
    clearInterval(this.#watchTimer);
    // 启动或重新拉起还在进行时先等它结束（成功或失败），才知道子进程与归属。
    await this.#initial?.catch(() => {});
    await this.#recovery?.catch(() => {});
    const child = this.#child;
    if (!child || child.hasExited()) return;
    const ownership = this.#ready?.ownership;
    if (ownership?.kind === 'attached') return;

    this.#log('info', 'stopping owned host: closing the ownership pipe', {
      pid: child.process.pid,
    });
    child.process.stdin?.end();
    if (await exitsWithin(child, this.#timeouts.pipeCloseMs)) {
      this.#log('info', 'owned host exited', { pid: child.process.pid });
      return;
    }

    this.#log('warn', 'host did not exit after the pipe closed; requesting host.shutdown', {
      pid: child.process.pid,
      waitedMs: this.#timeouts.pipeCloseMs,
    });
    if (ownership && (await this.#isStillOurs(ownership))) {
      await this.#requestShutdown().catch((error: unknown) =>
        this.#log('warn', 'host.shutdown failed', { error: describe(error) }),
      );
    }
    if (await exitsWithin(child, this.#timeouts.shutdownMs)) {
      this.#log('info', 'owned host exited', { pid: child.process.pid });
      return;
    }
    this.#log('error', 'host did not exit after host.shutdown; killing it', {
      pid: child.process.pid,
    });
    await this.#terminate(child);
  }

  async #terminate(child: OwnedChild): Promise<void> {
    if (child.hasExited()) return;
    child.process.kill('SIGKILL');
    await child.exited;
  }

  /** host.json 的 `{pid, startedAt}` 仍是拉起时记下的那个（Paseo A17）。 */
  async #isStillOurs(ownership: HostOwnership): Promise<boolean> {
    const info = await this.#readRuntimeInfo();
    return info?.pid === ownership.pid && info.startedAt === ownership.startedAt;
  }

  async #requestShutdown(): Promise<void> {
    const client = await WevirClient.connect({
      endpoint: await readHostEndpoint(this.#options.home),
      transport: webSocketTransport(WebSocket),
      identity: this.#options.identity,
      timeouts: { connectMs: this.#timeouts.probeMs, requestMs: this.#timeouts.probeMs },
    });
    try {
      await client.request('host.shutdown', {});
    } finally {
      client.close();
    }
  }

  async #readRuntimeInfo(): Promise<HostRuntimeInfo | undefined> {
    const path = join(this.#options.home, HOME_LAYOUT.runDir, RUNTIME_FILE);
    try {
      return parseRuntimeInfo(await readFile(path, 'utf8'));
    } catch {
      return undefined;
    }
  }
}

async function exitsWithin(child: OwnedChild, ms: number): Promise<boolean> {
  if (child.hasExited()) return true;
  const timeout = new AbortController();
  const result = await Promise.race([
    child.exited.then(() => true),
    sleep(ms, false, { signal: timeout.signal }).catch(() => false),
  ]);
  timeout.abort();
  return result;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Host 子进程的环境：继承桌面的环境，去掉 Electron 与 electron-vite 的变量（例如
 * `ELECTRON_RUN_AS_NODE`、`ELECTRON_RENDERER_URL`），它们对 Node 上的 Host 没有意义。Host 给 dsh 的环境
 * 另有白名单（ADR-0001）。
 */
export function hostEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('ELECTRON_') || key === 'NODE_ENV_ELECTRON_VITE') continue;
    result[key] = value;
  }
  return result;
}

/**
 * 开发者本机的 Node：`WEVIR_NODE` 优先，否则在 `PATH` 里找 `node`（Windows 按 `PATHEXT`）。Electron 的
 * `process.execPath` 是 Electron 本身，不能直接用；打包后用哪个 Node 是 ADR-0002 未决事项 1。
 */
export function resolveNodeExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const override = env.WEVIR_NODE;
  if (override !== undefined && override !== '') return override;
  const names =
    platform === 'win32'
      ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM')
          .split(';')
          .filter(Boolean)
          .map((ext) => `node${ext.toLowerCase()}`)
      : ['node'];
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (dir === '') continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }
  throw new HostStartError(
    '在 PATH 里找不到 node。安装 Node ≥ 22.19，或用 WEVIR_NODE 指定它的路径',
  );
}

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== 'win32') accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** wevir-host 的入口：`@wevir/host` 的 `bin['wevir-host']`（指向 `dist/`，要先 `pnpm build`）。 */
export function resolveHostEntry(from: string | URL = import.meta.url): string {
  const require = createRequire(from);
  const manifestPath = require.resolve('@wevir/host/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin?: unknown };
  const bin = (manifest.bin as Record<string, unknown> | undefined)?.['wevir-host'];
  if (typeof bin !== 'string') throw new HostStartError(`${manifestPath} 里没有 bin.wevir-host`);
  const entry = resolve(dirname(manifestPath), bin);
  if (!existsSync(entry)) {
    throw new HostStartError(`找不到 Host 的可执行入口 ${entry}，先在仓库根目录运行 pnpm build`);
  }
  return entry;
}
