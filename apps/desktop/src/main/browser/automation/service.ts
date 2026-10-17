// SPDX-License-Identifier: Apache-2.0
// 改写自 getpaseo/paseo packages/desktop/src/features/browser-automation/service.ts
// 来源提交 dc7bc8db124e837ba909ffd3b4b20e16adaebe24
// Copyright (c) 2025-present Mohamed Boudra，Apache License 2.0
// 由 Wevir 修改：类型换成 Wevir 协议的（packages/protocol/src/browser.ts）；标签页按会话归属（`ownerOf`），不再按 Paseo 的 workspace；
// 去掉 evaluate 与 upload（Wevir 不提供在页面里跑任意脚本、把本机文件交给网页）以及 list_tabs、new_tab、resize、close_tab
// （标签页的开关、列出与显示在 browser-host.ts）；截图有大小上限（`BROWSER_SCREENSHOT_MAX_BYTES`），整页截图的高度有上限；
// 引用用不了时分开“快照里没有”与“页面变了”；网络记录带 Resource Timing 的状态码，不再给导航编一个 GET。

import {
  BROWSER_SCREENSHOT_MAX_BYTES,
  type BrowserCommand,
  type BrowserConsoleEntry,
  type BrowserErrorCode,
  type BrowserNetworkEntry,
  type BrowserRequest,
  type BrowserResponse,
} from '@wevir/protocol';
import { type ActionabilityResult, waitForActionableTarget } from './actionability.js';
import type { BrowserAutomationDialogEvent } from './dialog-handling.js';
import { BrowserSnapshotEngine } from './snapshot-engine.js';
import {
  type ClickInputOptions,
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
  captureDialogs?<T>(
    task: () => Promise<T>,
  ): Promise<{ result: T; dialogs: BrowserAutomationDialogEvent[] }>;
  sendDebugCommand?(command: string, params?: Record<string, unknown>): Promise<unknown>;
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
  const { result, dialogs } = await contents.captureDialogs(task);
  return dialogs.length > 0 ? { ...result, dialogs } : result;
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

/** 由 browser-host.ts 自己处理的命令（标签页的开关、列出与显示）。 */
export type HostHandledCommand = 'list_tabs' | 'new_tab' | 'close_tab' | 'show';

export function isHostHandled(command: BrowserCommand['command']): command is HostHandledCommand {
  return (
    command === 'list_tabs' ||
    command === 'new_tab' ||
    command === 'close_tab' ||
    command === 'show'
  );
}

const commandHandlers: Record<
  Exclude<BrowserCommand['command'], HostHandledCommand>,
  CommandHandler
> = {
  snapshot: ({ command, requestId, sessionId, registry, snapshotEngine }) => {
    const snapshotCommand = command as Extract<BrowserCommand, { command: 'snapshot' }>;
    return executeSnapshot(
      requestId,
      sessionId,
      snapshotCommand.args.browserId,
      registry,
      snapshotEngine,
    );
  },
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
      {
        text: waitCommand.args.text,
        url: waitCommand.args.url,
        timeoutMs: waitCommand.args.timeoutMs,
      },
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
  browserId: string,
  registry: BrowserRegistry,
  snapshotEngine: BrowserSnapshotEngine,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({
    requestId,
    sessionId,
    browserId,
    registry,
  });
  if ('ok' in target) {
    return target;
  }

  return withDialogCapture(target.contents, async () => {
    const snapshot = await snapshotEngine.snapshot({
      browserId: target.browserId,
      page: target.contents,
    });

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
    const elementExpression = snapshotEngine.runtimeElementExpression({
      browserId: target.browserId,
      ref,
    });
    if (typeof elementExpression !== 'string') {
      return staleRefFailure(requestId, ref, elementExpression.reason);
    }
    const actionable = await waitForActionableTarget({
      page: target.contents,
      elementExpression,
    });
    if (!actionable.ok) {
      return actionabilityFailure(requestId, ref, actionable);
    }
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
    const result = await snapshotEngine.fill({
      browserId: target.browserId,
      page: target.contents,
      ref,
      value,
    });
    if (!result.ok) {
      return staleRefFailure(requestId, ref, result.reason);
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
    const result = await snapshotEngine.select({
      browserId: target.browserId,
      page: target.contents,
      ref,
      value,
    });
    if (!result.ok) {
      return staleRefFailure(requestId, ref, result.reason);
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
    const elementExpression = snapshotEngine.runtimeElementExpression({
      browserId: target.browserId,
      ref,
    });
    if (typeof elementExpression !== 'string') {
      return staleRefFailure(requestId, ref, elementExpression.reason);
    }
    const actionable = await waitForActionableTarget({
      page: target.contents,
      elementExpression,
    });
    if (!actionable.ok) {
      return actionabilityFailure(requestId, ref, actionable);
    }
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
    const sourceExpression = snapshotEngine.runtimeElementExpression({
      browserId: target.browserId,
      ref: sourceRef,
    });
    const targetExpression = snapshotEngine.runtimeElementExpression({
      browserId: target.browserId,
      ref: targetRef,
    });
    if (typeof sourceExpression !== 'string') {
      return staleRefFailure(requestId, sourceRef, sourceExpression.reason);
    }
    if (typeof targetExpression !== 'string') {
      return staleRefFailure(requestId, targetRef, targetExpression.reason);
    }
    const source = await waitForActionableTarget({
      page: target.contents,
      elementExpression: sourceExpression,
    });
    if (!source.ok) {
      return actionabilityFailure(requestId, sourceRef, source);
    }
    const dropTarget = await waitForActionableTarget({
      page: target.contents,
      elementExpression: targetExpression,
    });
    if (!dropTarget.ok) {
      return actionabilityFailure(requestId, targetRef, dropTarget);
    }
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
    const networkEntries = parseNetworkEntries(
      await target.contents.executeJavaScript(NETWORK_PERFORMANCE_SCRIPT),
    );
    return {
      requestId,
      ok: true,
      result: {
        command: 'logs',
        browserId: target.browserId,
        console: consoleMessages.slice(-maxEntries),
        network: networkEntries.slice(-maxEntries),
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
      const elementExpression = snapshotEngine.runtimeElementExpression({
        browserId: target.browserId,
        ref,
      });
      if (typeof elementExpression !== 'string') {
        return staleRefFailure(requestId, ref, elementExpression.reason);
      }
      const actionable = await waitForActionableTarget({
        page: target.contents,
        elementExpression,
      });
      if (!actionable.ok) {
        return actionabilityFailure(requestId, ref, actionable);
      }
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

function actionabilityFailure(
  requestId: string,
  ref: string,
  result: Exclude<ActionabilityResult, { ok: true }>,
): FailurePayload {
  if (result.reason === 'stale_ref') {
    return staleRefFailure(requestId, ref);
  }
  return fail(
    requestId,
    'browser_timeout',
    `Timed out waiting for browser element ${ref} to become actionable.`,
    true,
  );
}

function cdpSender(contents: TabContents): NonNullable<TabContents['sendDebugCommand']> {
  return contents.sendDebugCommand?.bind(contents) as NonNullable<TabContents['sendDebugCommand']>;
}

async function executeWait(
  requestId: string,
  sessionId: string | undefined,
  browserId: string,
  condition: { text?: string; url?: string; timeoutMs?: number },
  registry: BrowserRegistry,
): Promise<AutomationCommandPayload> {
  const target = resolveTabTarget({ requestId, sessionId, browserId, registry });
  if ('ok' in target) {
    return target;
  }
  return withDialogCapture(target.contents, async () => {
    if (!condition.text && !condition.url) {
      return fail(requestId, 'browser_unsupported', 'browser_wait requires text or url');
    }

    const timeoutMs = condition.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    do {
      if (condition.url && target.contents.getURL().includes(condition.url)) {
        return {
          requestId,
          ok: true,
          result: { command: 'wait', browserId: target.browserId, matched: 'url' },
        };
      }
      if (condition.text) {
        const pageText = await target.contents.executeJavaScript("document.body.innerText || ''");
        if (typeof pageText === 'string' && pageText.includes(condition.text)) {
          return {
            requestId,
            ok: true,
            result: { command: 'wait', browserId: target.browserId, matched: 'text' },
          };
        }
      }
      await delay(WAIT_POLL_INTERVAL_MS);
    } while (Date.now() < deadline);

    if (condition.text) {
      return fail(
        requestId,
        'browser_timeout',
        `Timed out waiting for browser text: ${condition.text}`,
        true,
      );
    }
    if (condition.url) {
      return fail(
        requestId,
        'browser_timeout',
        `Timed out waiting for browser URL: ${condition.url}`,
        true,
      );
    }
    return fail(requestId, 'browser_unsupported', 'browser_wait requires text or url');
  });
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
    let actionable: ActionabilityResult | null = null;
    if (ref) {
      const elementExpression = snapshotEngine.runtimeElementExpression({
        browserId: target.browserId,
        ref,
      });
      if (typeof elementExpression !== 'string') {
        return staleRefFailure(requestId, ref, elementExpression.reason);
      }
      actionable = await waitForActionableTarget({
        page: target.contents,
        elementExpression,
        editable: true,
      });
      if (!actionable.ok) {
        return actionabilityFailure(requestId, ref, actionable);
      }
      await dispatchTrustedClick(cdpSender(target.contents), actionable.target.point);
    }
    await target.contents.insertText(text);
    return {
      requestId,
      ok: true,
      result: {
        command: 'type',
        browserId: target.browserId,
        ...(ref ? { ref } : {}),
        ...(actionable?.ok ? { x: actionable.target.point.x, y: actionable.target.point.y } : {}),
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
    let actionable: ActionabilityResult | null = null;
    if (ref) {
      const elementExpression = snapshotEngine.runtimeElementExpression({
        browserId: target.browserId,
        ref,
      });
      if (typeof elementExpression !== 'string') {
        return staleRefFailure(requestId, ref, elementExpression.reason);
      }
      actionable = await waitForActionableTarget({
        page: target.contents,
        elementExpression,
      });
      if (!actionable.ok) {
        return actionabilityFailure(requestId, ref, actionable);
      }
      const focused = await focusKeypressTarget(target.contents, elementExpression);
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
    dispatchTrustedKey((event) => target.contents.sendInputEvent(event), key);
    return {
      requestId,
      ok: true,
      result: {
        command: 'keypress',
        browserId: target.browserId,
        key,
        ...(ref ? { ref } : {}),
        ...(actionable?.ok ? { x: actionable.target.point.x, y: actionable.target.point.y } : {}),
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
  contents: TabContents,
  elementExpression: string,
): Promise<'editable' | 'focused' | 'stale_ref'> {
  const result = await contents.executeJavaScript(String.raw`(() => {
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

const NETWORK_PERFORMANCE_SCRIPT = String.raw`(() => {
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
