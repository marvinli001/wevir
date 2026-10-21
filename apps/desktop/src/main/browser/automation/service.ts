// SPDX-License-Identifier: Apache-2.0
// 改写自 getpaseo/paseo packages/desktop/src/features/browser-automation/service.ts
// 来源提交 dc7bc8db124e837ba909ffd3b4b20e16adaebe24
// Copyright (c) 2025-present Mohamed Boudra，Apache License 2.0
// 由 Wevir 修改：类型换成 Wevir 协议的（packages/protocol/src/browser.ts）；标签页按会话归属（`ownerOf`），不再按 Paseo 的 workspace；
// 去掉 evaluate 与 upload（Wevir 不提供在页面里跑任意脚本、把本机文件交给网页）以及 list_tabs、new_tab、resize、close_tab
// （标签页的开关、列出与显示在 browser-host.ts）；截图有大小上限（`BROWSER_SCREENSHOT_MAX_BYTES`），整页截图的高度有上限；
// 引用用不了时分开“快照里没有”与“页面变了”；网络记录带 Resource Timing 的状态码，不再给导航编一个 GET。
// 0.46.0：网络记录改用 contents.ts 的 CDP 记录（Resource Timing 只作没有它时的退路），日志带总数；快照按字节预算分段
// （`offset`）；结果带对话框之外的页面变化（下载、选文件框）；文件输入框不能填，直接说明。
// 0.48.0：加回 Paseo 的 evaluate 与 upload（执行前在主进程里只做语法检查、不执行；不经页面的 eval，CSP 挡不住也不受它影响；
// 返回值在页面里序列化并截断；上传的文件再核对一遍在会话文件夹里，交给文件输入框或被拦下的选文件框），另加 query、network、
// dialogs；快照的范围参数；等待的条件多了地址正则、元素状态与网络空闲；引用可以在跨域 frame 里（脚本在那个 frame 里跑，坐标
// 逐层换算到顶层页面）。

import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { Script } from 'node:vm';
import {
  BROWSER_EVALUATE_DEFAULT_BYTES,
  BROWSER_SCREENSHOT_MAX_BYTES,
  type BrowserCommand,
  type BrowserConsoleEntry,
  type BrowserEffects,
  type BrowserErrorCode,
  type BrowserNetworkDetail,
  type BrowserNetworkEntry,
  type BrowserQueryElement,
  type BrowserRequest,
  type BrowserResponse,
} from '@wevir/protocol';
import { type ActionabilityResult, waitForActionableTarget } from './actionability.js';
import type { BrowserAutomationDialogEvent, DialogPolicy } from './dialog-handling.js';
import { DEFAULT_DIALOG_POLICY } from './dialog-handling.js';
import { findFrame, frameNotFoundMessage, frameToTopPoint, type TabFrame } from './frames.js';
import { filterNetwork } from './network.js';
import {
  type BrowserRefActionResult,
  BrowserSnapshotEngine,
  type SnapshotPage,
} from './snapshot-engine.js';
import {
  type ClickInputOptions,
  dispatchCdpKey,
  dispatchTrustedClick,
  dispatchTrustedDrag,
  dispatchTrustedHover,
  dispatchTrustedKey,
  dispatchTrustedScroll,
  type IsolatedKeyboardInputEvent,
} from './trusted-input.js';

export interface TabContents {
  readonly id: number;
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
  captureFrame(signal: AbortSignal): Promise<TabImage>;
  invalidate(): void;
  withFrameProduction<T>(capture: () => Promise<T>): Promise<T>;
  sendInputEvent(event: IsolatedKeyboardInputEvent): void;
  // Commits text into this tab's focused element. CDP Input.insertText would
  // commit into whichever element has focus in the Paseo window instead.
  insertText(text: string): Promise<void>;
  getConsoleMessages?(): ConsoleLogEntry[];
  /** 当前页面一共有过多少条控制台消息（`getConsoleMessages` 只留最近的）。 */
  getConsoleTotal?(): number;
  /** 当前页面的网络记录与总数（CDP 的 Network 域）。 */
  getNetworkLog?(): { entries: NetworkLogEntry[]; total: number };
  /** 打开着、还没关的对话框。 */
  openDialog?(): { type: string; message: string } | undefined;
  captureDialogs?<T>(task: () => Promise<T>): Promise<{
    result: T;
    dialogs: BrowserAutomationDialogEvent[];
    effects?: Pick<BrowserEffects, 'downloads' | 'fileChooser'>;
  }>;
  sendDebugCommand?(command: string, params?: Record<string, unknown>): Promise<unknown>;
  /** 子 frame（0.48.0）。 */
  listFrames?(): Promise<TabFrame[]>;
  getNetworkDetail?(id: string): BrowserNetworkDetail | undefined;
  getNetworkBody?(id: string, maxChars: number): Promise<BrowserNetworkDetail['body']>;
  clearNetworkLog?(): void;
  getDialogPolicy?(): Readonly<DialogPolicy>;
  setDialogPolicy?(policy: Readonly<DialogPolicy>): Promise<void>;
  /** 被拦下、还没交文件的选文件框；取走后清掉。 */
  takeFileChooser?(): { backendNodeId: number; multiple: boolean } | undefined;
}

export interface TabImage {
  toPNG(): Uint8Array;
  getSize(): { width: number; height: number };
}

/** 标签页的查找：内容与所属的会话（OpenWork 的标签页归属，browser-host.ts）。 */
export interface BrowserRegistry {
  getTabContents(browserId: string): TabContents | null;
  /** 标签页属于哪个会话。 */
  ownerOf(browserId: string): string | null;
}

/** 一个回答（`browser.respond` 的参数；`requestId` 在这里是普通字符串）。 */
export type AutomationCommandPayload = BrowserResponse extends infer R
  ? R extends BrowserResponse
    ? Omit<R, 'requestId'> & { requestId: string }
    : never
  : never;
type ConsoleLogEntry = BrowserConsoleEntry;
type NetworkLogEntry = BrowserNetworkEntry;
type FailurePayload = Extract<AutomationCommandPayload, { ok: false }>;

const defaultSnapshotEngine = new BrowserSnapshotEngine();
const DEFAULT_WAIT_TIMEOUT_MS = 5_000;
const DEFAULT_LOG_ENTRIES = 50;
const WAIT_POLL_INTERVAL_MS = 25;
const PIXEL_CAPTURE_TIMEOUT_MS = 5_000;
const PIXEL_CAPTURE_RETRY_INTERVAL_MS = 200;
const SCREENSHOT_NO_FRAME_MESSAGE = 'The tab has not painted yet. Retry the screenshot.';
const ALLOWED_PAGE_URL_PROTOCOLS = new Set(['http:', 'https:']);
let pixelCaptureQueue: Promise<void> = Promise.resolve();

function fail(
  requestId: string,
  code: BrowserErrorCode,
  message: string,
  retryable = false,
): FailurePayload {
  return { requestId, ok: false, error: { code, message, retryable } };
}

async function withDialogCapture(
  contents: TabContents,
  task: () => Promise<AutomationCommandPayload>,
): Promise<AutomationCommandPayload> {
  if (!contents.captureDialogs) {
    return task();
  }
  const { result, dialogs, effects } = await contents.captureDialogs(task);
  const withEffects =
    effects && Object.keys(effects).length > 0
      ? { ...result, effects: { ...(result.effects ?? {}), ...effects } }
      : result;
  return dialogs.length > 0 ? { ...withEffects, dialogs } : withEffects;
}

export class BrowserTabClosedError extends Error {
  public constructor() {
    super('Browser tab has been closed');
    this.name = 'BrowserTabClosedError';
  }
}

class ScreenshotNoFrameError extends Error {
  public constructor(message = SCREENSHOT_NO_FRAME_MESSAGE) {
    super(message);
    this.name = 'ScreenshotNoFrameError';
  }
}

function isScreenshotNoFrameError(error: unknown): error is ScreenshotNoFrameError {
  return error instanceof ScreenshotNoFrameError;
}

function screenshotNoFrameFailure(
  requestId: string,
  error: ScreenshotNoFrameError,
): FailurePayload {
  return fail(requestId, 'screenshot_no_frame', error.message, true);
}

async function withPixelCaptureTimeout<T>(
  capture: Promise<T>,
  timeoutMs = PIXEL_CAPTURE_TIMEOUT_MS,
): Promise<T> {
  if (timeoutMs <= 0) {
    throw new ScreenshotNoFrameError();
  }
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new ScreenshotNoFrameError());
    }, timeoutMs);
  });

  try {
    return await Promise.race([capture, timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function runSerializedPixelCapture<T>(capture: () => Promise<T>): Promise<T> {
  const previous = pixelCaptureQueue;
  let releaseCurrent = () => {};
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const tail = previous.catch(() => {}).then(() => current);
  pixelCaptureQueue = tail;

  await previous.catch(() => {});
  try {
    return await capture();
  } finally {
    releaseCurrent();
    if (pixelCaptureQueue === tail) {
      pixelCaptureQueue = Promise.resolve();
    }
  }
}

async function capturePixelFrameWithRetry<T>(
  contents: TabContents,
  capture: () => Promise<T>,
  deadline: number,
): Promise<T> {
  while (Date.now() < deadline) {
    try {
      contents.invalidate();
      return await withPixelCaptureTimeout(capture(), deadline - Date.now());
    } catch (error) {
      if (isScreenshotNoFrameError(error)) {
        throw error;
      }
      if (!isKnownNoFrameCaptureError(error)) {
        throw error;
      }
      await delay(Math.min(PIXEL_CAPTURE_RETRY_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    }
  }
  throw new ScreenshotNoFrameError();
}

function isKnownNoFrameCaptureError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('UnknownVizError') ||
    message.includes('No frame') ||
    message.includes('no painted frame')
  );
}

async function waitForPaint(contents: TabContents, deadline: number): Promise<void> {
  // A hidden page may have unpainted DOM updates. The first animation callback
  // precedes paint; the next frame ensures capture cannot reuse the old surface.
  await withPixelCaptureTimeout(
    contents.executeJavaScript(
      'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))',
    ),
    deadline - Date.now(),
  );
}

async function runPaintedPixelCapture<T>(
  contents: TabContents,
  capture: () => Promise<T>,
): Promise<T> {
  return runSerializedPixelCapture(() =>
    contents.withFrameProduction(async () => {
      const deadline = Date.now() + PIXEL_CAPTURE_TIMEOUT_MS;
      await waitForPaint(contents, deadline);
      return capturePixelFrameWithRetry(contents, capture, deadline);
    }),
  );
}

async function capturePaintedViewport(contents: TabContents): Promise<TabImage> {
  return runSerializedPixelCapture(() =>
    contents.withFrameProduction(async () => {
      const deadline = Date.now() + PIXEL_CAPTURE_TIMEOUT_MS;
      const controller = new AbortController();
      try {
        await waitForPaint(contents, deadline);
        contents.invalidate();
        return await withPixelCaptureTimeout(
          contents.captureFrame(controller.signal),
          deadline - Date.now(),
        );
      } finally {
        controller.abort();
      }
    }),
  );
}

export function executeAutomationCommand(
  request: BrowserRequest,
  registry: BrowserRegistry,
  options?: { snapshotEngine?: BrowserSnapshotEngine },
): AutomationCommandPayload | Promise<AutomationCommandPayload> {
  const { requestId, command } = request;
  const sessionId = request.sessionId;
  const snapshotEngine = options?.snapshotEngine ?? defaultSnapshotEngine;
  if (isHostHandled(command.command)) {
    return fail(
      requestId,
      'browser_unsupported',
      `${command.command} is handled by the browser host.`,
    );
  }
  const handler = commandHandlers[command.command];

  return handler({ request, command, requestId, sessionId, registry, snapshotEngine });
}

interface CommandHandlerContext {
  request: BrowserRequest;
  command: BrowserCommand;
  requestId: string;
  sessionId: string | undefined;
  registry: BrowserRegistry;
  snapshotEngine: BrowserSnapshotEngine;
}

type CommandHandler = (
  context: CommandHandlerContext,
) => AutomationCommandPayload | Promise<AutomationCommandPayload>;

/**
 * 由 browser-host.ts 自己处理的命令（标签页的开关、列出与显示，0.48.0 起还有要接住下载的 download，0.89.0 起还有收尾与接管）。
 */
export type HostHandledCommand =
  | 'list_tabs'
  | 'new_tab'
  | 'close_tab'
  | 'show'
  | 'download'
  | 'finalize_tabs'
  | 'claim_tab';

export function isHostHandled(command: BrowserCommand['command']): command is HostHandledCommand {
  return (
    command === 'list_tabs' ||
    command === 'new_tab' ||
    command === 'close_tab' ||
    command === 'show' ||
    command === 'download' ||
    command === 'finalize_tabs' ||
    command === 'claim_tab'
  );
}

const commandHandlers: Record<
  Exclude<BrowserCommand['command'], HostHandledCommand>,
  CommandHandler
> = {
  snapshot: ({ command, requestId, sessionId, registry, snapshotEngine }) => {
    const snapshotCommand = command as Extract<BrowserCommand, { command: 'snapshot' }>;
    return executeSnapshot(requestId, sessionId, snapshotCommand.args, registry, snapshotEngine);
  },
  evaluate: ({ command, requestId, sessionId, registry, snapshotEngine }) =>
    executeEvaluate(
      requestId,
      sessionId,
      (command as Extract<BrowserCommand, { command: 'evaluate' }>).args,
      registry,
      snapshotEngine,
    ),
  query: ({ command, requestId, sessionId, registry, snapshotEngine }) =>
    executeQuery(
      requestId,
      sessionId,
      (command as Extract<BrowserCommand, { command: 'query' }>).args,
      registry,
      snapshotEngine,
    ),
  network: ({ command, requestId, sessionId, registry }) =>
    executeNetwork(
      requestId,
      sessionId,
      (command as Extract<BrowserCommand, { command: 'network' }>).args,
      registry,
    ),
  dialogs: ({ command, requestId, sessionId, registry }) =>
    executeDialogs(
      requestId,
      sessionId,
      (command as Extract<BrowserCommand, { command: 'dialogs' }>).args,
      registry,
    ),
  upload: ({ request, command, requestId, sessionId, registry, snapshotEngine }) =>
    executeUpload(
      requestId,
      sessionId,
      request.cwd,
      (command as Extract<BrowserCommand, { command: 'upload' }>).args,
      registry,
      snapshotEngine,
    ),
  click: ({ command, requestId, sessionId, registry, snapshotEngine }) => {
    const clickCommand = command as Extract<BrowserCommand, { command: 'click' }>;
    return executeClick(
      requestId,
      sessionId,
      clickCommand.args.browserId,
      clickCommand.args.ref,
      {
        button: clickCommand.args.button,
        doubleClick: clickCommand.args.doubleClick,
        modifiers: clickCommand.args.modifiers,
      },
      registry,
      snapshotEngine,
    );
  },
  fill: ({ command, requestId, sessionId, registry, snapshotEngine }) => {
    const fillCommand = command as Extract<BrowserCommand, { command: 'fill' }>;
    return executeFill(
      requestId,
      sessionId,
      fillCommand.args.browserId,
      fillCommand.args.ref,
      fillCommand.args.value,
      registry,
      snapshotEngine,
    );
  },
  wait: ({ command, requestId, sessionId, registry }) => {
    const waitCommand = command as Extract<BrowserCommand, { command: 'wait' }>;
    return executeWait(
      requestId,
      sessionId,
      waitCommand.args.browserId,
      waitCommand.args,
      registry,
    );
  },
  type: ({ command, requestId, sessionId, registry, snapshotEngine }) => {
    const typeCommand = command as Extract<BrowserCommand, { command: 'type' }>;
    return executeType(
      requestId,
      sessionId,
      typeCommand.args.browserId,
      typeCommand.args.ref,
      typeCommand.args.text,
      registry,
      snapshotEngine,
    );
  },
  keypress: ({ command, requestId, sessionId, registry, snapshotEngine }) => {
    const keypressCommand = command as Extract<BrowserCommand, { command: 'keypress' }>;
    return executeKeypress(
      requestId,
      sessionId,
      keypressCommand.args.browserId,
      keypressCommand.args.ref,
      keypressCommand.args.key,
      registry,
      snapshotEngine,
    );
  },
  navigate: ({ command, requestId, sessionId, registry, snapshotEngine }) => {
    const navigateCommand = command as Extract<BrowserCommand, { command: 'navigate' }>;
    return executeNavigate(
      requestId,
      sessionId,
      navigateCommand.args.browserId,
      navigateCommand.args.url,
      registry,
      snapshotEngine,
    );
  },
  back: ({ command, requestId, sessionId, registry, snapshotEngine }) => {
    const backCommand = command as Extract<BrowserCommand, { command: 'back' }>;
    return executeNavigationAction(
      requestId,
      sessionId,
      backCommand.args.browserId,
      'back',
      registry,
      snapshotEngine,
    );
  },
  forward: ({ command, requestId, sessionId, registry, snapshotEngine }) => {
    const forwardCommand = command as Extract<BrowserCommand, { command: 'forward' }>;
    return executeNavigationAction(
      requestId,
      sessionId,
      forwardCommand.args.browserId,
      'forward',
      registry,
      snapshotEngine,
    );
  },
  reload: ({ command, requestId, sessionId, registry, snapshotEngine }) => {
    const reloadCommand = command as Extract<BrowserCommand, { command: 'reload' }>;
    return executeNavigationAction(
      requestId,
      sessionId,
      reloadCommand.args.browserId,
      'reload',
      registry,
      snapshotEngine,
    );
  },
  screenshot: ({ command, requestId, sessionId, registry }) => {
    const screenshotCommand = command as Extract<BrowserCommand, { command: 'screenshot' }>;
    return executeScreenshot(
      requestId,
      sessionId,
      screenshotCommand.args.browserId,
      screenshotCommand.args.fullPage ?? false,
      registry,
    );
  },
  select: ({ command, requestId, sessionId, registry, snapshotEngine }) => {
    const selectCommand = command as Extract<BrowserCommand, { command: 'select' }>;
    return executeSelect(
      requestId,
      sessionId,
      selectCommand.args.browserId,
      selectCommand.args.ref,
      selectCommand.args.value,
      registry,
      snapshotEngine,
    );
  },
  hover: ({ command, requestId, sessionId, registry, snapshotEngine }) => {
    const hoverCommand = command as Extract<BrowserCommand, { command: 'hover' }>;
    return executeHover(
      requestId,
      sessionId,
      hoverCommand.args.browserId,
      hoverCommand.args.ref,
      registry,
      snapshotEngine,
    );
  },
  drag: ({ command, requestId, sessionId, registry, snapshotEngine }) => {
    const dragCommand = command as Extract<BrowserCommand, { command: 'drag' }>;
    return executeDrag(
      requestId,
      sessionId,
      dragCommand.args.browserId,
      dragCommand.args.sourceRef,
      dragCommand.args.targetRef,
      registry,
      snapshotEngine,
    );
  },
  logs: ({ command, requestId, sessionId, registry }) => {
    const logsCommand = command as Extract<BrowserCommand, { command: 'logs' }>;
    return executeLogs(
      requestId,
      sessionId,
      logsCommand.args.browserId,
      logsCommand.args.maxEntries ?? DEFAULT_LOG_ENTRIES,
      registry,
    );
  },
  scroll: ({ command, requestId, sessionId, registry, snapshotEngine }) => {
    const scrollCommand = command as Extract<BrowserCommand, { command: 'scroll' }>;
    return executeScroll(
      requestId,
      sessionId,
      scrollCommand.args.browserId,
      scrollCommand.args.ref,
      scrollCommand.args.deltaX,
      scrollCommand.args.deltaY,
      registry,
      snapshotEngine,
    );
  },
};

interface ResolvedTabTarget {
  browserId: string;
  contents: TabContents;
}

async function executeSnapshot(
  requestId: string,
  sessionId: string | undefined,
  args: Extract<BrowserCommand, { command: 'snapshot' }>['args'],
  registry: BrowserRegistry,
  snapshotEngine: BrowserSnapshotEngine,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({
    requestId,
    sessionId,
    browserId: args.browserId,
    registry,
  });
  if ('ok' in target) {
    return target;
  }

  return withDialogCapture(target.contents, async () => {
    let frame: { id: string; page: SnapshotPage } | undefined;
    if (args.frame !== undefined) {
      const found = await resolveFrame(requestId, target.contents, args.frame);
      if ('ok' in found) return found;
      frame = { id: found.id, page: found.page };
    }
    const snapshot = await snapshotEngine.snapshot({
      browserId: target.browserId,
      page: target.contents,
      offset: args.offset ?? 0,
      frames: () => target.contents.listFrames?.() ?? Promise.resolve([]),
      ...(args.selector !== undefined && { selector: args.selector }),
      ...(args.ref !== undefined && { ref: args.ref }),
      ...(frame !== undefined && { frame }),
      ...(args.viewportOnly === true && { viewportOnly: true }),
      ...(args.maxNodes !== undefined && { maxNodes: args.maxNodes }),
    });
    if ('ok' in snapshot) {
      if (snapshot.reason === 'invalid_selector') {
        return fail(
          requestId,
          'browser_invalid_argument',
          `The selector ${JSON.stringify(args.selector)} is not valid: ${snapshot.message}`,
        );
      }
      if (snapshot.reason === 'not_found') {
        return fail(
          requestId,
          'browser_invalid_argument',
          `No element matches the selector ${JSON.stringify(args.selector)}${args.frame ? ` in frame ${args.frame}` : ''}. Check it with browser_query, or snapshot the whole page.`,
        );
      }
      return staleRefFailure(requestId, args.ref ?? '', snapshot.reason);
    }

    return {
      requestId,
      ok: true,
      result: {
        command: 'snapshot',
        browserId: target.browserId,
        url: target.contents.getURL(),
        title: target.contents.getTitle(),
        ...snapshot,
      },
    };
  });
}

async function executeClick(
  requestId: string,
  sessionId: string | undefined,
  browserId: string,
  ref: string,
  options: ClickInputOptions,
  registry: BrowserRegistry,
  snapshotEngine: BrowserSnapshotEngine,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, sessionId, browserId, registry });
  if ('ok' in target) {
    return target;
  }
  return withDialogCapture(target.contents, async () => {
    if (!target.contents.sendDebugCommand) {
      return fail(requestId, 'browser_unsupported', 'browser_click requires trusted browser input');
    }
    const actionable = await actionableRef(requestId, target, snapshotEngine, ref);
    if (!actionable.ok) return actionable.failure;
    await dispatchTrustedClick(cdpSender(target.contents), actionable.target.point, options);
    return {
      requestId,
      ok: true,
      result: {
        command: 'click',
        browserId: target.browserId,
        ref,
        x: actionable.target.point.x,
        y: actionable.target.point.y,
      },
    };
  });
}

async function executeFill(
  requestId: string,
  sessionId: string | undefined,
  browserId: string,
  ref: string,
  value: string,
  registry: BrowserRegistry,
  snapshotEngine: BrowserSnapshotEngine,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, sessionId, browserId, registry });
  if ('ok' in target) {
    return target;
  }
  return withDialogCapture(target.contents, async () => {
    const located = await refPage(requestId, target, snapshotEngine, ref);
    if (!located.ok) return located.failure;
    const result = await snapshotEngine.fill({
      browserId: target.browserId,
      page: located.page,
      ref,
      value,
    });
    if (!result.ok) {
      return refActionFailure(requestId, ref, result);
    }
    return { requestId, ok: true, result: { command: 'fill', browserId: target.browserId, ref } };
  });
}

async function executeSelect(
  requestId: string,
  sessionId: string | undefined,
  browserId: string,
  ref: string,
  value: string,
  registry: BrowserRegistry,
  snapshotEngine: BrowserSnapshotEngine,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, sessionId, browserId, registry });
  if ('ok' in target) {
    return target;
  }
  return withDialogCapture(target.contents, async () => {
    const located = await refPage(requestId, target, snapshotEngine, ref);
    if (!located.ok) return located.failure;
    const result = await snapshotEngine.select({
      browserId: target.browserId,
      page: located.page,
      ref,
      value,
    });
    if (!result.ok) {
      return refActionFailure(requestId, ref, result);
    }
    return {
      requestId,
      ok: true,
      result: { command: 'select', browserId: target.browserId, ref, value },
    };
  });
}

async function executeHover(
  requestId: string,
  sessionId: string | undefined,
  browserId: string,
  ref: string,
  registry: BrowserRegistry,
  snapshotEngine: BrowserSnapshotEngine,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, sessionId, browserId, registry });
  if ('ok' in target) {
    return target;
  }
  return withDialogCapture(target.contents, async () => {
    if (!target.contents.sendDebugCommand) {
      return fail(requestId, 'browser_unsupported', 'browser_hover requires trusted browser input');
    }
    const actionable = await actionableRef(requestId, target, snapshotEngine, ref);
    if (!actionable.ok) return actionable.failure;
    await dispatchTrustedHover(cdpSender(target.contents), actionable.target.point);
    return {
      requestId,
      ok: true,
      result: {
        command: 'hover',
        browserId: target.browserId,
        ref,
        x: actionable.target.point.x,
        y: actionable.target.point.y,
      },
    };
  });
}

async function executeDrag(
  requestId: string,
  sessionId: string | undefined,
  browserId: string,
  sourceRef: string,
  targetRef: string,
  registry: BrowserRegistry,
  snapshotEngine: BrowserSnapshotEngine,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, sessionId, browserId, registry });
  if ('ok' in target) {
    return target;
  }
  return withDialogCapture(target.contents, async () => {
    if (!target.contents.sendDebugCommand) {
      return fail(requestId, 'browser_unsupported', 'browser_drag requires trusted browser input');
    }
    const source = await actionableRef(requestId, target, snapshotEngine, sourceRef);
    if (!source.ok) return source.failure;
    const dropTarget = await actionableRef(requestId, target, snapshotEngine, targetRef);
    if (!dropTarget.ok) return dropTarget.failure;
    await dispatchTrustedDrag(
      cdpSender(target.contents),
      source.target.point,
      dropTarget.target.point,
    );
    return {
      requestId,
      ok: true,
      result: {
        command: 'drag',
        browserId: target.browserId,
        sourceRef,
        targetRef,
        sourceX: source.target.point.x,
        sourceY: source.target.point.y,
        targetX: dropTarget.target.point.x,
        targetY: dropTarget.target.point.y,
      },
    };
  });
}

async function executeLogs(
  requestId: string,
  sessionId: string | undefined,
  browserId: string,
  maxEntries: number,
  registry: BrowserRegistry,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, sessionId, browserId, registry });
  if ('ok' in target) {
    return target;
  }
  return withDialogCapture(target.contents, async () => {
    const consoleMessages = target.contents.getConsoleMessages?.() ?? [];
    const networkLog = target.contents.getNetworkLog?.() ?? {
      entries: parseNetworkEntries(
        await target.contents.executeJavaScript(NETWORK_PERFORMANCE_SCRIPT),
      ),
      total: undefined,
    };
    return {
      requestId,
      ok: true,
      result: {
        command: 'logs',
        browserId: target.browserId,
        console: consoleMessages.slice(-maxEntries),
        network: networkLog.entries.slice(-maxEntries),
        consoleTotal: target.contents.getConsoleTotal?.() ?? consoleMessages.length,
        networkTotal: networkLog.total ?? networkLog.entries.length,
      },
    };
  });
}

async function executeScroll(
  requestId: string,
  sessionId: string | undefined,
  browserId: string,
  ref: string | undefined,
  deltaX: number,
  deltaY: number,
  registry: BrowserRegistry,
  snapshotEngine: BrowserSnapshotEngine,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, sessionId, browserId, registry });
  if ('ok' in target) {
    return target;
  }
  return withDialogCapture(target.contents, async () => {
    if (!target.contents.sendDebugCommand) {
      return fail(
        requestId,
        'browser_unsupported',
        'browser_scroll requires trusted browser input',
      );
    }

    let point: { x: number; y: number };
    if (ref) {
      const actionable = await actionableRef(requestId, target, snapshotEngine, ref);
      if (!actionable.ok) return actionable.failure;
      point = actionable.target.point;
    } else {
      point = await readViewportCenter(target.contents);
    }

    await dispatchTrustedScroll(cdpSender(target.contents), point, deltaX, deltaY);
    return {
      requestId,
      ok: true,
      result: {
        command: 'scroll',
        browserId: target.browserId,
        ...(ref ? { ref } : {}),
        deltaX,
        deltaY,
        x: point.x,
        y: point.y,
      },
    };
  });
}

async function readViewportCenter(contents: TabContents): Promise<{ x: number; y: number }> {
  const value = await contents.executeJavaScript(
    '({ x: Math.max(0, (window.innerWidth || 1) / 2), y: Math.max(0, (window.innerHeight || 1) / 2) })',
  );
  if (!value || typeof value !== 'object') {
    return { x: 0, y: 0 };
  }
  const record = value as Record<string, unknown>;
  return {
    x: readNumber(record.x) ?? 0,
    y: readNumber(record.y) ?? 0,
  };
}

/** 引用用不了：`missing_ref` 是最近一次快照里没有它，`stale_ref` 是页面在快照之后变了（或还没取过快照）。 */
function staleRefFailure(
  requestId: string,
  ref: string,
  reason: 'stale_ref' | 'missing_ref' = 'stale_ref',
): FailurePayload {
  return fail(
    requestId,
    'browser_stale_ref',
    reason === 'missing_ref'
      ? `Browser element reference ${ref} is not in the latest snapshot of this tab.`
      : `Browser element reference ${ref} is stale: the page changed after the snapshot, or no snapshot was taken since it loaded.`,
  );
}

/** 文件输入框填不了字：文件经 browser_upload 交给它（只许会话文件夹里的）。 */
function fileInputFailure(requestId: string, ref: string): FailurePayload {
  return fail(
    requestId,
    'browser_unsupported',
    `${ref} is a file input; browser_fill cannot set files. Use browser_upload with this ref and the paths of files in this session's folder.`,
  );
}

function refActionFailure(
  requestId: string,
  ref: string,
  result: Exclude<BrowserRefActionResult, { ok: true }>,
): FailurePayload {
  if (result.reason === 'file_input') return fileInputFailure(requestId, ref);
  if (result.reason === 'not_fillable') {
    return fail(
      requestId,
      'browser_unsupported',
      `${ref} cannot be filled${result.detail ? `: ${result.detail}` : ''}. Use browser_click, browser_type or browser_select instead.`,
    );
  }
  return staleRefFailure(requestId, ref, result.reason);
}

function actionabilityFailure(
  requestId: string,
  ref: string,
  result: Exclude<ActionabilityResult, { ok: true }>,
): FailurePayload {
  if (result.reason === 'stale_ref') {
    return staleRefFailure(requestId, ref);
  }
  if (result.reason === 'file_input') return fileInputFailure(requestId, ref);
  const why = result.detail && result.detail !== 'not actionable' ? ` (${result.detail})` : '';
  return fail(
    requestId,
    'browser_timeout',
    `Browser element ${ref} did not become usable within 5 s${why}. Take a new browser_snapshot to see its state.`,
    true,
  );
}

function cdpSender(contents: TabContents): NonNullable<TabContents['sendDebugCommand']> {
  return contents.sendDebugCommand?.bind(contents) as NonNullable<TabContents['sendDebugCommand']>;
}

type WaitArgs = Extract<BrowserCommand, { command: 'wait' }>['args'];

/** 网络空闲默认要持续多久。 */
const DEFAULT_NETWORK_IDLE_MS = 500;

async function executeWait(
  requestId: string,
  sessionId: string | undefined,
  browserId: string,
  condition: WaitArgs,
  registry: BrowserRegistry,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, sessionId, browserId, registry });
  if ('ok' in target) {
    return target;
  }
  return withDialogCapture(target.contents, async () => {
    const kinds = [
      condition.text !== undefined,
      condition.url !== undefined,
      condition.urlRegex !== undefined,
      condition.selector !== undefined,
      condition.networkIdle === true,
    ].filter(Boolean).length;
    if (kinds !== 1) {
      return fail(
        requestId,
        'browser_invalid_argument',
        'browser_wait needs exactly one of text, url, urlRegex, selector or networkIdle.',
      );
    }
    let urlPattern: RegExp | undefined;
    if (condition.urlRegex !== undefined) {
      try {
        urlPattern = new RegExp(condition.urlRegex);
      } catch (error) {
        return fail(
          requestId,
          'browser_invalid_argument',
          `urlRegex is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    // 文字与元素可以在 frame 里；frame 换了文档时下一轮重新找。
    let framePage: SnapshotPage | undefined;
    const pageForCheck = async (): Promise<SnapshotPage | FailurePayload> => {
      if (condition.frame === undefined) return target.contents;
      if (framePage) return framePage;
      const found = await resolveFrame(requestId, target.contents, condition.frame);
      if ('ok' in found) return found;
      framePage = found.page;
      return framePage;
    };
    const state = condition.state ?? 'visible';
    const idleMs = condition.idleMs ?? DEFAULT_NETWORK_IDLE_MS;
    let idleSince: number | undefined;
    let lastFrameFailure: FailurePayload | undefined;
    const matched = (kind: string): AutomationCommandPayload => ({
      requestId,
      ok: true,
      result: { command: 'wait', browserId: target.browserId, matched: kind },
    });

    const timeoutMs = condition.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    do {
      if (condition.url !== undefined && target.contents.getURL().includes(condition.url)) {
        return matched('url');
      }
      if (urlPattern?.test(target.contents.getURL())) return matched('url');
      if (condition.networkIdle === true) {
        const pending = pendingRequests(target.contents).length;
        if (pending > 0) {
          idleSince = undefined;
        } else {
          idleSince ??= Date.now();
          if (Date.now() - idleSince >= idleMs) return matched('network_idle');
        }
      }
      if (condition.text !== undefined || condition.selector !== undefined) {
        const page = await pageForCheck();
        if ('ok' in page) {
          lastFrameFailure = page;
        } else {
          lastFrameFailure = undefined;
          if (condition.text !== undefined) {
            const pageText = await page
              .executeJavaScript("document.body ? document.body.innerText || '' : ''")
              .catch(() => {
                framePage = undefined;
                return '';
              });
            if (typeof pageText === 'string' && pageText.includes(condition.text)) {
              return matched('text');
            }
          } else if (condition.selector !== undefined) {
            const current = await page
              .executeJavaScript(elementStateScript(condition.selector))
              .catch(() => {
                framePage = undefined;
                return undefined;
              });
            if (current === 'invalid') {
              return fail(
                requestId,
                'browser_invalid_argument',
                `The selector ${JSON.stringify(condition.selector)} is not valid.`,
              );
            }
            if (typeof current === 'string' && elementStateMatches(current, state)) {
              return matched('selector');
            }
          }
        }
      }
      await delay(WAIT_POLL_INTERVAL_MS);
    } while (Date.now() < deadline);

    if (lastFrameFailure) return lastFrameFailure;
    const waited = `${Math.round(timeoutMs / 100) / 10} s`;
    const where = condition.frame !== undefined ? ` in frame ${condition.frame}` : '';
    if (condition.text !== undefined) {
      return fail(
        requestId,
        'browser_timeout',
        `The page did not show the text ${JSON.stringify(condition.text)}${where} within ${waited}. Take a browser_snapshot to see what it shows.`,
        true,
      );
    }
    if (condition.selector !== undefined) {
      return fail(
        requestId,
        'browser_timeout',
        `No element matching ${JSON.stringify(condition.selector)}${where} became ${state} within ${waited}. Check it with browser_query or take a browser_snapshot.`,
        true,
      );
    }
    if (condition.networkIdle === true) {
      const pending = pendingRequests(target.contents);
      const listed = pending
        .slice(0, 5)
        .map((entry) => `${entry.method ?? 'GET'} ${entry.url}`)
        .join('; ');
      return fail(
        requestId,
        'browser_timeout',
        `The network did not stay idle for ${idleMs} ms within ${waited}; ${pending.length} request${pending.length === 1 ? ' is' : 's are'} still running${listed ? `: ${listed}` : ''}${pending.length > 5 ? '; …' : ''}. Long-polling or streaming requests never finish; use browser_wait with text or selector instead.`,
        true,
      );
    }
    return fail(
      requestId,
      'browser_timeout',
      `The tab's URL did not ${urlPattern ? `match ${String(urlPattern)}` : `contain ${JSON.stringify(condition.url)}`} within ${waited} (it is ${target.contents.getURL()}). Take a browser_snapshot to see the page.`,
      true,
    );
  });
}

/** 当前页面还没结束的请求。 */
function pendingRequests(contents: TabContents): BrowserNetworkEntry[] {
  return (contents.getNetworkLog?.().entries ?? []).filter((entry) => entry.pending === true);
}

/** 元素现在的状态：`detached`（没有）、`visible`、`hidden`，选择器不对是 `invalid`。 */
function elementStateScript(selector: string): string {
  return `(() => {
    let element;
    try {
      element = document.querySelector(${JSON.stringify(selector)});
    } catch {
      return 'invalid';
    }
    if (!element) return 'detached';
    const view = (element.ownerDocument && element.ownerDocument.defaultView) || window;
    const rect = element.getBoundingClientRect();
    const style = view.getComputedStyle(element);
    const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' &&
      style.display !== 'none' && Number(style.opacity || '1') !== 0;
    return visible ? 'visible' : 'hidden';
  })()`;
}

function elementStateMatches(current: string, wanted: string): boolean {
  switch (wanted) {
    case 'attached':
      return current !== 'detached';
    case 'detached':
      return current === 'detached';
    case 'hidden':
      return current !== 'visible';
    default:
      return current === 'visible';
  }
}

async function executeType(
  requestId: string,
  sessionId: string | undefined,
  browserId: string,
  ref: string | undefined,
  text: string,
  registry: BrowserRegistry,
  snapshotEngine: BrowserSnapshotEngine,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, sessionId, browserId, registry });
  if ('ok' in target) {
    return target;
  }
  return withDialogCapture(target.contents, async () => {
    if (!target.contents.sendDebugCommand) {
      return fail(requestId, 'browser_unsupported', 'browser_type requires trusted browser input');
    }
    let actionable: Extract<ActionableRef, { ok: true }> | null = null;
    if (ref) {
      const located = await actionableRef(requestId, target, snapshotEngine, ref, true);
      if (!located.ok) return located.failure;
      actionable = located;
      await dispatchTrustedClick(cdpSender(target.contents), actionable.target.point);
    }
    // 焦点在跨进程的 iframe 里时 webContents.insertText 会把页面卡死（Electron 44），改用 CDP 的 Input.insertText。
    if (await focusIsInRemoteFrame(target.contents)) {
      await cdpSender(target.contents)('Input.insertText', { text });
    } else {
      await target.contents.insertText(text);
    }
    return {
      requestId,
      ok: true,
      result: {
        command: 'type',
        browserId: target.browserId,
        ...(ref ? { ref } : {}),
        ...(actionable ? { x: actionable.target.point.x, y: actionable.target.point.y } : {}),
      },
    };
  });
}

async function executeKeypress(
  requestId: string,
  sessionId: string | undefined,
  browserId: string,
  ref: string | undefined,
  key: string,
  registry: BrowserRegistry,
  snapshotEngine: BrowserSnapshotEngine,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, sessionId, browserId, registry });
  if ('ok' in target) {
    return target;
  }
  return withDialogCapture(target.contents, async () => {
    let actionable: Extract<ActionableRef, { ok: true }> | null = null;
    if (ref) {
      const located = await actionableRef(requestId, target, snapshotEngine, ref);
      if (!located.ok) return located.failure;
      actionable = located;
      const focused = await focusKeypressTarget(located.page, located.expression);
      if (focused === 'stale_ref') {
        return staleRefFailure(requestId, ref);
      }
      if (focused === 'editable') {
        if (!target.contents.sendDebugCommand) {
          return fail(
            requestId,
            'browser_unsupported',
            'browser_keypress requires trusted browser input',
          );
        }
        await dispatchTrustedClick(cdpSender(target.contents), actionable.target.point);
      }
    }
    if (target.contents.sendDebugCommand && (await focusIsInRemoteFrame(target.contents))) {
      await dispatchCdpKey(cdpSender(target.contents), key);
    } else {
      dispatchTrustedKey((event) => target.contents.sendInputEvent(event), key);
    }
    return {
      requestId,
      ok: true,
      result: {
        command: 'keypress',
        browserId: target.browserId,
        key,
        ...(ref ? { ref } : {}),
        ...(actionable ? { x: actionable.target.point.x, y: actionable.target.point.y } : {}),
      },
    };
  });
}

async function executeNavigate(
  requestId: string,
  sessionId: string | undefined,
  browserId: string,
  url: string,
  registry: BrowserRegistry,
  snapshotEngine: BrowserSnapshotEngine,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, sessionId, browserId, registry });
  if ('ok' in target) {
    return target;
  }
  return withDialogCapture(target.contents, async () => {
    if (!isAllowedPageUrl(url)) {
      return fail(
        requestId,
        'browser_denied',
        'Browser navigation only supports http and https URLs.',
      );
    }
    snapshotEngine.clearBrowser(browserId);
    await target.contents.loadURL(url);
    return {
      requestId,
      ok: true,
      result: { command: 'navigate', browserId: target.browserId, url },
    };
  });
}

async function executeNavigationAction(
  requestId: string,
  sessionId: string | undefined,
  browserId: string,
  action: 'back' | 'forward' | 'reload',
  registry: BrowserRegistry,
  snapshotEngine: BrowserSnapshotEngine,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, sessionId, browserId, registry });
  if ('ok' in target) {
    return target;
  }
  return withDialogCapture(target.contents, async () => {
    if (action === 'back') {
      if (!target.contents.canGoBack()) {
        return fail(requestId, 'browser_denied', 'There is nothing to go back to.');
      }
      snapshotEngine.clearBrowser(browserId);
      target.contents.goBack();
      return { requestId, ok: true, result: { command: 'back', browserId: target.browserId } };
    }
    if (action === 'forward') {
      if (!target.contents.canGoForward()) {
        return fail(requestId, 'browser_denied', 'There is nothing to go forward to.');
      }
      snapshotEngine.clearBrowser(browserId);
      target.contents.goForward();
      return { requestId, ok: true, result: { command: 'forward', browserId: target.browserId } };
    }
    snapshotEngine.clearBrowser(browserId);
    target.contents.reload();
    return { requestId, ok: true, result: { command: 'reload', browserId: target.browserId } };
  });
}

async function executeScreenshot(
  requestId: string,
  sessionId: string | undefined,
  browserId: string,
  fullPage: boolean,
  registry: BrowserRegistry,
): Promise<AutomationCommandPayload> {
  if (fullPage) {
    return executeFullPageScreenshot(requestId, sessionId, browserId, registry);
  }

  const target = resolveTabTarget({ requestId, sessionId, browserId, registry });
  if ('ok' in target) {
    return target;
  }
  return withDialogCapture(target.contents, async () => {
    let image: TabImage;
    try {
      image = await capturePaintedViewport(target.contents);
    } catch (error) {
      if (error instanceof BrowserTabClosedError) {
        return fail(requestId, 'browser_tab_closed', `Browser tab ${browserId} has been closed`);
      }
      if (isScreenshotNoFrameError(error)) {
        return screenshotNoFrameFailure(requestId, error);
      }
      throw error;
    }
    const size = image.getSize();
    const png = image.toPNG();
    if (png.byteLength > BROWSER_SCREENSHOT_MAX_BYTES) return screenshotTooLarge(requestId);
    return {
      requestId,
      ok: true,
      result: {
        command: 'screenshot',
        browserId: target.browserId,
        mimeType: 'image/png',
        dataBase64: Buffer.from(png).toString('base64'),
        width: size.width,
        height: size.height,
      },
    };
  });
}

interface CdpLayoutMetrics {
  cssLayoutViewport?: {
    clientWidth?: number;
    clientHeight?: number;
  };
  layoutViewport?: {
    clientWidth?: number;
    clientHeight?: number;
  };
  cssContentSize?: {
    width?: number;
    height?: number;
  };
  contentSize?: {
    width?: number;
    height?: number;
  };
}

interface CdpCaptureScreenshotResult {
  data?: string;
}

async function getCdpLayoutMetrics(contents: TabContents): Promise<{
  viewportWidth: number;
  viewportHeight: number;
  contentWidth: number;
  contentHeight: number;
}> {
  if (!contents.sendDebugCommand) {
    return { viewportWidth: 0, viewportHeight: 0, contentWidth: 0, contentHeight: 0 };
  }
  const metrics = (await contents.sendDebugCommand('Page.getLayoutMetrics')) as CdpLayoutMetrics;
  const viewport = metrics.cssLayoutViewport ?? metrics.layoutViewport;
  const contentSize = metrics.cssContentSize ?? metrics.contentSize;
  return {
    viewportWidth: Math.ceil(viewport?.clientWidth ?? 0),
    viewportHeight: Math.ceil(viewport?.clientHeight ?? 0),
    contentWidth: Math.ceil(contentSize?.width ?? 0),
    contentHeight: Math.ceil(contentSize?.height ?? 0),
  };
}

async function executeFullPageScreenshot(
  requestId: string,
  sessionId: string | undefined,
  browserId: string,
  registry: BrowserRegistry,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, sessionId, browserId, registry });
  if ('ok' in target) {
    return target;
  }
  return withDialogCapture(target.contents, async () => {
    if (!target.contents.sendDebugCommand) {
      return fail(requestId, 'browser_unsupported', 'browser_screenshot fullPage requires CDP');
    }
    const sendDebugCommand = target.contents.sendDebugCommand.bind(target.contents);
    let screenshot: CdpCaptureScreenshotResult;
    let width = 0;
    let height = 0;
    try {
      screenshot = await runPaintedPixelCapture(target.contents, async () => {
        const metrics = await getCdpLayoutMetrics(target.contents);
        width = Math.min(metrics.contentWidth, FULL_PAGE_MAX_PX);
        height = Math.min(metrics.contentHeight, FULL_PAGE_MAX_PX);
        return (await sendDebugCommand('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width, height, scale: 1 },
        })) as CdpCaptureScreenshotResult;
      });
    } catch (error) {
      if (isScreenshotNoFrameError(error)) {
        return screenshotNoFrameFailure(requestId, error);
      }
      throw error;
    }
    if (!screenshot.data) {
      return fail(requestId, 'browser_unsupported', 'browser_screenshot fullPage returned no data');
    }
    if ((screenshot.data.length * 3) / 4 > BROWSER_SCREENSHOT_MAX_BYTES) {
      return screenshotTooLarge(requestId);
    }
    return {
      requestId,
      ok: true,
      result: {
        command: 'screenshot',
        browserId: target.browserId,
        mimeType: 'image/png',
        dataBase64: screenshot.data,
        width,
        height,
      },
    };
  });
}

/** 整页截图的宽高上限（CSS 像素）。 */
const FULL_PAGE_MAX_PX = 8_000;

function screenshotTooLarge(requestId: string): FailurePayload {
  return fail(
    requestId,
    'browser_unsupported',
    `The screenshot is larger than ${BROWSER_SCREENSHOT_MAX_BYTES / 1024 / 1024} MB. Take a viewport screenshot or use browser_snapshot.`,
  );
}

function isAllowedPageUrl(value: string): boolean {
  try {
    return ALLOWED_PAGE_URL_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseNetworkEntries(value: unknown): NetworkLogEntry[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.flatMap((entry): NetworkLogEntry[] => {
    if (!entry || typeof entry !== 'object') {
      return [];
    }
    const record = entry as Record<string, unknown>;
    const url = readString(record.url);
    const startTime = readNumber(record.startTime);
    const duration = readNumber(record.duration);
    if (!url || startTime === null || duration === null) {
      return [];
    }
    return [
      {
        url,
        ...(readString(record.method) ? { method: readString(record.method) ?? undefined } : {}),
        ...(readNumber(record.status) !== null
          ? { status: readNumber(record.status) ?? undefined }
          : {}),
        ...(readString(record.type) ? { type: readString(record.type) ?? undefined } : {}),
        startTime,
        duration,
        ...(readNumber(record.transferSize) !== null
          ? { transferSize: readNumber(record.transferSize) ?? undefined }
          : {}),
      },
    ];
  });
}

async function focusKeypressTarget(
  contents: SnapshotPage,
  elementExpression: string,
): Promise<'editable' | 'focused' | 'stale_ref'> {
  const result = await contents.executeJavaScript(`(() => {
    const element = ${elementExpression};
    if (!element) return { staleRef: true };
    const tagName = element.tagName ? element.tagName.toLowerCase() : '';
    const inputType = tagName === 'input' ? String(element.getAttribute('type') || 'text').toLowerCase() : '';
    const editableInput = tagName === 'textarea' ||
      (tagName === 'input' && !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(inputType));
    const editable = editableInput || element.isContentEditable === true;
    if (!editable && typeof element.focus === 'function') {
      element.focus({ preventScroll: true });
    }
    return { editable };
  })()`);
  if (!result || typeof result !== 'object') {
    return 'stale_ref';
  }
  const record = result as Record<string, unknown>;
  if (record.staleRef === true) {
    return 'stale_ref';
  }
  return record.editable === true ? 'editable' : 'focused';
}

function readString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const NETWORK_PERFORMANCE_SCRIPT = `(() => {
  const entries = performance.getEntriesByType('resource')
    .concat(performance.getEntriesByType('navigation'))
    .slice(-200)
    .map((entry) => ({
      url: entry.name,
      // Resource Timing 没有请求方法；状态码是 Chromium 109 起的 responseStatus（跨域没有 Timing-Allow-Origin 时为 0）。
      status: entry.responseStatus > 0 ? entry.responseStatus : undefined,
      type: entry.initiatorType,
      startTime: entry.startTime,
      duration: entry.duration,
      transferSize: typeof entry.transferSize === 'number' ? entry.transferSize : undefined,
    }));
  return JSON.stringify(entries);
})()`;

function resolveTabTarget(input: {
  requestId: string;
  sessionId: string | undefined;
  browserId: string;
  registry: BrowserRegistry;
}): ResolvedTabTarget | FailurePayload {
  const { requestId, sessionId, browserId, registry } = input;
  // 只能操作自己会话的标签页（OpenWork 的标签页归属）：别的会话的当作不存在。
  if (registry.ownerOf(browserId) !== sessionId) {
    return fail(requestId, 'browser_tab_not_found', `No browser tab found for ID: ${browserId}`);
  }

  const contents = registry.getTabContents(browserId);
  if (!contents) {
    return fail(requestId, 'browser_tab_not_found', `No browser tab found for ID: ${browserId}`);
  }

  if (contents.isDestroyed()) {
    return fail(requestId, 'browser_tab_closed', `Browser tab ${browserId} has been closed`);
  }

  return { browserId, contents };
}

// ── 0.48.0：引用所在的 frame ─────────────────────────────────────────

/** 焦点是不是在读不到的（跨域）iframe 里：顺着 activeElement 走进同源的 iframe，走不进去的就是。 */
async function focusIsInRemoteFrame(contents: TabContents): Promise<boolean> {
  const result = await contents
    .executeJavaScript(`(() => {
      let element = document.activeElement;
      while (element && (element.tagName === 'IFRAME' || element.tagName === 'FRAME')) {
        let inner = null;
        try {
          inner = element.contentDocument;
        } catch {
          inner = null;
        }
        if (!inner) return true;
        element = inner.activeElement;
      }
      return false;
    })()`)
    .catch(() => false);
  return result === true;
}

type ActionableRef =
  | {
      ok: true;
      /** 顶层页面里的坐标。 */
      target: { point: { x: number; y: number } };
      /** 元素所在的页面（顶层或 frame）与在那里解析元素的表达式。 */
      page: SnapshotPage;
      expression: string;
    }
  | { ok: false; failure: FailurePayload };

/** 引用的元素所在的页面：顶层，或它所在的 frame（跨域的也行）。 */
async function refPage(
  requestId: string,
  target: ResolvedTabTarget,
  snapshotEngine: BrowserSnapshotEngine,
  ref: string,
): Promise<
  | { ok: true; page: SnapshotPage; frame: string; frames: TabFrame[]; expression: string }
  | { ok: false; failure: FailurePayload }
> {
  const expression = snapshotEngine.runtimeElementExpression({ browserId: target.browserId, ref });
  if (typeof expression !== 'string') {
    return { ok: false, failure: staleRefFailure(requestId, ref, expression.reason) };
  }
  const frame = snapshotEngine.refFrame({ browserId: target.browserId, ref });
  if (typeof frame !== 'string') {
    return { ok: false, failure: staleRefFailure(requestId, ref, frame.reason) };
  }
  if (frame === '') {
    return { ok: true, page: target.contents, frame, frames: [], expression };
  }
  const frames = (await target.contents.listFrames?.()) ?? [];
  const found = frames.find((candidate) => candidate.id === frame);
  if (!found) return { ok: false, failure: staleRefFailure(requestId, ref) };
  return { ok: true, page: found.page, frame, frames, expression };
}

/** 等引用的元素可以操作，给出顶层页面里的坐标（frame 里的逐层换算，并看它所在的 iframe 有没有被盖住）。 */
async function actionableRef(
  requestId: string,
  target: ResolvedTabTarget,
  snapshotEngine: BrowserSnapshotEngine,
  ref: string,
  editable = false,
): Promise<ActionableRef> {
  const located = await refPage(requestId, target, snapshotEngine, ref);
  if (!located.ok) return located;
  const actionable = await waitForActionableTarget({
    page: located.page,
    elementExpression: located.expression,
    editable,
  });
  if (!actionable.ok) {
    return { ok: false, failure: actionabilityFailure(requestId, ref, actionable) };
  }
  let point = actionable.target.point;
  if (located.frame !== '') {
    const top = await frameToTopPoint(target.contents, located.frames, located.frame, point);
    if (!top) return { ok: false, failure: staleRefFailure(requestId, ref) };
    if (top.covered) {
      return {
        ok: false,
        failure: fail(
          requestId,
          'browser_timeout',
          `Browser element ${ref} is in frame ${located.frame}, and that frame is covered or off screen at the element. Scroll it into view (browser_scroll) or take a new browser_snapshot.`,
          true,
        ),
      };
    }
    point = { x: top.x, y: top.y };
  }
  return { ok: true, target: { point }, page: located.page, expression: located.expression };
}

/** 按 agent 给的说法找 frame。 */
async function resolveFrame(
  requestId: string,
  contents: TabContents,
  spec: string,
): Promise<TabFrame | FailurePayload> {
  const frames = (await contents.listFrames?.()) ?? [];
  const found = findFrame(frames, spec);
  return found ?? fail(requestId, 'browser_invalid_argument', frameNotFoundMessage(frames, spec));
}

// ── 0.48.0：evaluate ─────────────────────────────────────────────────

/** 返回值序列化后最多多少字符时连同截断说明一起给（与协议的上限一致）。 */
const EVALUATE_DEFAULT_TIMEOUT_MS = 5_000;
const EVALUATE_ERROR_MAX_CHARS = 2_000;

type EvaluateArgs = Extract<BrowserCommand, { command: 'evaluate' }>['args'];

async function executeEvaluate(
  requestId: string,
  sessionId: string | undefined,
  args: EvaluateArgs,
  registry: BrowserRegistry,
  snapshotEngine: BrowserSnapshotEngine,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, sessionId, browserId: args.browserId, registry });
  if ('ok' in target) return target;
  // 只检查语法、不执行（与页面里一样包在 async 函数里，所以可以写 await）。
  const syntax = syntaxError(args.function);
  if (syntax !== undefined) {
    return fail(
      requestId,
      'browser_invalid_argument',
      `The function does not parse: ${syntax}. Pass a function like () => document.title, or async () => { …; return value; }.`,
    );
  }
  return withDialogCapture(target.contents, async () => {
    let page: SnapshotPage = target.contents;
    let elementExpression: string | undefined;
    if (args.ref !== undefined) {
      const located = await refPage(requestId, target, snapshotEngine, args.ref);
      if (!located.ok) return located.failure;
      page = located.page;
      elementExpression = located.expression;
    } else if (args.frame !== undefined) {
      const found = await resolveFrame(requestId, target.contents, args.frame);
      if ('ok' in found) return found;
      page = found.page;
    }
    const timeoutMs = args.timeoutMs ?? EVALUATE_DEFAULT_TIMEOUT_MS;
    const maxChars = args.maxBytes ?? BROWSER_EVALUATE_DEFAULT_BYTES;
    let raw: unknown;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      raw = await Promise.race([
        page.executeJavaScript(buildEvaluateScript(args.function, elementExpression, maxChars)),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(EVALUATE_TIMED_OUT), timeoutMs);
        }),
      ]);
    } catch (error) {
      return fail(
        requestId,
        'browser_script_error',
        clip(error instanceof Error ? error.message : String(error), EVALUATE_ERROR_MAX_CHARS),
      );
    } finally {
      clearTimeout(timer);
    }
    if (raw === EVALUATE_TIMED_OUT) {
      return fail(
        requestId,
        'browser_timeout',
        `The function did not finish within ${Math.round(timeoutMs / 100) / 10} s (it may still be running in the page). Return sooner, or pass a larger timeoutMs (at most 30000).`,
        true,
      );
    }
    const result = readEvaluateResult(raw);
    if (result.kind === 'stale_ref') return staleRefFailure(requestId, args.ref ?? '');
    if (result.kind === 'thrown') {
      return fail(
        requestId,
        'browser_script_error',
        clip(result.message, EVALUATE_ERROR_MAX_CHARS),
      );
    }
    return {
      requestId,
      ok: true,
      result: {
        command: 'evaluate',
        browserId: target.browserId,
        value: result.value,
        type: result.type,
        truncated: result.length > result.value.length,
        length: result.length,
      },
    };
  });
}

const EVALUATE_TIMED_OUT = Symbol('timed out');

/**
 * 用主进程的 V8 检查语法（`vm.Script` 只编译、不运行）；没问题时返回 undefined。包着源码的外壳会改变错误的样子（`() => {`
 * 少了一半时报 `Unexpected token ')'`，真正的问题是 `Unexpected end of input`），所以包着编译失败时再单独编译一次源码，
 * 取它的说法；单独编译只因为 `await` 失败时仍用包着的那条。
 */
export function syntaxError(source: string): string | undefined {
  try {
    new Script(`(async () => (\n${source}\n))`);
    return undefined;
  } catch (error) {
    const wrapped = error instanceof Error ? error.message : String(error);
    try {
      new Script(source);
    } catch (alone) {
      const message = alone instanceof Error ? alone.message : String(alone);
      if (!/\bawait\b/.test(message)) return message;
    }
    return wrapped;
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 页面里执行 agent 的函数（改写自 Paseo 的 buildEvaluateScript）：不用 eval（页面的 CSP 不允许时会失败），源码直接放进脚本；不是函数
 * 时就用它的值。返回值在页面里转成 JSON（元素、Map、Set、错误、循环引用、BigInt 都有写法），只把前 `maxChars` 个字符带回来。
 */
export function buildEvaluateScript(
  source: string,
  elementExpression: string | undefined,
  maxChars: number,
): string {
  return `(async () => {
    const describeElement = (element) => {
      const tag = String(element.tagName || element.nodeName || '').toLowerCase();
      const id = element.id ? '#' + element.id : '';
      const className = typeof element.getAttribute === 'function' ? element.getAttribute('class') : '';
      const classes = className ? '.' + String(className).trim().split(/\\s+/).slice(0, 3).join('.') : '';
      const text = String(element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
      return '<' + tag + id + classes + '>' + (text ? ' ' + text : '');
    };
    const normalize = (value, depth, seen) => {
      if (value === null) return null;
      const type = typeof value;
      if (type === 'string' || type === 'boolean') return value;
      if (type === 'number') return Number.isFinite(value) ? value : String(value);
      if (type === 'bigint') return value.toString() + 'n';
      if (type === 'undefined') return undefined;
      if (type === 'symbol') return value.toString();
      if (type === 'function') return '[Function ' + (value.name || 'anonymous') + ']';
      if (seen.includes(value)) return '[Circular]';
      if (depth > 12) return '[…]';
      try {
        if (value.window === value) return '[Window]';
      } catch {
        return '[Window]';
      }
      if (typeof value.nodeType === 'number') {
        return value.nodeType === 1 ? describeElement(value) : '#' + String(value.nodeName || 'node').toLowerCase();
      }
      const tag = Object.prototype.toString.call(value);
      if (tag === '[object Error]' || value instanceof Error) {
        return { name: String(value.name), message: String(value.message), ...(value.stack ? { stack: String(value.stack).split('\\n').slice(0, 6).join('\\n') } : {}) };
      }
      if (tag === '[object Date]') return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
      if (tag === '[object RegExp]') return String(value);
      const next = seen.concat([value]);
      if (tag === '[object Map]') {
        return { '[Map]': Array.from(value.entries()).slice(0, 1000).map(([key, item]) => [normalize(key, depth + 1, next), normalize(item, depth + 1, next) ?? null]) };
      }
      if (tag === '[object Set]') {
        return { '[Set]': Array.from(value.values()).slice(0, 1000).map((item) => normalize(item, depth + 1, next) ?? null) };
      }
      if (Array.isArray(value) || ArrayBuffer.isView(value) || (typeof value.length === 'number' && typeof value.item === 'function')) {
        const items = Array.from(value).slice(0, 1000).map((item) => normalize(item, depth + 1, next) ?? null);
        if (value.length > 1000) items.push('[… ' + (value.length - 1000) + ' more]');
        return items;
      }
      if (typeof value.toJSON === 'function') {
        try {
          return normalize(value.toJSON(), depth + 1, next);
        } catch {}
      }
      const out = {};
      const keys = Object.keys(value);
      for (const key of keys.slice(0, 1000)) {
        let item;
        try {
          item = value[key];
        } catch {
          item = '[Throws]';
        }
        const normalized = normalize(item, depth + 1, next);
        if (normalized !== undefined) out[key] = normalized;
      }
      if (keys.length > 1000) out['…'] = (keys.length - 1000) + ' more keys';
      return out;
    };
    const typeOf = (value) => {
      if (value === null) return 'null';
      if (Array.isArray(value)) return 'array';
      if (value && typeof value === 'object' && value.nodeType === 1) return 'element';
      return typeof value;
    };
    try {
      const candidate = (
${source}
);
      const args = [];
      ${
        elementExpression
          ? `const element = ${elementExpression};
      if (!element) return { staleRef: true };
      args.push(element);`
          : ''
      }
      const value = typeof candidate === 'function' ? await candidate(...args) : await candidate;
      const json = value === undefined ? 'undefined' : (JSON.stringify(normalize(value, 0, [])) ?? 'undefined');
      return { ok: true, type: typeOf(value), value: json.slice(0, ${JSON.stringify(maxChars)}), length: json.length };
    } catch (error) {
      const message = error && typeof error === 'object'
        ? String(error.name || 'Error') + ': ' + String(error.message)
        : 'Thrown: ' + String(error);
      return { thrown: message };
    }
  })()`;
}

function readEvaluateResult(
  value: unknown,
):
  | { kind: 'ok'; type: string; value: string; length: number }
  | { kind: 'thrown'; message: string }
  | { kind: 'stale_ref' } {
  if (!value || typeof value !== 'object') {
    return { kind: 'thrown', message: 'The page returned no result.' };
  }
  const record = value as Record<string, unknown>;
  if (record.staleRef === true) return { kind: 'stale_ref' };
  if (typeof record.thrown === 'string') return { kind: 'thrown', message: record.thrown };
  if (record.ok === true && typeof record.value === 'string') {
    return {
      kind: 'ok',
      type: readString(record.type) ?? 'unknown',
      value: record.value,
      length: readNumber(record.length) ?? record.value.length,
    };
  }
  return { kind: 'thrown', message: 'The page returned no result.' };
}

// ── 0.48.0：query、network、dialogs ──────────────────────────────────

const DEFAULT_QUERY_RESULTS = 20;

async function executeQuery(
  requestId: string,
  sessionId: string | undefined,
  args: Extract<BrowserCommand, { command: 'query' }>['args'],
  registry: BrowserRegistry,
  snapshotEngine: BrowserSnapshotEngine,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, sessionId, browserId: args.browserId, registry });
  if ('ok' in target) return target;
  return withDialogCapture(target.contents, async () => {
    let page: SnapshotPage = target.contents;
    let frame = '';
    let frames: TabFrame[] = [];
    if (args.frame !== undefined) {
      frames = (await target.contents.listFrames?.()) ?? [];
      const found = findFrame(frames, args.frame);
      if (!found) {
        return fail(
          requestId,
          'browser_invalid_argument',
          frameNotFoundMessage(frames, args.frame),
        );
      }
      page = found.page;
      frame = found.id;
    }
    const result = await snapshotEngine.query({
      browserId: target.browserId,
      page,
      frame,
      selector: args.selector,
      maxResults: args.maxResults ?? DEFAULT_QUERY_RESULTS,
      ...(args.attributes !== undefined && { attributes: args.attributes }),
    });
    if (!result.ok) {
      return fail(
        requestId,
        'browser_invalid_argument',
        `The selector ${JSON.stringify(args.selector)} is not valid: ${result.message}`,
      );
    }
    // frame 里的位置换算到顶层页面。
    let offset = { x: 0, y: 0 };
    if (frame !== '') {
      const top = await frameToTopPoint(target.contents, frames, frame, { x: 0, y: 0 });
      if (top) offset = { x: top.x, y: top.y };
    }
    const round = (value: number) => Math.round(value * 10) / 10;
    const elements: BrowserQueryElement[] = result.elements.map((element) => ({
      ref: element.ref,
      tag: element.tag,
      ...(element.id !== undefined && { id: element.id }),
      ...(element.classes !== undefined && { classes: element.classes }),
      text: element.text,
      visible: element.visible,
      box: {
        x: round(element.box.x + offset.x),
        y: round(element.box.y + offset.y),
        width: round(element.box.width),
        height: round(element.box.height),
      },
      ...(element.attributes !== undefined && { attributes: element.attributes }),
    }));
    return {
      requestId,
      ok: true,
      result: {
        command: 'query',
        browserId: target.browserId,
        selector: args.selector,
        count: result.count,
        elements,
      },
    };
  });
}

const DEFAULT_NETWORK_ENTRIES = 50;

async function executeNetwork(
  requestId: string,
  sessionId: string | undefined,
  args: Extract<BrowserCommand, { command: 'network' }>['args'],
  registry: BrowserRegistry,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, sessionId, browserId: args.browserId, registry });
  if ('ok' in target) return target;
  return withDialogCapture(target.contents, async () => {
    if (!target.contents.getNetworkLog) {
      return fail(requestId, 'browser_unsupported', 'This tab does not record network requests.');
    }
    const log = target.contents.getNetworkLog();
    let matched: BrowserNetworkEntry[];
    try {
      matched = filterNetwork(log.entries, args);
    } catch (error) {
      return fail(
        requestId,
        'browser_invalid_argument',
        error instanceof Error ? error.message : String(error),
      );
    }
    let detail: BrowserNetworkDetail | undefined;
    if (args.id !== undefined) {
      detail = target.contents.getNetworkDetail?.(args.id);
      if (!detail) {
        return fail(
          requestId,
          'browser_invalid_argument',
          `No network entry ${args.id} on the current page (the log starts over when a page loads, and clear empties it). List the entries without id first.`,
        );
      }
      if (args.body === true) {
        const body = await target.contents.getNetworkBody?.(
          args.id,
          args.maxBytes ?? BROWSER_EVALUATE_DEFAULT_BYTES,
        );
        if (body) detail = { ...detail, body };
      }
    }
    if (args.clear === true) target.contents.clearNetworkLog?.();
    return {
      requestId,
      ok: true,
      result: {
        command: 'network',
        browserId: target.browserId,
        entries: detail ? [] : matched.slice(-(args.maxEntries ?? DEFAULT_NETWORK_ENTRIES)),
        total: log.total,
        matched: matched.length,
        ...(detail && { detail }),
        ...(args.clear === true && { cleared: true }),
      },
    };
  });
}

async function executeDialogs(
  requestId: string,
  sessionId: string | undefined,
  args: Extract<BrowserCommand, { command: 'dialogs' }>['args'],
  registry: BrowserRegistry,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, sessionId, browserId: args.browserId, registry });
  if ('ok' in target) return target;
  return withDialogCapture(target.contents, async () => {
    if (!target.contents.setDialogPolicy) {
      return fail(
        requestId,
        'browser_unsupported',
        'This tab cannot change how dialogs are answered.',
      );
    }
    const current = target.contents.getDialogPolicy?.() ?? DEFAULT_DIALOG_POLICY;
    const prompt = args.prompt ?? current.prompt;
    const promptText = prompt === 'dismiss' ? undefined : (args.promptText ?? current.promptText);
    const policy: DialogPolicy = {
      confirm: args.confirm ?? current.confirm,
      prompt,
      ...(promptText !== undefined && { promptText }),
      beforeunload: args.beforeunload ?? current.beforeunload,
    };
    await target.contents.setDialogPolicy(policy);
    return {
      requestId,
      ok: true,
      result: { command: 'dialogs', browserId: target.browserId, policy },
    };
  });
}

// ── 0.48.0：upload ───────────────────────────────────────────────────

/** 点了之后等被拦下的选文件框最多多久。 */
const FILE_CHOOSER_WAIT_MS = 2_000;

async function executeUpload(
  requestId: string,
  sessionId: string | undefined,
  cwd: string,
  args: Extract<BrowserCommand, { command: 'upload' }>['args'],
  registry: BrowserRegistry,
  snapshotEngine: BrowserSnapshotEngine,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, sessionId, browserId: args.browserId, registry });
  if ('ok' in target) return target;
  // Host 已经核对过；这里再核对一遍（只在会话文件夹里、是普通文件），不信任请求。
  const files = sessionFiles(args.paths, cwd);
  if (typeof files === 'string') return fail(requestId, 'browser_denied', files);
  return withDialogCapture(target.contents, async () => {
    if (!target.contents.sendDebugCommand) {
      return fail(requestId, 'browser_unsupported', 'browser_upload requires CDP');
    }
    const send = cdpSender(target.contents);
    const paths = files.map((file) => file.path);
    let setTo: { objectId: string } | { backendNodeId: number } | undefined;
    let multiple = true;
    if (args.ref !== undefined) {
      const located = await refPage(requestId, target, snapshotEngine, args.ref);
      if (!located.ok) return located.failure;
      const kind =
        located.frame === ''
          ? await located.page
              .executeJavaScript(fileInputKindScript(located.expression))
              .catch(() => 'stale')
          : 'other';
      if (kind === 'stale') return staleRefFailure(requestId, args.ref);
      if (kind === 'single' || kind === 'multiple') {
        const evaluated = (await send('Runtime.evaluate', {
          expression: located.expression,
          objectGroup: 'wevir-browser-upload',
          returnByValue: false,
        })) as { result?: { objectId?: string; subtype?: string } };
        const objectId = evaluated.result?.objectId;
        if (!objectId || evaluated.result?.subtype === 'null') {
          return staleRefFailure(requestId, args.ref);
        }
        setTo = { objectId };
        multiple = kind === 'multiple';
      } else {
        // 不是文件输入框（多半是打开选文件框的按钮），或在跨域 frame 里：点它，接住被拦下的选文件框。
        target.contents.takeFileChooser?.();
        const actionable = await actionableRef(requestId, target, snapshotEngine, args.ref);
        if (!actionable.ok) return actionable.failure;
        await dispatchTrustedClick(send, actionable.target.point);
        const deadline = Date.now() + FILE_CHOOSER_WAIT_MS;
        let chooser = target.contents.takeFileChooser?.();
        while (!chooser && Date.now() < deadline) {
          await delay(50);
          chooser = target.contents.takeFileChooser?.();
        }
        if (!chooser) {
          return fail(
            requestId,
            'browser_unsupported',
            `Clicking ${args.ref} did not open a file chooser. Pass the ref of the file input (an input of type=file; it shows as a button in the snapshot), or the element that opens the chooser.`,
          );
        }
        setTo = { backendNodeId: chooser.backendNodeId };
        multiple = chooser.multiple;
      }
    } else {
      const chooser = target.contents.takeFileChooser?.();
      if (!chooser) {
        return fail(
          requestId,
          'browser_invalid_argument',
          'No file chooser is waiting for files. Click the element that opens it first (the result says the page asked for a file), or pass the ref of the file input.',
        );
      }
      setTo = { backendNodeId: chooser.backendNodeId };
      multiple = chooser.multiple;
    }
    if (!multiple && paths.length > 1) {
      return fail(
        requestId,
        'browser_invalid_argument',
        `This file input takes one file; ${paths.length} were given.`,
      );
    }
    await send('DOM.setFileInputFiles', { files: paths, ...setTo });
    return {
      requestId,
      ok: true,
      result: {
        command: 'upload',
        browserId: target.browserId,
        ...(args.ref !== undefined && { ref: args.ref }),
        files,
      },
    };
  });
}

/** 文件输入框是单选还是多选；不是文件输入框是 `other`，引用失效是 `stale`。 */
function fileInputKindScript(elementExpression: string): string {
  return `(() => {
    const element = ${elementExpression};
    if (!element) return 'stale';
    const isFile = element.tagName && element.tagName.toLowerCase() === 'input' &&
      String(element.getAttribute('type') || '').toLowerCase() === 'file';
    if (!isFile) return 'other';
    return element.multiple ? 'multiple' : 'single';
  })()`;
}

/**
 * 上传的文件：绝对路径（Host 已经按会话目录解析过），真实路径在会话文件夹里、是普通文件。不满足时返回说明。
 */
export function sessionFiles(
  paths: readonly string[],
  cwd: string,
): Array<{ path: string; size: number }> | string {
  let root: string;
  try {
    root = realpathSync(cwd);
  } catch {
    return `The session folder ${cwd} is not available.`;
  }
  const files: Array<{ path: string; size: number }> = [];
  for (const path of paths) {
    if (!isAbsolute(path)) return `${path} is not an absolute path.`;
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      return `${path} does not exist.`;
    }
    const inside = relative(root, real);
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
      return `${path} is outside the session folder; only files in ${cwd} can be uploaded.`;
    }
    const stat = statSync(real);
    if (!stat.isFile()) return `${path} is not a file.`;
    files.push({ path: real, size: stat.size });
  }
  return files;
}
