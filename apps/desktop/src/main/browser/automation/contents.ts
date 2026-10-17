// SPDX-License-Identifier: Apache-2.0
// 改写自 getpaseo/paseo packages/desktop/src/features/browser-automation/ipc.ts（adaptWebContents 与对话框、控制台的记录）
// 来源提交 dc7bc8db124e837ba909ffd3b4b20e16adaebe24
// Copyright (c) 2025-present Mohamed Boudra，Apache License 2.0
// 由 Wevir 修改：去掉 Paseo 的 ipcMain 处理与 <webview> 注册表（Wevir 的标签页是 WebContentsView，在 browser-host.ts 里登记），
// 只留把 Electron 的 webContents 适配成自动化用的 `TabContents` 这部分；控制台消息按 Electron 35 起的事件对象读。
// 0.46.0：对话框在标签页的整个生命期里都记（载入时、定时器里的也算，标签页的 `disableDialogs` 让 Chromium 不弹原生框、页面不被
// 卡住，CDP 仍报 Page.javascriptDialogOpening），没在命令期间报掉的留到这个标签页的下一个命令；prompt 的替身装进每个新文档；
// 网络记录改用 CDP 的 Network 域（方法、状态码、进行中与失败的请求，只留当前页面的）；控制台记录也只留当前页面的；页面要选本机
// 文件时拦下原生文件框（Page.setInterceptFileChooserDialog）并报出来；下载由 browser-host.ts 拦下后记到这里。

import type {
  BrowserConsoleEntry as BrowserAutomationConsoleLogEntry,
  BrowserEffects,
  BrowserNetworkEntry,
} from '@wevir/protocol';
import { CdpSessionQueue } from './cdp-session-queue.js';
import {
  type BrowserAutomationDialogEvent,
  dialogAcceptValue,
  handledDialogEvent,
  MAX_DIALOGS_PER_COMMAND,
  promptShimDrainScript,
  promptShimInstallScript,
} from './dialog-handling.js';
import type { TabContents, TabImage } from './service.js';
import { BrowserTabClosedError } from './service.js';
import type { IsolatedKeyboardInputEvent } from './trusted-input.js';

const MAX_CONSOLE_MESSAGES_PER_TAB = 200;
const MAX_NETWORK_ENTRIES_PER_TAB = 200;
/** 命令结束时读 prompt 替身的记录最多等多久：页面卡住时不拖住命令。 */
const PROMPT_DRAIN_TIMEOUT_MS = 1_000;
/** 对话框打开后还没关（没有 `disableDialogs` 的标签页）就用 CDP 回答它。 */
const DIALOG_FALLBACK_MS = 150;

const monitorsByContentsId = new Map<number, TabMonitor>();

interface WebContentsDebugger {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  sendCommand(command: string, params?: Record<string, unknown>): Promise<unknown>;
  on?(
    event: 'message',
    listener: (event: unknown, method: string, params?: Record<string, unknown>) => void,
  ): void;
  on?(event: 'detach', listener: () => void): void;
}

interface ConsoleMessageEmitter {
  // Electron 35 起参数在事件对象上（`level` 是 info / warning / error / debug），位置参数已弃用。
  on(
    event: 'console-message',
    listener: (event: {
      level?: unknown;
      message?: unknown;
      lineNumber?: unknown;
      sourceId?: unknown;
    }) => void,
  ): void;
  once(event: 'destroyed', listener: () => void): void;
}

interface BrowserAutomationWebContents extends ConsoleMessageEmitter {
  removeListener(event: 'destroyed', listener: () => void): void;
  readonly id: number;
  readonly debugger: WebContentsDebugger;
  getURL(): string;
  getTitle(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  isLoading(): boolean;
  isDestroyed(): boolean;
  executeJavaScript(code: string): Promise<unknown>;
  loadURL(url: string): Promise<void>;
  goBack(): void;
  goForward(): void;
  reload(): void;
  beginFrameSubscription(onlyDirty: boolean, callback: (image: TabImage) => void): void;
  endFrameSubscription(): void;
  invalidate(): void;
  getBackgroundThrottling(): boolean;
  setBackgroundThrottling(allowed: boolean): void;
  sendInputEvent(event: IsolatedKeyboardInputEvent): void;
  insertText(text: string): Promise<void>;
}

/** 命令期间（或上一个命令之后）发生、要在命令结果里报的事。 */
export interface CapturedTabEvents {
  dialogs: BrowserAutomationDialogEvent[];
  effects: Pick<BrowserEffects, 'downloads' | 'fileChooser'>;
}

export function adaptWebContents(contents: BrowserAutomationWebContents): TabContents {
  const monitor = monitorFor(contents);
  return {
    id: contents.id,
    getURL: () => contents.getURL(),
    getTitle: () => contents.getTitle(),
    canGoBack: () => contents.canGoBack(),
    canGoForward: () => contents.canGoForward(),
    isLoading: () => contents.isLoading(),
    isDestroyed: () => contents.isDestroyed(),
    executeJavaScript: (code: string) => contents.executeJavaScript(code),
    loadURL: (url: string) => contents.loadURL(url),
    goBack: () => contents.goBack(),
    goForward: () => contents.goForward(),
    reload: () => contents.reload(),
    captureFrame: (signal) => captureViewportFrame(contents, signal),
    invalidate: () => contents.invalidate(),
    withFrameProduction: async (capture) => {
      const previous = contents.getBackgroundThrottling();
      contents.setBackgroundThrottling(false);
      try {
        return await capture();
      } finally {
        if (!contents.isDestroyed()) contents.setBackgroundThrottling(previous);
      }
    },
    sendInputEvent: (event) => contents.sendInputEvent(event),
    insertText: (text) => contents.insertText(text),
    getConsoleMessages: () => monitor.console,
    getConsoleTotal: () => monitor.consoleTotal,
    getNetworkLog: () => monitor.networkLog(),
    openDialog: () => monitor.openDialog,
    captureDialogs: (task) => monitor.capture(task),
    sendDebugCommand: (command: string, params?: Record<string, unknown>) =>
      monitor.sendDebugCommand(command, params),
  };
}

/**
 * 开始看着一个标签页（建标签页时调一次，在第一次载入之前）：之后的对话框、控制台、网络请求、文件框都记下来。重复调用没有
 * 副作用。
 */
export function watchTab(contents: BrowserAutomationWebContents): void {
  monitorFor(contents);
}

/** 页面要离开时的 beforeunload（browser-host.ts 的 `will-prevent-unload`，已经让它离开）。 */
export function recordBeforeUnload(contentsId: number): void {
  monitorsByContentsId
    .get(contentsId)
    ?.record(handledDialogEvent({ type: 'beforeunload', message: '' }));
}

/** 页面开始的下载（browser-host.ts 已经取消）。 */
export function recordDownload(
  contentsId: number,
  download: { url: string; filename: string; state: string },
): void {
  monitorsByContentsId.get(contentsId)?.recordDownload(download);
}

/** 要不要拦下页面的选文件框：agent 在操作时拦下（不弹原生框，报给 agent），用户接手后放开。 */
export function interceptFileChooser(contentsId: number, enabled: boolean): void {
  monitorsByContentsId.get(contentsId)?.setFileChooserInterception(enabled);
}

function monitorFor(contents: BrowserAutomationWebContents): TabMonitor {
  const existing = monitorsByContentsId.get(contents.id);
  if (existing) return existing;
  const monitor = new TabMonitor(contents);
  monitorsByContentsId.set(contents.id, monitor);
  contents.once('destroyed', () => monitorsByContentsId.delete(contents.id));
  monitor.start();
  return monitor;
}

function captureViewportFrame(
  contents: BrowserAutomationWebContents,
  signal: AbortSignal,
): Promise<TabImage> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stop = () => {
      signal.removeEventListener('abort', abort);
      contents.removeListener('destroyed', destroyed);
      if (!contents.isDestroyed()) contents.endFrameSubscription();
    };
    const abort = () => {
      stop();
      reject(signal.reason);
    };
    const destroyed = () => {
      stop();
      reject(new BrowserTabClosedError());
    };
    signal.addEventListener('abort', abort, { once: true });
    contents.once('destroyed', destroyed);
    try {
      // A resized resident guest can paint while capturePage's surface-copy
      // request remains pending. Subscribe to its rendered frames instead.
      contents.beginFrameSubscription(false, (image) => {
        stop();
        resolve(image);
      });
    } catch (error) {
      stop();
      reject(error);
    }
  });
}

interface NetworkRecord {
  requestId: string;
  loaderId: string;
  url: string;
  method: string;
  type?: string;
  /** CDP 的单调时钟（秒）。 */
  start: number;
  end?: number;
  status?: number;
  transferSize?: number;
  failed?: string;
}

/** 一个标签页的记录：对话框、控制台、网络、下载与选文件框。 */
class TabMonitor {
  console: BrowserAutomationConsoleLogEntry[] = [];
  consoleTotal = 0;
  /** 打开了、还没关的对话框（标签页没有 `disableDialogs` 时会卡住页面）。 */
  openDialog: { type: string; message: string } | undefined;
  readonly #queue = new CdpSessionQueue();
  #dialogs: BrowserAutomationDialogEvent[] = [];
  #downloads: NonNullable<BrowserEffects['downloads']> = [];
  #fileChooser: BrowserEffects['fileChooser'];
  #network: NetworkRecord[] = [];
  #networkTotal = 0;
  /** 当前页面的第一个请求的时间（CDP 时钟），网络记录的 `startTime` 从它算起。 */
  #pageStart: number | undefined;
  #interceptFileChooser = true;
  #enabled = false;

  constructor(private readonly contents: BrowserAutomationWebContents) {}

  start(): void {
    this.contents.on('console-message', (event) => {
      this.console.push(
        normalizeConsoleMessage({
          level: event.level,
          message: event.message,
          line: event.lineNumber,
          sourceId: event.sourceId,
        }),
      );
      this.consoleTotal += 1;
      if (this.console.length > MAX_CONSOLE_MESSAGES_PER_TAB) {
        this.console = this.console.slice(-MAX_CONSOLE_MESSAGES_PER_TAB);
      }
    });
    if (this.contents.debugger.on) {
      this.contents.debugger.on('message', (_event, method, params) =>
        this.#onCdpEvent(method, params ?? {}),
      );
      this.contents.debugger.on('detach', () => {
        this.#enabled = false;
      });
    }
    void this.#enable();
  }

  /** 打开 Page 与 Network 域、装上 prompt 的替身。标签页还没载入任何东西时这些命令要等到第一次载入才回答，所以不等它们。 */
  async #enable(): Promise<void> {
    if (this.#enabled || this.contents.isDestroyed() || !this.contents.debugger.on) return;
    this.#enabled = true;
    const commands: Array<[string, Record<string, unknown>?]> = [
      ['Page.enable'],
      ['Page.addScriptToEvaluateOnNewDocument', { source: promptShimInstallScript() }],
      ['Page.setInterceptFileChooserDialog', { enabled: this.#interceptFileChooser }],
      // 不要响应体：只记请求本身。
      ['Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0 }],
    ];
    await Promise.all(
      commands.map(([command, params]) =>
        this.#send(command, params).catch(() => {
          // 标签页正在关，或调试器被别人占了：之后的命令照常执行，只是少了这项记录。
        }),
      ),
    );
    // 已经载入的页面：现在就装上替身（新文档由上面的脚本装）。
    await this.#send('Runtime.evaluate', {
      expression: promptShimInstallScript(),
      returnByValue: true,
    }).catch(() => {});
  }

  /** 走这个标签页的 CDP 队列。 */
  sendDebugCommand(command: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.#enabled) void this.#enable();
    return this.#queue.run(() => this.#send(command, params));
  }

  #send(command: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.contents.debugger.isAttached()) this.contents.debugger.attach('1.3');
    return this.contents.debugger.sendCommand(command, params ?? {});
  }

  /**
   * 执行一个命令，带上这期间（以及上一个命令之后）页面弹出的对话框、开始的下载、要选文件的请求。对话框照旧在发生时就处理掉，
   * 这里只是把记录交给命令的结果。
   */
  async capture<T>(task: () => Promise<T>): Promise<{ result: T } & CapturedTabEvents> {
    if (!this.#enabled) void this.#enable();
    const result = await task();
    this.#recordAll(await this.#drainPromptShim());
    return { result, ...this.#take() };
  }

  record(dialog: BrowserAutomationDialogEvent): void {
    this.#recordAll([dialog]);
  }

  recordDownload(download: { url: string; filename: string; state: string }): void {
    if (this.#downloads.length < MAX_DIALOGS_PER_COMMAND) this.#downloads.push(download);
  }

  setFileChooserInterception(enabled: boolean): void {
    if (this.#interceptFileChooser === enabled) return;
    this.#interceptFileChooser = enabled;
    if (this.#enabled) {
      void this.#send('Page.setInterceptFileChooserDialog', { enabled }).catch(() => {});
    }
  }

  networkLog(): { entries: BrowserNetworkEntry[]; total: number } {
    const base = this.#pageStart ?? this.#network[0]?.start ?? 0;
    return {
      total: this.#networkTotal,
      entries: this.#network.map((record) => ({
        url: withoutFragment(record.url),
        method: record.method,
        ...(record.status !== undefined && { status: record.status }),
        ...(record.type !== undefined && { type: record.type }),
        startTime: Math.max(0, (record.start - base) * 1000),
        duration: record.end === undefined ? 0 : Math.max(0, (record.end - record.start) * 1000),
        ...(record.transferSize !== undefined && { transferSize: record.transferSize }),
        ...(record.end === undefined && { pending: true }),
        ...(record.failed !== undefined && { failed: record.failed }),
      })),
    };
  }

  #take(): CapturedTabEvents {
    const dialogs = this.#dialogs;
    const downloads = this.#downloads;
    const fileChooser = this.#fileChooser;
    this.#dialogs = [];
    this.#downloads = [];
    this.#fileChooser = undefined;
    return {
      dialogs,
      effects: {
        ...(downloads.length > 0 && { downloads }),
        ...(fileChooser !== undefined && { fileChooser }),
      },
    };
  }

  #recordAll(dialogs: BrowserAutomationDialogEvent[]): void {
    for (const dialog of dialogs) {
      if (this.#dialogs.length >= MAX_DIALOGS_PER_COMMAND) return;
      // beforeunload 既有 Electron 的 will-prevent-unload，也有 CDP 的 javascriptDialogOpening：同一次只记一个。
      const last = this.#dialogs.at(-1);
      if (
        dialog.type === 'beforeunload' &&
        last?.type === 'beforeunload' &&
        Math.abs(dialog.timestamp - last.timestamp) < 1_000
      ) {
        continue;
      }
      this.#dialogs.push(dialog);
    }
  }

  async #drainPromptShim(): Promise<BrowserAutomationDialogEvent[]> {
    if (this.contents.isDestroyed()) return [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const drained = this.#queue.run(() =>
        this.#send('Runtime.evaluate', {
          expression: promptShimDrainScript(),
          returnByValue: true,
        }),
      ) as Promise<{ result?: { value?: unknown } }>;
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), PROMPT_DRAIN_TIMEOUT_MS);
      });
      const result = await Promise.race([drained, timeout]);
      return parsePromptShimDialogs(result?.result?.value);
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  #onCdpEvent(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'Page.javascriptDialogOpening': {
        const event = handledDialogEvent(params);
        this.openDialog = { type: event.type, message: event.message };
        this.#recordAll([event]);
        // 有 `disableDialogs` 时 Chromium 立刻关掉它（紧接着是 javascriptDialogClosed）；没关的由这里回答，免得页面一直卡着。
        setTimeout(() => {
          if (this.openDialog === undefined || this.contents.isDestroyed()) return;
          // 不排队：对话框挡着的正是队列里的命令。
          this.#send('Page.handleJavaScriptDialog', {
            accept: dialogAcceptValue(event.type),
          }).catch(() => {});
        }, DIALOG_FALLBACK_MS);
        return;
      }
      case 'Page.javascriptDialogClosed':
        this.openDialog = undefined;
        return;
      case 'Page.fileChooserOpened':
        this.#fileChooser = { multiple: params.mode === 'selectMultiple' };
        return;
      case 'Page.frameNavigated': {
        const frame = params.frame as { id?: unknown; parentId?: unknown; loaderId?: unknown };
        if (frame?.parentId !== undefined || typeof frame?.id !== 'string') return;
        // 新的主文档：只留这次载入的记录（主文档与重定向）。
        this.#network = this.#network.filter((record) => record.loaderId === frame.loaderId);
        this.#networkTotal = this.#network.length;
        this.#pageStart = this.#network[0]?.start;
        this.console = [];
        this.consoleTotal = 0;
        return;
      }
      case 'Network.requestWillBeSent':
        this.#onRequest(params);
        return;
      case 'Network.responseReceived': {
        const record = this.#find(params.requestId);
        const response = params.response as { status?: unknown } | undefined;
        if (record && typeof response?.status === 'number') record.status = response.status;
        return;
      }
      case 'Network.loadingFinished': {
        const record = this.#find(params.requestId);
        if (!record) return;
        record.end = numberOr(params.timestamp, record.start);
        if (typeof params.encodedDataLength === 'number') {
          record.transferSize = params.encodedDataLength;
        }
        return;
      }
      case 'Network.loadingFailed': {
        const record = this.#find(params.requestId);
        if (!record) return;
        record.end = numberOr(params.timestamp, record.start);
        record.failed = typeof params.errorText === 'string' ? params.errorText : 'failed';
        return;
      }
      default:
        return;
    }
  }

  #onRequest(params: Record<string, unknown>): void {
    const request = params.request as { url?: unknown; method?: unknown } | undefined;
    if (typeof params.requestId !== 'string' || typeof request?.url !== 'string') return;
    const timestamp = numberOr(params.timestamp, 0);
    const existing = this.#find(params.requestId);
    const redirect = params.redirectResponse as { status?: unknown } | undefined;
    if (existing && redirect) {
      // 重定向：上一跳记成结束，同一个请求接着走新地址。
      existing.end = timestamp;
      if (typeof redirect.status === 'number') existing.status = redirect.status;
      existing.requestId = `${existing.requestId}:redirect`;
    }
    this.#network.push({
      requestId: params.requestId,
      loaderId: typeof params.loaderId === 'string' ? params.loaderId : '',
      url: request.url,
      method: typeof request.method === 'string' ? request.method : 'GET',
      ...(typeof params.type === 'string' && { type: params.type.toLowerCase() }),
      start: timestamp,
    });
    this.#networkTotal += 1;
    if (this.#network.length > MAX_NETWORK_ENTRIES_PER_TAB) {
      this.#network = this.#network.slice(-MAX_NETWORK_ENTRIES_PER_TAB);
    }
  }

  #find(requestId: unknown): NetworkRecord | undefined {
    if (typeof requestId !== 'string') return undefined;
    for (let index = this.#network.length - 1; index >= 0; index -= 1) {
      const record = this.#network[index];
      if (record?.requestId === requestId) return record;
    }
    return undefined;
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 网络记录的地址不带 `#…`（不发给服务器）。 */
function withoutFragment(url: string): string {
  const index = url.indexOf('#');
  return index < 0 ? url : url.slice(0, index);
}

function parsePromptShimDialogs(value: unknown): BrowserAutomationDialogEvent[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry): BrowserAutomationDialogEvent[] => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }
    const record = entry as Record<string, unknown>;
    if (record.type !== 'prompt' || record.action !== 'dismissed') {
      return [];
    }
    return [
      {
        type: 'prompt',
        message: typeof record.message === 'string' ? record.message : '',
        ...(typeof record.defaultValue === 'string' ? { defaultValue: record.defaultValue } : {}),
        action: 'dismissed',
        timestamp: typeof record.timestamp === 'number' ? record.timestamp : Date.now(),
      },
    ];
  });
}

function normalizeConsoleMessage(input: {
  level: unknown;
  message: unknown;
  line: unknown;
  sourceId: unknown;
}): BrowserAutomationConsoleLogEntry {
  return {
    level: typeof input.level === 'string' ? input.level : String(input.level ?? 'log'),
    message: typeof input.message === 'string' ? input.message : String(input.message ?? ''),
    ...(typeof input.sourceId === 'string' && input.sourceId.length > 0
      ? { source: input.sourceId }
      : {}),
    ...(typeof input.line === 'number' ? { line: input.line } : {}),
    timestamp: Date.now(),
  };
}
