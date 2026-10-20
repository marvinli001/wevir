// SPDX-License-Identifier: MIT
// 改写自 different-ai/openwork apps/desktop/electron/browser-panel.mjs
// 来源提交 ad22cdc2217370f28f24f0f8758016c2921e3c73
// Copyright (c) 2026 Different AI
// 修改：改写成 TypeScript，只留标签页与 WebContentsView 的生命周期、按会话归属与上屏、后台标签页停在不显示的窗口里继续绘制
// （加上 DevTools 的视口与焦点模拟）、窗格位置的换算、载入失败与状态推送；去掉 OpenWork 的 WebMCP、代理、组织策略、任务审批、
// 原生右键菜单、挂起与恢复、关闭历史和快捷键。新增：Wevir 的安全基线（独立的 session 分区、只放行 http(s)、下载 / 权限 /
// 外部协议一律拒绝、弹窗改成同一会话的新标签页）；标签页的操作方 `controller`（agent 开的归 agent，用户开的或用户在里面操作过的
// 归用户，用户的标签页 agent 只读）；agent 的浏览器命令（Paseo 的自动化，automation/）在这里分发。不在屏幕上的标签页一律停在
// 后台窗口里（OpenWork 只停别的会话的），这样同一会话里没选中的标签页也能截图。agent 打开、跳转的结果带主文档的 HTTP 状态码；
// 打不开时报 Chromium 的错误名（`browser_load_failed`），新开的标签页打不开就关掉（超时的留着并说出它的 browserId）。
// 0.46.0：标签页不弹原生对话框（`disableDialogs`，页面不会被 alert 卡住），对话框由 automation/contents.ts 记下、在命令结果里报，
// beforeunload 直接离开；点击、按键之后报主框架跳到了哪里、页面开了哪些新标签页（agent 的标签页弹出的新标签页不抢当前标签页）、
// 被拦下的下载与选文件框；每个 agent 命令有看门狗，页面卡住时说清楚原因（`browser_dialog_blocked` 或页面不响应），不再干等到
// Host 的时限；还在载入的标签页列出目标地址。
// 0.48.0：browser_query 与 browser_network 只读（用户的标签页也能用）；evaluate 之后也看页面有没有跳转；beforeunload 按标签页的
// 对话框策略离开或留下（只在 agent 操作时，用户接手时策略回到默认）；browser_download 要的那一个下载存进会话文件夹的
// `downloads/`（downloads.ts），其余照旧拦下。
//
// 内置浏览器（0.33.0，desktop-layout.md §21）：整个窗口一个浏览器表面，每个标签页属于开它的会话。

import { existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  type BrowserCommand,
  type BrowserEffects,
  type BrowserRequest,
  BrowserRequestSchema,
  type BrowserTabInfo,
} from '@wevir/protocol';
import { BrowserWindow, type Session, session, type WebContents, WebContentsView } from 'electron';
import {
  BACKGROUND_TAB_VIEWPORT,
  type BrowserTabRegistry,
  backgroundTabEmulationCommands,
  createBrowserTabRegistry,
  foregroundTabEmulationCommands,
} from '../../shared/browser-tabs.js';
import type {
  BrowserBounds,
  BrowserController,
  BrowserReveal,
  BrowserStatePayload,
  BrowserTabState,
} from '../../shared/desktop-api.js';
import {
  adaptWebContents,
  dialogPolicyOf,
  interceptFileChooser,
  recordBeforeUnload,
  recordDownload,
  resetDialogPolicy,
  takeDownloads,
  watchTab,
} from './automation/contents.js';
import {
  type AutomationCommandPayload,
  executeAutomationCommand,
  isHostHandled,
} from './automation/service.js';
import { BrowserSnapshotEngine } from './automation/snapshot-engine.js';
import {
  DOWNLOADS_DIR,
  type DownloadItemLike,
  downloadFilename,
  trackDownload,
  uniqueSavePath,
} from './downloads.js';
import { loadFailure, loadFailureMessage } from './load-failure.js';
import { isAllowedNavigation, isAllowedRequest } from './url-policy.js';

/** 内置浏览器的 session 分区：与默认 session（渲染进程）和用户自己的浏览器都分开，数据在 `<数据目录>/desktop/` 下。 */
export const BROWSER_PARTITION = 'persist:wevir-browser';
/** 标签页的上限（所有会话合计）：拒绝新开，不回收活着的页面（OpenWork 的 MAX_BROWSER_TABS）。 */
export const MAX_BROWSER_TABS = 12;
/** agent 新开、跳转的标签页等页面载入的上限。 */
const LOAD_TIMEOUT_MS = 20_000;
/**
 * agent 命令的看门狗（不含载入与 browser_wait 自己的时限）：要比 Host 等回答的 30 s 短，好让这里的说明先到。
 */
const COMMAND_BUDGET_MS = 24_000;
/** 看门狗到点后问页面还响应不响应，最多等这么久。 */
const RESPONSIVE_PROBE_MS = 1_000;
/** 点击、按键之后等多久看页面有没有开始跳转。 */
const NAVIGATION_SETTLE_MS = 150;
/** 跳转开始后最多等它载完多久（之后照样返回，结果里是当时的地址）。 */
const NAVIGATION_WAIT_MS = 8_000;
/** 可能引起跳转、开新标签页的命令。 */
const INTERACTIVE_COMMANDS = new Set<BrowserCommand['command']>([
  'click',
  'keypress',
  'type',
  'select',
  'fill',
  'drag',
  'evaluate',
]);
/** browser_download 默认等多久。 */
const DOWNLOAD_TIMEOUT_MS = 30_000;
/** 点击（或请求地址）之后最多等多久看下载开始没有。 */
const DOWNLOAD_START_MS = 10_000;

/** 网页里的安全设置（OpenWork 的 BROWSER_SECURITY_PREFERENCES，不挂 preload）。 */
const TAB_PREFERENCES = Object.freeze({
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  backgroundThrottling: false,
  spellcheck: false,
  // alert / confirm / prompt 不弹原生框：Chromium 立刻回答（alert 继续、confirm 为 false、prompt 为 null），页面不会被卡住；
  // CDP 仍然报 Page.javascriptDialogOpening，contents.ts 据此记下来。
  disableDialogs: true,
});

/** 只读的命令：用户正在用的标签页也可以。 */
const READ_ONLY_COMMANDS = new Set<BrowserCommand['command']>([
  'list_tabs',
  'snapshot',
  'screenshot',
  'wait',
  'logs',
  'query',
  'network',
]);

interface Tab {
  readonly tabId: string;
  readonly view: WebContentsView;
  controller: BrowserController;
  /** 在后台窗口里（不在屏幕上）。 */
  parked: boolean;
  domReady: boolean;
  /** 正在执行的 agent 命令数：期间页面收到的输入是 agent 的，不算用户接手。 */
  agentBusy: number;
  loadError: BrowserTabState['loadError'];
  /** 主框架最近一次导航的 HTTP 状态码（不是 HTTP 的页面没有）。 */
  httpStatus: number | undefined;
  emulation: Promise<void>;
  /** 正在载入、还没提交的地址（列标签页时 getURL() 还是空的）。 */
  pendingUrl: string | undefined;
  /** 主框架开始跨文档跳转的次数（点击之后据此判断有没有跳转）。 */
  navigations: number;
  /** 主框架提交过的文档数：开始了的跳转没提交（被中止、变成下载）不算换了页面。 */
  commits: number;
  /** 这个标签页弹出、还没在命令结果里报过的新标签页。 */
  openedTabs: Array<{ browserId: string; url: string }>;
  /** 上一个命令时页面不响应：下一个命令先花 1 s 问一下，还不响应就直接报，不再等满看门狗。 */
  unresponsive: boolean;
  /** browser_download 正在等的下载：下一个开始的下载存进 `dir`。 */
  armedDownload: { dir: string; onStart(item: DownloadItemLike, path: string): void } | undefined;
}

export interface BrowserHostOptions {
  getWindow(): BrowserWindow | undefined;
  /** 推给渲染进程（主窗口）。 */
  sendState(payload: BrowserStatePayload): void;
  sendReveal(payload: BrowserReveal): void;
  log(level: 'info' | 'warn' | 'error', message: string, detail?: Record<string, unknown>): void;
}

export type BrowserHost = ReturnType<typeof createBrowserHost>;

export function createBrowserHost(options: BrowserHostOptions) {
  const registry: BrowserTabRegistry = createBrowserTabRegistry();
  const tabs = new Map<string, Tab>();
  const snapshotEngine = new BrowserSnapshotEngine();
  let browserSession: Session | undefined;
  let backgroundWindow: BrowserWindow | undefined;
  /** 窗格可见、给过位置（窗口坐标）。 */
  let paneBounds: BrowserBounds | undefined;
  let counter = 0;

  const window = () => {
    const main = options.getWindow();
    return main && !main.isDestroyed() ? main : undefined;
  };

  // ── session ──────────────────────────────────────────────────────

  /** 第一次开标签页时建分区并装上安全钩子（app ready 之后）。 */
  function ensureSession(): Session {
    if (browserSession) return browserSession;
    const created = session.fromPartition(BROWSER_PARTITION);
    // 摄像头、麦克风、定位、通知、剪贴板读取、MIDI…一律拒绝。
    created.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    created.setPermissionCheckHandler(() => false);
    created.setDevicePermissionHandler(() => false);
    created.setDisplayMediaRequestHandler((_request, callback) => callback({}));
    // 下载一律取消，browser_download 要的那一个除外（只在 agent 操作的标签页）。
    created.on('will-download', (event, item, contents) => {
      const tab = [...tabs.values()].find((candidate) => candidate.view.webContents === contents);
      const armed = tab?.armedDownload;
      if (tab && armed && tab.controller === 'agent') {
        tab.armedDownload = undefined;
        try {
          mkdirSync(armed.dir, { recursive: true });
          const path = uniqueSavePath(armed.dir, downloadFilename(item.getFilename()));
          item.setSavePath(path);
          armed.onStart(item, path);
          options.log('info', 'saved a download the agent asked for', {
            url: safeUrl(item.getURL()),
          });
          return;
        } catch (error) {
          options.log('warn', 'could not save a download', { error: String(error) });
        }
      }
      event.preventDefault();
      options.log('info', 'blocked a download in the built-in browser', {
        url: safeUrl(item.getURL()),
      });
      // 报给 agent：下一个命令（多半就是引起下载的点击）的结果里写明下载被拦下了。
      recordDownload(contents.id, {
        url: safeUrl(item.getURL()),
        filename: item.getFilename(),
        state: 'blocked',
      });
    });
    // 所有请求（导航、重定向、框架、脚本的 fetch、CDP 的跳转）的统一关口：只放行 http(s) 与页面内部的 data / blob / about。
    // http(s) 对哪种请求都放行，不送到这里：网页的几百个资源请求不必每个都在主进程排队等一次回答。
    created.webRequest.onBeforeRequest(
      { urls: ['<all_urls>'], excludeUrls: ['http://*/*', 'https://*/*'] },
      (details, callback) => {
        callback({ cancel: !isAllowedRequest(details.url, details.resourceType) });
      },
    );
    browserSession = created;
    return created;
  }

  /** 这个 webContents 是不是内置浏览器的标签页（主进程的全局导航规则跳过它们）。 */
  function isBrowserContents(contents: WebContents): boolean {
    return browserSession !== undefined && contents.session === browserSession;
  }

  // ── 状态 ─────────────────────────────────────────────────────────

  function tabState(tab: Tab): BrowserTabState {
    const contents = tab.view.webContents;
    const failed = tab.loadError;
    const url = failed?.url ?? (contents.getURL() || tab.pendingUrl || '');
    return {
      id: tab.tabId,
      ownerSessionId: registry.ownerOf(tab.tabId),
      url,
      title: failed ? '' : contents.getTitle(),
      isLoading: contents.isLoading(),
      canGoBack: contents.navigationHistory.canGoBack(),
      canGoForward: contents.navigationHistory.canGoForward(),
      controller: tab.controller,
      agentBusy: tab.agentBusy > 0,
      ...(failed !== undefined && { loadError: failed }),
    };
  }

  function state(): BrowserStatePayload {
    return {
      activeTabId: registry.onScreenTabId(),
      activeTabIdByOwner: registry.activeTabIdByOwner(),
      visibleSessionId: registry.visibleSessionId(),
      tabs: registry.list().flatMap(({ tabId }) => {
        const tab = tabs.get(tabId);
        return tab && !tab.view.webContents.isDestroyed() ? [tabState(tab)] : [];
      }),
    };
  }

  let statePending = false;
  /** 合并同一轮事件循环里的多次变化。 */
  function sendState(): void {
    if (statePending) return;
    statePending = true;
    queueMicrotask(() => {
      statePending = false;
      options.sendState(state());
    });
  }

  // ── 标签页 ───────────────────────────────────────────────────────

  function createTab(ownerSessionId: string, controller: BrowserController): Tab {
    if (tabs.size >= MAX_BROWSER_TABS) {
      throw new BrowserHostError(
        'browser_denied',
        `Wevir has ${MAX_BROWSER_TABS} browser tabs open. Close a tab you no longer need, then try again.`,
      );
    }
    const partition = ensureSession();
    counter += 1;
    const tabId = `tab_${Date.now().toString(36)}_${counter.toString(36)}`;
    const view = new WebContentsView({
      webPreferences: { ...TAB_PREFERENCES, session: partition },
    });
    const tab: Tab = {
      tabId,
      view,
      controller,
      parked: false,
      domReady: false,
      agentBusy: 0,
      loadError: undefined,
      httpStatus: undefined,
      emulation: Promise.resolve(),
      pendingUrl: undefined,
      navigations: 0,
      commits: 0,
      openedTabs: [],
      unresponsive: false,
      armedDownload: undefined,
    };
    tabs.set(tabId, tab);
    registry.add({ tabId, ownerSessionId });
    const contents = view.webContents;
    view.setBackgroundColor('#ffffff');
    // 从一开始（第一次载入之前）就记对话框、控制台与网络请求（browser_logs）。
    watchTab(contents);
    interceptFileChooser(contents.id, controller === 'agent');

    // 弹窗：http(s) 的在同一会话里开新标签页（agent 开的归 agent），别的拒绝；不交给系统浏览器。
    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedNavigation(url)) {
        try {
          const popup = createTab(ownerSessionId, tab.controller);
          popup.pendingUrl = url;
          void popup.view.webContents.loadURL(url).catch(() => {});
          // 用户点开的新标签页显示出来；agent 的留在后台（同 browser_new_tab），在它下一个命令的结果里报。
          if (tab.controller === 'user' && registry.surfacingFor(tabId) === 'foreground') {
            selectTab(popup.tabId);
          } else {
            if (tab.openedTabs.length < 20) tab.openedTabs.push({ browserId: popup.tabId, url });
            place();
          }
        } catch (error) {
          options.log('warn', 'could not open a browser popup', { error: String(error) });
        }
      }
      return { action: 'deny' };
    });
    // 外部协议（mailto:、zoommtg: …）与 file: 之类的跳转一律拒绝。
    const guard = (event: { preventDefault(): void; url: string }) => {
      if (!isAllowedNavigation(event.url)) event.preventDefault();
    };
    contents.on('will-navigate', guard);
    contents.on('will-redirect', guard);
    // 主框架只能是 http(s)；子框架由 session 的请求关口管（另外放行 data / blob / about）。
    contents.on('will-frame-navigate', (event) => {
      if (event.isMainFrame && !isAllowedNavigation(event.url)) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
    // beforeunload 想拦住离开：不弹框，按标签页的策略离开（默认）或留下（agent 用 browser_dialogs 选的，只在它操作时），记成一个
    // 处理掉的对话框。
    contents.on('will-prevent-unload', (event) => {
      const leave =
        tab.controller !== 'agent' || dialogPolicyOf(contents.id).beforeunload === 'accept';
      if (leave) event.preventDefault();
      recordBeforeUnload(contents.id, leave ? 'accepted' : 'dismissed');
    });
    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) tab.navigations += 1;
    });

    contents.once('dom-ready', () => {
      tab.domReady = true;
      if (tab.parked) emulateBackground(tab);
    });
    contents.on('did-navigate', (_event, _url, httpResponseCode) => {
      tab.commits += 1;
      tab.loadError = undefined;
      tab.pendingUrl = undefined;
      tab.httpStatus = httpResponseCode > 0 ? httpResponseCode : undefined;
      snapshotEngine.clearBrowser(tabId);
      place();
      sendState();
    });
    contents.on('did-navigate-in-page', () => sendState());
    contents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        // 中止（含被取消的下载、被下一次导航替换）与子框架的失败不算页面打不开。
        if (!isMainFrame || errorCode === -3) return;
        tab.pendingUrl = undefined;
        tab.loadError = { code: errorCode, description: errorDescription, url: validatedURL };
        place();
        sendState();
      },
    );
    contents.on('page-title-updated', () => sendState());
    contents.on('did-start-loading', () => sendState());
    contents.on('did-stop-loading', () => sendState());
    // 用户在 agent 的标签页里点了、敲了：用户接手，agent 之后只读。agent 自己的输入（执行命令期间）不算。
    contents.on('input-event', (_event, input) => {
      if (tab.controller !== 'agent' || tab.agentBusy > 0 || tab.parked) return;
      if (input.type === 'mouseDown' || input.type === 'keyDown' || input.type === 'rawKeyDown') {
        setTabController(tab, 'user');
        sendState();
      }
    });
    contents.once('destroyed', () => {
      if (tabs.get(tabId) === tab) closeTab(tabId);
    });
    return tab;
  }

  /** 换操作方：用户的标签页里选文件交给用户（原生文件框），agent 的拦下来报给 agent。 */
  function setTabController(tab: Tab, controller: BrowserController): void {
    tab.controller = controller;
    if (!tab.view.webContents.isDestroyed()) {
      interceptFileChooser(tab.view.webContents.id, controller === 'agent');
      if (controller === 'user') resetDialogPolicy(tab.view.webContents.id);
    }
  }

  function closeTab(tabId: string): boolean {
    const tab = tabs.get(tabId);
    if (!tab) return false;
    tabs.delete(tabId);
    registry.remove(tabId);
    snapshotEngine.clearBrowser(tabId);
    detach(tab.view);
    try {
      if (!tab.view.webContents.isDestroyed())
        tab.view.webContents.close({ waitForBeforeUnload: false });
    } catch {
      // 已经销毁
    }
    place();
    releaseBackgroundWindow();
    sendState();
    return true;
  }

  function selectTab(tabId: string): void {
    if (!tabs.has(tabId))
      throw new BrowserHostError('browser_tab_not_found', `No browser tab ${tabId}.`);
    registry.select(tabId);
    place();
    sendState();
  }

  // ── 摆放：屏幕上的一个，其余停在后台窗口 ─────────────────────────────

  function detach(view: WebContentsView): void {
    for (const host of [window(), backgroundWindow]) {
      try {
        if (host && !host.isDestroyed() && host.contentView.children.includes(view)) {
          host.contentView.removeChildView(view);
        }
      } catch {
        // 已经移走
      }
    }
  }

  function background(): BrowserWindow {
    if (!backgroundWindow || backgroundWindow.isDestroyed()) {
      backgroundWindow = new BrowserWindow({
        ...BACKGROUND_TAB_VIEWPORT,
        show: false,
        paintWhenInitiallyHidden: true,
        focusable: false,
        skipTaskbar: true,
        webPreferences: { backgroundThrottling: false, sandbox: true },
      });
    }
    return backgroundWindow;
  }

  function releaseBackgroundWindow(): void {
    if (!backgroundWindow) return;
    if (!backgroundWindow.isDestroyed() && backgroundWindow.contentView.children.length > 0) return;
    if (!backgroundWindow.isDestroyed()) backgroundWindow.destroy();
    backgroundWindow = undefined;
  }

  function queueEmulation(tab: Tab, operation: () => Promise<void>): void {
    const run = () =>
      tabs.get(tab.tabId) === tab && !tab.view.webContents.isDestroyed() ? operation() : undefined;
    tab.emulation = tab.emulation.then(run, run).catch((error: unknown) => {
      // 执行到一半标签页关了（例如新开的标签页打不开、随即关掉）：不算失败。
      if (tabs.get(tab.tabId) !== tab || tab.view.webContents.isDestroyed()) return;
      options.log('warn', 'browser tab emulation failed', { error: String(error) });
    });
  }

  function emulateBackground(tab: Tab): void {
    const cdp = tab.view.webContents.debugger;
    queueEmulation(tab, async () => {
      if (!tab.parked) return;
      if (!cdp.isAttached()) cdp.attach('1.3');
      for (const { method, params } of backgroundTabEmulationCommands()) {
        if (!tab.parked) return;
        await cdp.sendCommand(method, params);
      }
    });
  }

  function emulateForeground(tab: Tab): void {
    const cdp = tab.view.webContents.debugger;
    queueEmulation(tab, async () => {
      if (tab.parked || !cdp.isAttached()) return;
      for (const { method, params } of foregroundTabEmulationCommands()) {
        if (tab.parked) return;
        await cdp.sendCommand(method, params);
      }
    });
  }

  function park(tab: Tab): void {
    if (tab.view.webContents.isDestroyed()) return;
    const host = background();
    if (!tab.parked || !host.contentView.children.includes(tab.view)) {
      detach(tab.view);
      tab.view.setBounds({ x: 0, y: 0, ...BACKGROUND_TAB_VIEWPORT });
      host.contentView.addChildView(tab.view);
    }
    tab.view.setVisible(true);
    if (!tab.parked) {
      tab.parked = true;
      if (tab.domReady) emulateBackground(tab);
    }
  }

  function show(tab: Tab, bounds: BrowserBounds): void {
    const main = window();
    if (!main || tab.view.webContents.isDestroyed()) return;
    if (tab.parked) {
      tab.parked = false;
      detach(tab.view);
      emulateForeground(tab);
    }
    // 打开失败、空白页由渲染进程画说明，原生视图藏起来（它盖在页面之上）。
    const blank =
      tab.view.webContents.getURL() === '' || tab.view.webContents.getURL() === 'about:blank';
    tab.view.setVisible(tab.loadError === undefined && !blank);
    tab.view.setBounds(bounds);
    if (!main.contentView.children.includes(tab.view)) main.contentView.addChildView(tab.view);
  }

  /** 按当前状态摆放每个标签页。 */
  function place(): void {
    const onScreen = paneBounds === undefined ? null : registry.onScreenTabId();
    for (const tab of tabs.values()) {
      if (tab.tabId === onScreen && paneBounds !== undefined) show(tab, paneBounds);
      else park(tab);
    }
    releaseBackgroundWindow();
  }

  /** 渲染进程给的窗格位置（CSS 像素）换成窗口坐标，裁到内容区里（OpenWork 的 acceptBrowserBounds）。 */
  function toWindowBounds(bounds: BrowserBounds): BrowserBounds | undefined {
    const main = window();
    if (!main) return undefined;
    const values = [bounds.x, bounds.y, bounds.width, bounds.height];
    if (!values.every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0) return undefined;
    const zoom = main.webContents.getZoomFactor() || 1;
    const x = Math.max(0, Math.round(bounds.x * zoom));
    const y = Math.max(0, Math.round(bounds.y * zoom));
    const [width = 0, height = 0] = main.getContentSize();
    const right = Math.min(width, Math.round((bounds.x + bounds.width) * zoom));
    const bottom = Math.min(height, Math.round((bounds.y + bounds.height) * zoom));
    if (right <= x || bottom <= y) return undefined;
    return { x, y, width: right - x, height: bottom - y };
  }

  // ── 渲染进程（用户）────────────────────────────────────────────────

  function setVisibleSession(sessionId: string | null): void {
    if (registry.visibleSessionId() === sessionId) return;
    registry.setVisibleSession(sessionId);
    place();
    sendState();
  }

  function showPane(bounds: BrowserBounds, sessionId: string): boolean {
    registry.setVisibleSession(sessionId);
    paneBounds = toWindowBounds(bounds);
    place();
    sendState();
    return paneBounds !== undefined;
  }

  function hidePane(): void {
    paneBounds = undefined;
    place();
  }

  /** 用户开的标签页（窗格的 + 或地址栏）：归用户。 */
  function openForUser(sessionId: string, url: string | undefined): string {
    const tab = createTab(sessionId, 'user');
    if (url !== undefined) {
      tab.pendingUrl = url;
      void tab.view.webContents.loadURL(url).catch(() => {});
    }
    selectTab(tab.tabId);
    return tab.tabId;
  }

  function userTab(tabId: string): Tab {
    const tab = tabs.get(tabId);
    if (!tab) throw new BrowserHostError('browser_tab_not_found', `No browser tab ${tabId}.`);
    return tab;
  }

  function navigateForUser(tabId: string, url: string): void {
    const tab = userTab(tabId);
    setTabController(tab, 'user');
    tab.loadError = undefined;
    tab.pendingUrl = url;
    void tab.view.webContents.loadURL(url).catch(() => {});
    sendState();
  }

  function historyForUser(tabId: string, action: 'back' | 'forward' | 'reload' | 'stop'): void {
    const tab = userTab(tabId);
    const contents = tab.view.webContents;
    if (action === 'back' && contents.navigationHistory.canGoBack())
      contents.navigationHistory.goBack();
    if (action === 'forward' && contents.navigationHistory.canGoForward())
      contents.navigationHistory.goForward();
    if (action === 'stop') contents.stop();
    if (action === 'reload') {
      const failed = tab.loadError;
      tab.loadError = undefined;
      if (failed?.url) void contents.loadURL(failed.url).catch(() => {});
      else contents.reload();
    }
    sendState();
  }

  function setController(tabId: string, controller: BrowserController): void {
    setTabController(userTab(tabId), controller);
    sendState();
  }

  // ── agent（Host 经渲染进程交来的请求）────────────────────────────────

  async function execute(raw: unknown): Promise<AutomationCommandPayload> {
    const parsed = BrowserRequestSchema.safeParse(raw);
    if (!parsed.success) {
      const requestId =
        raw !== null &&
        typeof raw === 'object' &&
        typeof (raw as { requestId?: unknown }).requestId === 'string'
          ? (raw as { requestId: string }).requestId
          : 'brq_unknown';
      return failure(requestId, 'browser_unsupported', 'This browser request is not valid.');
    }
    const request = parsed.data;
    try {
      return await run(request);
    } catch (error) {
      if (error instanceof BrowserHostError)
        return failure(request.requestId, error.code, error.message);
      options.log('error', 'browser command failed', {
        command: request.command.command,
        error: String(error),
      });
      return failure(
        request.requestId,
        'browser_unknown_error',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async function run(request: BrowserRequest): Promise<AutomationCommandPayload> {
    const { requestId, sessionId, command } = request;
    switch (command.command) {
      case 'list_tabs': {
        const active = registry.activeTabIdFor(sessionId);
        const list: BrowserTabInfo[] = registry.tabsFor(sessionId).flatMap(({ tabId }) => {
          const tab = tabs.get(tabId);
          if (!tab || tab.view.webContents.isDestroyed()) return [];
          const info = tabState(tab);
          return [
            {
              browserId: tabId,
              url: info.url,
              title: info.title,
              isActive: active === tabId,
              isLoading: info.isLoading,
              canGoBack: info.canGoBack,
              canGoForward: info.canGoForward,
              controller: info.controller,
            },
          ];
        });
        return { requestId, ok: true, result: { command: 'list_tabs', tabs: list } };
      }
      case 'new_tab': {
        const tab = createTab(sessionId, 'agent');
        place();
        sendState();
        const url = command.args.url;
        return guarded(tab, command, LOAD_TIMEOUT_MS + 4_000, () =>
          withTabEvents(tab, requestId, async () => {
            if (url !== undefined) await busy(tab, () => loadNewTab(tab, url));
            return {
              requestId,
              ok: true,
              result: {
                command: 'new_tab',
                browserId: tab.tabId,
                url: tab.view.webContents.getURL() || 'about:blank',
                ...statusOf(tab, url),
              },
            };
          }),
        );
      }
      case 'show': {
        const url = command.args.url;
        const tab = url !== undefined ? createTab(sessionId, 'agent') : undefined;
        const target = tab ?? owned(sessionId, command.args.browserId ?? '');
        if (tab) place();
        return guarded(target, command, LOAD_TIMEOUT_MS + 4_000, () =>
          withTabEvents(target, requestId, async () => {
            if (tab && url !== undefined) await busy(tab, () => loadNewTab(tab, url));
            registry.select(target.tabId);
            const shown = registry.visibleSessionId() === sessionId;
            if (shown) options.sendReveal({ sessionId, tabId: target.tabId });
            place();
            sendState();
            return {
              requestId,
              ok: true,
              result: {
                command: 'show',
                browserId: target.tabId,
                url: target.view.webContents.getURL(),
                shown,
                ...statusOf(target, url),
              },
            };
          }),
        );
      }
      case 'close_tab': {
        owned(sessionId, command.args.browserId);
        closeTab(command.args.browserId);
        return {
          requestId,
          ok: true,
          result: { command: 'close_tab', browserId: command.args.browserId },
        };
      }
      default:
        break;
    }
    if (isHostHandled(command.command) && command.command !== 'download') {
      return failure(
        requestId,
        'browser_unsupported',
        `Unsupported browser command ${command.command}.`,
      );
    }
    const tab = owned(sessionId, command.args.browserId);
    if (!READ_ONLY_COMMANDS.has(command.command) && tab.controller === 'user') {
      return failure(
        requestId,
        'browser_denied',
        `The user is using browser tab ${tab.tabId}, so you can only read it. Ask the user to hand it to you ("Hand to agent" in the browser pane), or open your own tab with browser_new_tab.`,
      );
    }
    if (command.command === 'navigate') {
      return guarded(tab, command, LOAD_TIMEOUT_MS + 4_000, () =>
        withTabEvents(tab, requestId, async () => {
          tab.loadError = undefined;
          snapshotEngine.clearBrowser(tab.tabId);
          await busy(tab, () => load(tab, command.args.url));
          return {
            requestId,
            ok: true,
            result: {
              command: 'navigate',
              browserId: tab.tabId,
              url: tab.view.webContents.getURL(),
              ...statusOf(tab, command.args.url),
            },
          };
        }),
      );
    }
    if (command.command === 'download') {
      const timeoutMs = command.args.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
      return guarded(tab, command, timeoutMs + 5_000, () =>
        withTabEvents(tab, requestId, () => busy(tab, () => download(tab, request, command))),
      );
    }
    const budget =
      command.command === 'wait'
        ? (command.args.timeoutMs ?? 5_000) + 3_000
        : command.command === 'evaluate'
          ? Math.max(COMMAND_BUDGET_MS, (command.args.timeoutMs ?? 5_000) + 3_000)
          : COMMAND_BUDGET_MS;
    return guarded(tab, command, budget, () =>
      busy(tab, async () => {
        const before = {
          url: tab.view.webContents.getURL(),
          navigations: tab.navigations,
          commits: tab.commits,
        };
        const payload = await executeAutomationCommand(request, automationRegistry, {
          snapshotEngine,
        });
        const navigation = INTERACTIVE_COMMANDS.has(command.command)
          ? await settleNavigation(tab, before)
          : undefined;
        // 等跳转期间才开始的下载（点了下载链接）也报在这个命令里，不留到下一个。
        const late = INTERACTIVE_COMMANDS.has(command.command)
          ? takeDownloads(tab.view.webContents.id)
          : [];
        const downloads = [...(payload.effects?.downloads ?? []), ...late];
        return withEffects(payload, {
          ...(navigation && { navigation }),
          ...takeOpenedTabs(tab),
          ...(downloads.length > 0 && { downloads }),
        });
      }),
    );
  }

  const automationRegistry = {
    getTabContents: (browserId: string) => {
      const target = tabs.get(browserId);
      return target && !target.view.webContents.isDestroyed()
        ? adaptWebContents(target.view.webContents)
        : null;
    },
    ownerOf: (browserId: string) => registry.ownerOf(browserId),
  };

  /**
   * browser_download：点 `ref`（或请求 `url`），接住接着开始的下载，存进会话文件夹的 `downloads/`，等它结束（有时限）。
   */
  async function download(
    tab: Tab,
    request: BrowserRequest,
    command: Extract<BrowserCommand, { command: 'download' }>,
  ): Promise<AutomationCommandPayload> {
    const { requestId } = request;
    const { ref, url } = command.args;
    if ((ref === undefined) === (url === undefined)) {
      return failure(
        requestId,
        'browser_invalid_argument',
        'browser_download needs exactly one of ref or url.',
      );
    }
    if (!existsSync(request.cwd)) {
      return failure(
        requestId,
        'browser_denied',
        `The session folder ${request.cwd} is not available.`,
      );
    }
    const timeoutMs = command.args.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const dir = join(request.cwd, DOWNLOADS_DIR);
    const started = new Promise<{ item: DownloadItemLike; path: string }>((resolve) => {
      tab.armedDownload = { dir, onStart: (item, path) => resolve({ item, path }) };
    });
    try {
      if (url !== undefined) {
        if (!isAllowedNavigation(url)) {
          return failure(
            requestId,
            'browser_denied',
            'The Wevir browser only downloads http and https URLs.',
          );
        }
        tab.view.webContents.downloadURL(url);
      } else {
        const clicked = await executeAutomationCommand(
          {
            ...request,
            command: { command: 'click', args: { browserId: tab.tabId, ref: ref as string } },
          },
          automationRegistry,
          { snapshotEngine },
        );
        if (!clicked.ok) return clicked;
      }
      const startWait = Math.min(timeoutMs, DOWNLOAD_START_MS);
      const first = await Promise.race([started, delay(startWait).then(() => undefined)]);
      if (!first) {
        return failure(
          requestId,
          'browser_timeout',
          `No download started within ${Math.round(startWait / 1000)} s after ${url !== undefined ? `requesting ${url}` : `clicking ${ref}`}. Take a browser_snapshot to see what the page did.`,
        );
      }
      const finished = await trackDownload(
        first.item,
        first.path,
        Math.max(0, deadline - Date.now()),
      );
      const kept = finished.state === 'completed' || finished.state === 'in_progress';
      const mimeType = first.item.getMimeType();
      return {
        requestId,
        ok: true,
        result: {
          command: 'download',
          browserId: tab.tabId,
          url: first.item.getURL(),
          filename: basename(first.path),
          ...(kept && { path: first.path }),
          size: finished.size,
          ...(mimeType && { mimeType }),
          state: finished.state,
        },
      };
    } finally {
      tab.armedDownload = undefined;
    }
  }

  /**
   * 点击、按键之后：页面开始跳转了就等它载完（有上限），报出最后的地址与 HTTP 状态码；只是地址变了（pushState、#）也报。
   */
  async function settleNavigation(
    tab: Tab,
    before: { url: string; navigations: number; commits: number },
  ): Promise<BrowserEffects['navigation']> {
    const contents = tab.view.webContents;
    if (tab.navigations === before.navigations) await delay(NAVIGATION_SETTLE_MS);
    if (contents.isDestroyed()) return undefined;
    if (tab.navigations !== before.navigations) {
      const deadline = Date.now() + NAVIGATION_WAIT_MS;
      while (contents.isLoading() && Date.now() < deadline && !contents.isDestroyed()) {
        await delay(50);
      }
      if (contents.isDestroyed()) return undefined;
      const url = contents.getURL() || tab.pendingUrl || '';
      // 跳转没提交新文档（被中止，或者成了下载）而地址也没变：没换页面。
      if (tab.commits === before.commits && !tab.loadError && url === before.url) return undefined;
      return { url, ...(tab.httpStatus !== undefined && { status: tab.httpStatus }) };
    }
    const url = contents.getURL();
    return url !== before.url ? { url } : undefined;
  }

  function takeOpenedTabs(tab: Tab): Pick<BrowserEffects, 'openedTabs'> {
    if (tab.openedTabs.length === 0) return {};
    const openedTabs = tab.openedTabs.filter(({ browserId }) => tabs.has(browserId));
    tab.openedTabs = [];
    return openedTabs.length > 0 ? { openedTabs } : {};
  }

  /**
   * 载入类的命令（新开、跳转、显示）：执行期间（以及上一个命令之后）页面弹出的对话框、开出的新标签页、被拦下的下载也报出来；
   * 失败的照样带上。
   */
  async function withTabEvents(
    tab: Tab,
    requestId: string,
    task: () => Promise<AutomationCommandPayload>,
  ): Promise<AutomationCommandPayload> {
    const contents = adaptWebContents(tab.view.webContents);
    const run = async () => {
      try {
        return await task();
      } catch (error) {
        if (error instanceof BrowserHostError) return failure(requestId, error.code, error.message);
        throw error;
      }
    };
    if (!contents.captureDialogs || tab.view.webContents.isDestroyed()) return run();
    const { result, dialogs, effects } = await contents.captureDialogs(run);
    const payload = withEffects(result, { ...effects, ...takeOpenedTabs(tab) });
    return dialogs.length > 0 ? { ...payload, dialogs } : payload;
  }

  /**
   * 看门狗：命令在 `budgetMs` 内没完成就不再等，说清楚为什么（对话框挡着、页面不响应，或只是慢），标签页留着、可以关。
   * 没完成的命令在后台继续，结果丢掉。
   */
  async function guarded(
    tab: Tab,
    command: BrowserCommand,
    budgetMs: number,
    task: () => Promise<AutomationCommandPayload>,
  ): Promise<AutomationCommandPayload> {
    if (tab.unresponsive) {
      if (!(await responds(tab))) throw notResponding(tab, command, RESPONSIVE_PROBE_MS);
      tab.unresponsive = false;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<'expired'>((resolve) => {
      timer = setTimeout(() => resolve('expired'), budgetMs);
    });
    const running = task();
    // 超时之后才失败的命令不要变成未处理的拒绝。
    running.catch(() => {});
    try {
      const outcome = await Promise.race([running, expired]);
      if (outcome !== 'expired') return outcome;
    } finally {
      clearTimeout(timer);
    }
    throw await stuckError(tab, command, budgetMs);
  }

  /** 页面在 1 s 内能不能跑一个最简单的脚本。 */
  async function responds(tab: Tab): Promise<boolean> {
    const contents = tab.view.webContents;
    if (contents.isDestroyed()) return false;
    return Promise.race([
      contents.executeJavaScript('1').then(
        () => true,
        () => false,
      ),
      delay(RESPONSIVE_PROBE_MS).then(() => false),
    ]);
  }

  function notResponding(tab: Tab, command: BrowserCommand, waitedMs: number): BrowserHostError {
    return new BrowserHostError(
      'browser_timeout',
      `The page in browser tab ${tab.tabId} is not responding (a script on it is still running, or it is stuck), so browser_${command.command} could not finish within ${Math.max(1, Math.round(waitedMs / 1000))} s. Close the tab with browser_close_tab, or try again later.`,
    );
  }

  async function stuckError(
    tab: Tab,
    command: BrowserCommand,
    budgetMs: number,
  ): Promise<BrowserHostError> {
    const contents = tab.view.webContents;
    const name = `browser_${command.command}`;
    if (contents.isDestroyed()) {
      return new BrowserHostError(
        'browser_tab_closed',
        `Browser tab ${tab.tabId} has been closed.`,
      );
    }
    const dialog = adaptWebContents(contents).openDialog?.();
    if (dialog) {
      return new BrowserHostError(
        'browser_dialog_blocked',
        `A ${dialog.type} dialog (${JSON.stringify(dialog.message)}) is blocking browser tab ${tab.tabId}, so ${name} could not finish. Close the tab with browser_close_tab.`,
      );
    }
    if (!(await responds(tab))) {
      tab.unresponsive = true;
      return notResponding(tab, command, budgetMs);
    }
    return new BrowserHostError(
      'browser_timeout',
      `${name} did not finish within ${Math.round(budgetMs / 1000)} s; the page still responds. Try again, or take a browser_snapshot to see the page.`,
    );
  }

  /** 这个会话的标签页；别的会话的当作不存在。 */
  function owned(sessionId: string, tabId: string): Tab {
    const tab = tabs.get(tabId);
    if (!tab || registry.ownerOf(tabId) !== sessionId) {
      throw new BrowserHostError(
        'browser_tab_not_found',
        `No browser tab ${tabId} in this session. Call browser_list_tabs.`,
      );
    }
    if (tab.view.webContents.isDestroyed()) {
      throw new BrowserHostError('browser_tab_closed', `Browser tab ${tabId} has been closed.`);
    }
    return tab;
  }

  async function busy<T>(tab: Tab, task: () => Promise<T>): Promise<T> {
    tab.agentBusy += 1;
    sendState();
    try {
      return await task();
    } finally {
      tab.agentBusy -= 1;
      sendState();
    }
  }

  /** 新开的标签页载入：打不开就关掉，不留下 agent 拿不到 browserId 的空标签页；超时的留着（页面可能还在来）。 */
  async function loadNewTab(tab: Tab, url: string): Promise<void> {
    try {
      await load(tab, url);
    } catch (error) {
      if (error instanceof BrowserHostError && error.code === 'browser_timeout') {
        throw new BrowserHostError(
          error.code,
          `${error.message} Its browserId is ${tab.tabId}: use browser_wait or browser_snapshot on it, or close it with browser_close_tab.`,
        );
      }
      closeTab(tab.tabId);
      throw error;
    }
  }

  /** 载入页面并等它结束；打不开时抛出模型看得懂的原因。 */
  async function load(tab: Tab, url: string): Promise<void> {
    if (!isAllowedNavigation(url)) {
      throw new BrowserHostError(
        'browser_denied',
        'The Wevir browser only opens http and https pages.',
      );
    }
    tab.loadError = undefined;
    tab.httpStatus = undefined;
    const loading = tab.view.webContents.loadURL(url);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), LOAD_TIMEOUT_MS);
    });
    try {
      const outcome = await Promise.race([loading.then(() => 'loaded' as const), timeout]);
      if (outcome === 'timeout') {
        throw new BrowserHostError(
          'browser_timeout',
          `${url} did not finish loading within ${LOAD_TIMEOUT_MS / 1000} s; the tab stays open.`,
        );
      }
    } catch (error) {
      if (error instanceof BrowserHostError) throw error;
      // loadURL 在重定向、被下一次导航替换时以 ERR_ABORTED 结束，页面其实在载入。
      const failure = loadFailure(error, tab.loadError);
      if (failure.name === 'ERR_ABORTED') return;
      throw new BrowserHostError('browser_load_failed', loadFailureMessage(url, failure));
    } finally {
      clearTimeout(timer);
    }
  }

  function destroy(): void {
    for (const tabId of [...tabs.keys()]) closeTab(tabId);
    registry.clear();
    if (backgroundWindow && !backgroundWindow.isDestroyed()) backgroundWindow.destroy();
    backgroundWindow = undefined;
  }

  return {
    state,
    execute,
    isBrowserContents,
    setVisibleSession,
    showPane,
    hidePane,
    openForUser,
    closeTab: (tabId: string) => {
      userTab(tabId);
      closeTab(tabId);
    },
    selectTab,
    navigateForUser,
    historyForUser,
    setController,
    /** 窗口大小或缩放变了：渲染进程会重新给位置，在这之前先按旧位置裁一遍。 */
    relayout: () => place(),
    destroy,
  };
}

export class BrowserHostError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function failure(requestId: string, code: string, message: string): AutomationCommandPayload {
  return { requestId, ok: false, error: { code, message, retryable: false } };
}

/** 把页面变化并进回答（空的不加）。 */
function withEffects(
  payload: AutomationCommandPayload,
  effects: BrowserEffects,
): AutomationCommandPayload {
  if (Object.keys(effects).length === 0) return payload;
  return { ...payload, effects: { ...(payload.effects ?? {}), ...effects } };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 结果里的 `status`：这次载入了地址、主文档是 HTTP 的才有。 */
function statusOf(tab: Tab, url: string | undefined): { status?: number } {
  return url !== undefined && tab.httpStatus !== undefined ? { status: tab.httpStatus } : {};
}

function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '';
  }
}
