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
// 0.48.0：列出子 frame（WebFrameMain，跨进程的也行）给快照、执行、查询与等待用；网络记录带编号、请求头与响应头、请求体开头、
// MIME、是否来自缓存与等待时间，响应体留在 Chromium 的缓冲里按需取（`Network.getResponseBody`），记录可以清空；对话框按标签页
// 的策略回答（替身烤进新文档的脚本，改策略时换掉）；被拦下的选文件框记下它的元素，browser_upload 不带引用时把文件交给它。
// 控制台记录改用 CDP（Runtime.consoleAPICalled、Runtime.exceptionThrown、Log.entryAdded，console-format.ts）：级别是页面调用的
// 方法名、对象参数写出内容；Electron 的 console-message 只在没有调试器时用，另外补上跨进程 iframe 的消息（CDP 只连着主页面）。

import type {
  BrowserConsoleEntry as BrowserAutomationConsoleLogEntry,
  BrowserEffects,
  BrowserNetworkDetail,
  BrowserNetworkEntry,
} from '@wevir/protocol';
import { CdpSessionQueue } from './cdp-session-queue.js';
import { consoleApiEntry, exceptionEntry, logEntry } from './console-format.js';
import {
  type BrowserAutomationDialogEvent,
  DEFAULT_DIALOG_POLICY,
  type DialogPolicy,
  dialogAcceptValue,
  handledDialogEvent,
  MAX_DIALOGS_PER_COMMAND,
  promptShimDrainScript,
  promptShimInstallScript,
} from './dialog-handling.js';
import { FRAME_PATH_SCRIPT, type TabFrame } from './frames.js';
import { redactHeaders, responseBody } from './network.js';
import type { TabContents, TabImage } from './service.js';
import { BrowserTabClosedError } from './service.js';
import type { IsolatedKeyboardInputEvent } from './trusted-input.js';

const MAX_CONSOLE_MESSAGES_PER_TAB = 200;
const MAX_NETWORK_ENTRIES_PER_TAB = 200;
/** Chromium 为取响应体留的缓冲（每个标签页合计、单个响应）；超过的响应体拿不到。 */
const NETWORK_BUFFER_BYTES = 16 * 1024 * 1024;
const NETWORK_RESOURCE_BUFFER_BYTES = 4 * 1024 * 1024;
/** 请求体最多留多少字符。 */
const MAX_POST_DATA_CHARS = 2_000;
/** 一个 frame 算编号最多等多久（卡住的 frame 不列出）。 */
const FRAME_PATH_TIMEOUT_MS = 1_000;
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

/** Electron 的 WebFrameMain 里用到的部分。 */
interface FrameLike {
  readonly url: string;
  readonly name: string;
  readonly detached?: boolean;
  readonly processId?: number;
  isDestroyed(): boolean;
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
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
      frame?: { readonly processId?: number } | null;
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
  readonly mainFrame?: FrameLike & { readonly framesInSubtree: FrameLike[] };
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
    listFrames: () => listFrames(contents),
    getNetworkDetail: (id) => monitor.networkDetail(id),
    getNetworkBody: (id, maxChars) => monitor.networkBody(id, maxChars),
    clearNetworkLog: () => monitor.clearNetwork(),
    getDialogPolicy: () => monitor.dialogPolicy,
    setDialogPolicy: (policy) => monitor.setDialogPolicy(policy),
    takeFileChooser: () => monitor.takeFileChooser(),
  };
}

/** 子 frame（不含顶层），带编号；算不出编号（卡住、已经没了）的不列。 */
async function listFrames(contents: BrowserAutomationWebContents): Promise<TabFrame[]> {
  const main = contents.mainFrame;
  if (!main || contents.isDestroyed()) return [];
  const frames = main.framesInSubtree.filter(
    (frame) => frame !== main && !frame.isDestroyed() && frame.detached !== true,
  );
  const ids = await Promise.all(
    frames.map((frame) =>
      Promise.race([
        frame.executeJavaScript(FRAME_PATH_SCRIPT).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), FRAME_PATH_TIMEOUT_MS)),
      ]),
    ),
  );
  return frames.flatMap((frame, index): TabFrame[] => {
    const id = ids[index];
    if (typeof id !== 'string' || id === '') return [];
    return [
      {
        id,
        url: frame.isDestroyed() ? '' : frame.url,
        name: frame.isDestroyed() ? '' : frame.name,
        page: {
          getURL: () => (frame.isDestroyed() ? '' : frame.url),
          executeJavaScript: (code) =>
            frame.isDestroyed()
              ? Promise.reject(new Error('The frame is gone.'))
              : frame.executeJavaScript(code),
        },
      },
    ];
  });
}

/** 标签页的对话框策略（browser-host.ts 的 beforeunload 用）。 */
export function dialogPolicyOf(contentsId: number): Readonly<DialogPolicy> {
  return monitorsByContentsId.get(contentsId)?.dialogPolicy ?? DEFAULT_DIALOG_POLICY;
}

/** 用户接手标签页时策略回到默认：用户自己操作时不该被 agent 的选择挡住离开。 */
export function resetDialogPolicy(contentsId: number): void {
  const monitor = monitorsByContentsId.get(contentsId);
  if (monitor && monitor.dialogPolicy !== DEFAULT_DIALOG_POLICY) {
    void monitor.setDialogPolicy(DEFAULT_DIALOG_POLICY);
  }
}

/**
 * 开始看着一个标签页（建标签页时调一次，在第一次载入之前）：之后的对话框、控制台、网络请求、文件框都记下来。重复调用没有
 * 副作用。
 */
export function watchTab(contents: BrowserAutomationWebContents): void {
  monitorFor(contents);
}

/** 页面要离开时的 beforeunload（browser-host.ts 的 `will-prevent-unload`，按策略离开或留下）。 */
export function recordBeforeUnload(
  contentsId: number,
  action: BrowserAutomationDialogEvent['action'] = 'accepted',
): void {
  monitorsByContentsId
    .get(contentsId)
    ?.record({ ...handledDialogEvent({ type: 'beforeunload', message: '' }), action }, true);
}

/** 页面开始的下载（browser-host.ts 已经取消）。 */
export function recordDownload(
  contentsId: number,
  download: { url: string; filename: string; state: string },
): void {
  monitorsByContentsId.get(contentsId)?.recordDownload(download);
}

/** 点击之后等跳转期间开始、还没报的下载（browser-host.ts 并进这个命令的结果）。 */
export function takeDownloads(contentsId: number): NonNullable<BrowserEffects['downloads']> {
  return monitorsByContentsId.get(contentsId)?.takeDownloads() ?? [];
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
  /** 给 agent 的编号（这个标签页里递增）。 */
  id: string;
  requestId: string;
  /** CDP 的请求 ID（取响应体用；重定向的几跳共用一个）。 */
  cdpRequestId: string;
  loaderId: string;
  url: string;
  method: string;
  type?: string;
  /** CDP 的单调时钟（秒）。 */
  start: number;
  end?: number;
  status?: number;
  statusText?: string;
  transferSize?: number;
  failed?: string;
  requestHeaders?: Record<string, unknown>;
  postData?: string;
  hasPostData?: boolean;
  responseHeaders?: Record<string, unknown>;
  mimeType?: string;
  remoteAddress?: string;
  protocol?: string;
  fromCache?: boolean;
  waitingMs?: number;
  /** 被重定向了：这一跳没有响应体。 */
  redirected?: boolean;
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
  /** 被拦下、还没交文件的选文件框（browser_upload 不带引用时用）。 */
  #chooser: { backendNodeId: number; multiple: boolean } | undefined;
  #network: NetworkRecord[] = [];
  #networkTotal = 0;
  #networkSeq = 0;
  dialogPolicy: Readonly<DialogPolicy> = DEFAULT_DIALOG_POLICY;
  /** 新文档脚本（prompt / confirm 的替身）的标识，换策略时换掉。 */
  #shimScriptId: string | undefined;
  /** 当前页面的第一个请求的时间（CDP 时钟），网络记录的 `startTime` 从它算起。 */
  #pageStart: number | undefined;
  #interceptFileChooser = true;
  #enabled = false;

  constructor(private readonly contents: BrowserAutomationWebContents) {}

  start(): void {
    const cdpConsole = Boolean(this.contents.debugger.on);
    this.contents.on('console-message', (event) => {
      // 有调试器时控制台走 CDP；它只连着主页面的进程，跨进程 iframe 的消息仍从这里来。
      if (cdpConsole && !this.#fromOtherProcess(event.frame)) return;
      this.#recordConsole(
        normalizeConsoleMessage({
          level: event.level,
          message: event.message,
          line: event.lineNumber,
          sourceId: event.sourceId,
        }),
      );
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

  #recordConsole(entry: BrowserAutomationConsoleLogEntry): void {
    this.console.push(entry);
    this.consoleTotal += 1;
    if (this.console.length > MAX_CONSOLE_MESSAGES_PER_TAB) {
      this.console = this.console.slice(-MAX_CONSOLE_MESSAGES_PER_TAB);
    }
  }

  /** 消息来自和主页面不同的渲染进程（跨进程的 iframe）。 */
  #fromOtherProcess(frame: { readonly processId?: number } | null | undefined): boolean {
    const main = this.contents.mainFrame?.processId;
    return frame?.processId !== undefined && main !== undefined && frame.processId !== main;
  }

  /** 打开 Page 与 Network 域、装上 prompt 的替身。标签页还没载入任何东西时这些命令要等到第一次载入才回答，所以不等它们。 */
  async #enable(): Promise<void> {
    if (this.#enabled || this.contents.isDestroyed() || !this.contents.debugger.on) return;
    this.#enabled = true;
    const commands: Array<[string, Record<string, unknown>?]> = [
      ['Page.enable'],
      ['Page.setInterceptFileChooserDialog', { enabled: this.#interceptFileChooser }],
      // 控制台：打开时先补报这个页面已有的消息。
      ['Runtime.enable'],
      ['Log.enable'],
      // 响应体留在 Chromium 的缓冲里，要了才取（browser_network 的 body）。
      [
        'Network.enable',
        {
          maxTotalBufferSize: NETWORK_BUFFER_BYTES,
          maxResourceBufferSize: NETWORK_RESOURCE_BUFFER_BYTES,
        },
      ],
    ];
    await Promise.all([
      this.#installShimScript(),
      ...commands.map(([command, params]) =>
        this.#send(command, params).catch(() => {
          // 标签页正在关，或调试器被别人占了：之后的命令照常执行，只是少了这项记录。
        }),
      ),
    ]);
    // 已经载入的页面：现在就装上替身（新文档由上面的脚本装）。
    await this.#send('Runtime.evaluate', {
      expression: promptShimInstallScript(this.dialogPolicy),
      returnByValue: true,
    }).catch(() => {});
  }

  /** 把带着当前策略的替身登记成新文档脚本（换掉旧的）。 */
  async #installShimScript(): Promise<void> {
    const previous = this.#shimScriptId;
    this.#shimScriptId = undefined;
    if (previous !== undefined) {
      await this.#send('Page.removeScriptToEvaluateOnNewDocument', { identifier: previous }).catch(
        () => {},
      );
    }
    const added = (await this.#send('Page.addScriptToEvaluateOnNewDocument', {
      source: promptShimInstallScript(this.dialogPolicy),
    }).catch(() => undefined)) as { identifier?: unknown } | undefined;
    if (typeof added?.identifier === 'string') this.#shimScriptId = added.identifier;
  }

  /** 换对话框策略：之后的新文档、现在的文档与它的子 frame 都用新的。 */
  async setDialogPolicy(policy: Readonly<DialogPolicy>): Promise<void> {
    this.dialogPolicy = policy;
    if (!this.#enabled || this.contents.isDestroyed()) return;
    await this.#queue.run(() => this.#installShimScript());
    const script = promptShimInstallScript(policy);
    await this.#queue
      .run(() => this.#send('Runtime.evaluate', { expression: script, returnByValue: true }))
      .catch(() => {});
    const main = this.contents.mainFrame;
    if (!main) return;
    await Promise.all(
      main.framesInSubtree
        .filter((frame) => frame !== main && !frame.isDestroyed())
        .map((frame) => frame.executeJavaScript(script).catch(() => {})),
    );
  }

  /** 被拦下、还没交文件的选文件框；取走后清掉。 */
  takeFileChooser(): { backendNodeId: number; multiple: boolean } | undefined {
    const chooser = this.#chooser;
    this.#chooser = undefined;
    // 交了文件就不再报“页面要选文件、没选”。
    if (chooser) this.#fileChooser = undefined;
    return chooser;
  }

  /** 还没报的下载（点击之后等跳转的那段时间里开始的）。 */
  takeDownloads(): NonNullable<BrowserEffects['downloads']> {
    const downloads = this.#downloads;
    this.#downloads = [];
    return downloads;
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

  /** `authoritative`：Electron 的 `will-prevent-unload` 知道实际怎么处理的，盖过 CDP 报的同一个 beforeunload。 */
  record(dialog: BrowserAutomationDialogEvent, authoritative = false): void {
    if (authoritative && dialog.type === 'beforeunload') {
      const last = this.#dialogs.at(-1);
      if (last?.type === 'beforeunload' && Math.abs(dialog.timestamp - last.timestamp) < 1_000) {
        last.action = dialog.action;
        return;
      }
    }
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
    return {
      total: this.#networkTotal,
      entries: this.#network.map((record) => this.#entry(record)),
    };
  }

  #entry(record: NetworkRecord): BrowserNetworkEntry {
    const base = this.#pageStart ?? this.#network[0]?.start ?? 0;
    return {
      id: record.id,
      url: withoutFragment(record.url),
      method: record.method,
      ...(record.status !== undefined && { status: record.status }),
      ...(record.type !== undefined && { type: record.type }),
      startTime: Math.max(0, (record.start - base) * 1000),
      duration: record.end === undefined ? 0 : Math.max(0, (record.end - record.start) * 1000),
      ...(record.transferSize !== undefined && { transferSize: record.transferSize }),
      ...(record.end === undefined && { pending: true }),
      ...(record.failed !== undefined && { failed: record.failed }),
      ...(record.mimeType !== undefined && { mimeType: record.mimeType }),
      ...(record.fromCache === true && { fromCache: true }),
    };
  }

  /** 一条记录的详情（凭据类的头只给长度）。 */
  networkDetail(id: string): BrowserNetworkDetail | undefined {
    const record = this.#network.find((candidate) => candidate.id === id);
    if (!record) return undefined;
    const { pending, failed, ...entry } = this.#entry(record);
    const postData = record.postData;
    return {
      id: record.id,
      url: entry.url,
      method: record.method,
      ...(record.status !== undefined && { status: record.status }),
      ...(record.statusText && { statusText: record.statusText }),
      ...(record.type !== undefined && { type: record.type }),
      ...(record.mimeType !== undefined && { mimeType: record.mimeType }),
      requestHeaders: redactHeaders(record.requestHeaders),
      ...(record.responseHeaders !== undefined && {
        responseHeaders: redactHeaders(record.responseHeaders),
      }),
      ...(postData !== undefined && {
        postData: postData.slice(0, MAX_POST_DATA_CHARS),
        ...(postData.length > MAX_POST_DATA_CHARS && { postDataTruncated: true }),
      }),
      ...(postData === undefined && record.hasPostData === true && { postDataTruncated: true }),
      ...(record.remoteAddress && { remoteAddress: record.remoteAddress }),
      ...(record.protocol && { protocol: record.protocol }),
      ...(record.fromCache === true && { fromCache: true }),
      startTime: entry.startTime,
      duration: entry.duration,
      ...(record.waitingMs !== undefined && { waitingMs: record.waitingMs }),
      ...(entry.transferSize !== undefined && { transferSize: entry.transferSize }),
      ...(pending === true && { pending: true }),
      ...(failed !== undefined && { failed }),
    };
  }

  /** 一条记录的响应体（Chromium 缓冲里还有的话）。 */
  async networkBody(id: string, maxChars: number): Promise<BrowserNetworkDetail['body']> {
    const record = this.#network.find((candidate) => candidate.id === id);
    if (!record) return undefined;
    if (record.redirected)
      return { size: 0, unavailable: 'this hop was redirected; it has no body' };
    if (record.failed !== undefined)
      return { size: 0, unavailable: `the request failed (${record.failed})` };
    if (record.end === undefined) return { size: 0, unavailable: 'the response is still loading' };
    try {
      const raw = (await this.sendDebugCommand('Network.getResponseBody', {
        requestId: record.cdpRequestId,
      })) as { body?: unknown; base64Encoded?: unknown };
      return responseBody(raw, record.mimeType, maxChars);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        size: 0,
        unavailable: `the browser no longer has it (${message.slice(0, 120)}); reload the page and read it again`,
      };
    }
  }

  /** 清空这个标签页的网络记录（之后的请求照常记）。 */
  clearNetwork(): void {
    this.#network = [];
    this.#networkTotal = 0;
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
      const main = parsePromptShimDialogs(result?.result?.value);
      // 子 frame 里的替身各记各的（同源的由新文档脚本装上，跨域的在改策略时装上）。
      const frames = (this.contents.mainFrame?.framesInSubtree ?? []).filter(
        (frame) => frame !== this.contents.mainFrame && !frame.isDestroyed(),
      );
      if (frames.length === 0) return main;
      const drainedFrames = await Promise.all(
        frames.map((frame) =>
          Promise.race([
            frame.executeJavaScript(promptShimDrainScript()).catch(() => []),
            timeout.then(() => []),
          ]).then(parsePromptShimDialogs),
        ),
      );
      return [...main, ...drainedFrames.flat()].sort((a, b) => a.timestamp - b.timestamp);
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  #onCdpEvent(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'Runtime.consoleAPICalled':
        this.#recordConsole(consoleApiEntry(params));
        return;
      case 'Runtime.exceptionThrown':
        this.#recordConsole(exceptionEntry(params));
        return;
      case 'Log.entryAdded':
        this.#recordConsole(logEntry(params));
        return;
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
        if (typeof params.backendNodeId === 'number') {
          this.#chooser = {
            backendNodeId: params.backendNodeId,
            multiple: params.mode === 'selectMultiple',
          };
        }
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
        this.#chooser = undefined;
        return;
      }
      case 'Network.requestWillBeSent':
        this.#onRequest(params);
        return;
      case 'Network.responseReceived': {
        const record = this.#find(params.requestId);
        if (record) {
          applyResponse(record, params.response);
          const extra = this.#takeExtra(record.cdpRequestId, 'response');
          if (extra) mergeHeaders(record, 'responseHeaders', extra);
        }
        return;
      }
      case 'Network.requestWillBeSentExtraInfo': {
        // 页面能看到的头之外，浏览器实际发出的（Cookie 等）在这里；可能比 requestWillBeSent 先到。
        if (typeof params.requestId !== 'string' || !isRecord(params.headers)) return;
        const record = this.#find(params.requestId);
        if (record) mergeHeaders(record, 'requestHeaders', params.headers);
        else this.#stashExtra(params.requestId, 'request', params.headers);
        return;
      }
      case 'Network.responseReceivedExtraInfo': {
        // 同上：响应的 Set-Cookie 等只在这里。
        if (typeof params.requestId !== 'string' || !isRecord(params.headers)) return;
        const record = this.#find(params.requestId);
        if (record?.status === undefined) {
          this.#stashExtra(params.requestId, 'response', params.headers);
        } else if (params.statusCode === undefined || params.statusCode === record.status) {
          mergeHeaders(record, 'responseHeaders', params.headers);
        }
        return;
      }
      case 'Network.requestServedFromCache': {
        const record = this.#find(params.requestId);
        if (record) record.fromCache = true;
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
    const request = params.request as
      | {
          url?: unknown;
          method?: unknown;
          headers?: unknown;
          postData?: unknown;
          hasPostData?: unknown;
        }
      | undefined;
    if (typeof params.requestId !== 'string' || typeof request?.url !== 'string') return;
    const timestamp = numberOr(params.timestamp, 0);
    const existing = this.#find(params.requestId);
    const redirect = params.redirectResponse;
    if (existing && redirect) {
      // 重定向：上一跳记成结束，同一个请求接着走新地址。
      existing.end = timestamp;
      applyResponse(existing, redirect);
      existing.redirected = true;
      existing.requestId = `${existing.requestId}:redirect`;
    }
    this.#networkSeq += 1;
    this.#network.push({
      id: String(this.#networkSeq),
      requestId: params.requestId,
      cdpRequestId: params.requestId,
      loaderId: typeof params.loaderId === 'string' ? params.loaderId : '',
      url: request.url,
      method: typeof request.method === 'string' ? request.method : 'GET',
      ...(typeof params.type === 'string' && { type: params.type.toLowerCase() }),
      start: timestamp,
      ...(isRecord(request.headers) && { requestHeaders: request.headers }),
      ...(typeof request.postData === 'string' && {
        postData: request.postData.slice(0, MAX_POST_DATA_CHARS + 1),
      }),
      ...(request.hasPostData === true && { hasPostData: true }),
    });
    this.#networkTotal += 1;
    const extra = this.#takeExtra(params.requestId, 'request');
    const added = this.#network[this.#network.length - 1];
    if (extra && added) mergeHeaders(added, 'requestHeaders', extra);
    if (this.#network.length > MAX_NETWORK_ENTRIES_PER_TAB) {
      this.#network = this.#network.slice(-MAX_NETWORK_ENTRIES_PER_TAB);
    }
  }

  /** 比主事件先到的额外头先放着，主事件到了再合并（每个标签页最多记着 200 条）。 */
  #extraHeaders = new Map<
    string,
    { request?: Record<string, unknown>; response?: Record<string, unknown> }
  >();

  #stashExtra(requestId: string, kind: 'request' | 'response', headers: Record<string, unknown>) {
    const entry = this.#extraHeaders.get(requestId) ?? {};
    entry[kind] = headers;
    this.#extraHeaders.delete(requestId);
    this.#extraHeaders.set(requestId, entry);
    if (this.#extraHeaders.size > 200) {
      const oldest = this.#extraHeaders.keys().next().value;
      if (oldest !== undefined) this.#extraHeaders.delete(oldest);
    }
  }

  #takeExtra(requestId: string, kind: 'request' | 'response'): Record<string, unknown> | undefined {
    const entry = this.#extraHeaders.get(requestId);
    const headers = entry?.[kind];
    if (entry === undefined || headers === undefined) return undefined;
    delete entry[kind];
    if (entry.request === undefined && entry.response === undefined) {
      this.#extraHeaders.delete(requestId);
    }
    return headers;
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

/** 把 ExtraInfo 里的头并进记录：它是实际收发的完整一份，同名（不分大小写）的以它为准。 */
function mergeHeaders(
  record: NetworkRecord,
  field: 'requestHeaders' | 'responseHeaders',
  extra: Record<string, unknown>,
): void {
  const merged: Record<string, unknown> = { ...record[field] };
  for (const [name, value] of Object.entries(extra)) {
    for (const key of Object.keys(merged)) {
      if (key.toLowerCase() === name.toLowerCase()) delete merged[key];
    }
    merged[name] = value;
  }
  record[field] = merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** CDP 的 Response：状态、头、MIME、远端地址、协议、缓存与等待时间。 */
function applyResponse(record: NetworkRecord, value: unknown): void {
  if (!isRecord(value)) return;
  if (typeof value.status === 'number') record.status = value.status;
  if (typeof value.statusText === 'string') record.statusText = value.statusText;
  if (isRecord(value.headers)) record.responseHeaders = value.headers;
  if (typeof value.mimeType === 'string' && value.mimeType) record.mimeType = value.mimeType;
  if (typeof value.remoteIPAddress === 'string' && value.remoteIPAddress) {
    record.remoteAddress =
      typeof value.remotePort === 'number'
        ? `${value.remoteIPAddress}:${value.remotePort}`
        : value.remoteIPAddress;
  }
  if (typeof value.protocol === 'string' && value.protocol) record.protocol = value.protocol;
  if (
    value.fromDiskCache === true ||
    value.fromServiceWorker === true ||
    value.fromPrefetchCache === true
  ) {
    record.fromCache = true;
  }
  const timing = value.timing;
  if (
    isRecord(timing) &&
    typeof timing.sendEnd === 'number' &&
    typeof timing.receiveHeadersEnd === 'number' &&
    timing.sendEnd >= 0
  ) {
    record.waitingMs = Math.max(0, timing.receiveHeadersEnd - timing.sendEnd);
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
    if (
      (record.type !== 'prompt' && record.type !== 'confirm') ||
      (record.action !== 'dismissed' && record.action !== 'accepted')
    ) {
      return [];
    }
    return [
      {
        type: record.type,
        message: typeof record.message === 'string' ? record.message : '',
        ...(typeof record.defaultValue === 'string' ? { defaultValue: record.defaultValue } : {}),
        action: record.action,
        ...(typeof record.response === 'string' ? { response: record.response } : {}),
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
