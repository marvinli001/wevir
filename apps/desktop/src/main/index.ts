// Wevir 桌面主进程（T5.1）：窗口与安全基线、Host 的附着 / 拉起 / 停止、给 preload 的 IPC。
// Host 的生命周期见 host-lifecycle.ts（ADR-0002 §6）；渲染进程只经 client-sdk 与 Host 通信。

import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME_LAYOUT, LOG_FILE, resolveHome } from '@wevir/host/runtime';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  Notification,
  nativeTheme,
  protocol,
  session,
  shell,
} from 'electron';
import {
  type HostConnection,
  type HostProcessStatus,
  IPC_CHANNELS,
  type UpdateState,
  type WindowChrome,
} from '../shared/desktop-api.js';
import { canOpenExternally } from '../shared/open-path.js';
import {
  APP_ENTRY_URL,
  APP_ORIGIN,
  APP_SCHEME,
  DEV_SERVER_ORIGIN,
  rendererOriginOf,
} from '../shared/renderer-origin.js';
import { isThemeMode, THEME_BACKGROUND } from '../shared/theme.js';
import { applyAppIcon, windowIcon } from './app-icon.js';
import { registerBrowserIpc } from './browser/browser-ipc.js';
import { Editors, isLineNumber } from './editors.js';
import {
  failureOf,
  HostLifecycle,
  hostEnvironment,
  hostRuntime,
  type Log,
  packagedHostEntry,
  resolveHostEntry,
} from './host-lifecycle.js';
import { loadDesktopIdentity } from './identity.js';
import { isBadgeCount, parseDesktopNotification } from './notification-input.js';
import { serveRendererFile } from './renderer-files.js';
import { createUpdateController } from './updates/electron-updates.js';

const log: Log = (level, message, detail) => {
  const line = `[wevir-desktop] ${level} ${message}${detail ? ` ${JSON.stringify(detail)}` : ''}`;
  if (level === 'info') console.log(line);
  else console.error(line);
};

/** 开发模式：没有打包、且 electron-vite dev 给了开发服务器地址。打包后的应用不认这个环境变量。 */
const devServerUrl = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL;
/** 渲染进程的 origin，必须在 Host 的 Origin 白名单里（host-api.md §1）。 */
const rendererOrigin = devServerUrl === undefined ? APP_ORIGIN : rendererOriginOf(devServerUrl);
if (rendererOrigin !== APP_ORIGIN && rendererOrigin !== DEV_SERVER_ORIGIN) {
  log('error', 'renderer origin is not in the host origin allowlist', {
    rendererOrigin,
    expected: DEV_SERVER_ORIGIN,
  });
}
/** Host 的数据目录，与 wevir-host、wevir CLI 的解析规则相同：WEVIR_HOME > 平台默认。 */
const home = resolveHome({ env: process.env });

// ── 以下必须在 app ready 之前 ────────────────────────────────────────────

// Electron 默认的 userData 按应用名放在 appData 下，macOS 上正是 Host 的数据目录
// ~/Library/Application Support/Wevir。改到数据目录的 desktop/ 子目录：不与 Host 的文件混在一起，
// WEVIR_HOME 也能把桌面端的 Chromium 配置一并隔离（单实例锁同样按它）。
app.setPath('userData', join(home, 'desktop'));
if (devServerUrl !== undefined) {
  // Chrome 远程调试端口只在开发模式开启（只监听 127.0.0.1）。
  app.commandLine.appendSwitch(
    'remote-debugging-port',
    process.env.WEVIR_DESKTOP_DEBUG_PORT ?? '9339',
  );
}
protocol.registerSchemesAsPrivileged([
  { scheme: APP_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
// 所有渲染进程都进沙箱，包括将来新建的窗口。
app.enableSandbox();

if (app.requestSingleInstanceLock()) {
  run();
} else {
  // 同一数据目录已有桌面端在运行：交给它（second-instance），自己退出，不再拉起或附着 Host。
  app.quit();
}

function run(): void {
  let mainWindow: BrowserWindow | undefined;

  // Host 与窗口并行准备。首次只尝试一次，失败时 getHostConnection 把原因交给渲染进程显示；之后拥有的 Host
  // 意外退出由 HostLifecycle 重新拉起，状态经 hostStatus 推给渲染进程（T5.5）。
  const host = (async () => {
    const identity = await loadDesktopIdentity(home);
    // Host 跑在 Electron 自带的 Node 上，用户不用装 Node（ADR-0007 决策 4）。
    const runtime = hostRuntime();
    const lifecycle = new HostLifecycle({
      home,
      identity,
      nodePath: runtime.nodePath,
      hostEntry: app.isPackaged ? packagedHostEntry(process.resourcesPath) : resolveHostEntry(),
      env: {
        // 打包后随附的 Host、codex-app-server 与提示词都在资源目录里（ADR-0007 决策 5）。
        ...hostEnvironment(process.env, app.isPackaged ? process.resourcesPath : undefined),
        ...runtime.env,
      },
      log,
    });
    lifecycle.onStatus((status) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.hostStatus, status);
      }
    });
    return { identity, lifecycle };
  })();
  void host
    .then(({ lifecycle }) => lifecycle.start())
    .catch((error: unknown) => log('error', 'host unavailable', { error: String(error) }));
  /** 连 HostLifecycle 都建不起来（找不到 Node、Host 没有构建）时，界面看到的状态。 */
  const setupFailure = (error: unknown): HostProcessStatus => ({
    phase: 'failed',
    error: failureOf(error),
    logPath: join(home, HOME_LAYOUT.logsDir, LOG_FILE),
  });

  /** IPC 只接受主窗口主框架、且来自渲染进程 origin 的调用（Electron 安全清单第 17 条）。 */
  const assertSender = (event: IpcMainInvokeEvent): BrowserWindow => {
    const frame = event.senderFrame;
    if (
      mainWindow === undefined ||
      mainWindow.isDestroyed() ||
      event.sender !== mainWindow.webContents ||
      frame === null ||
      frame !== mainWindow.webContents.mainFrame ||
      rendererOriginOf(frame.url) !== rendererOrigin
    ) {
      throw new Error('rejected an IPC call from an unknown page');
    }
    return mainWindow;
  };

  ipcMain.handle(IPC_CHANNELS.getHostConnection, async (event): Promise<HostConnection> => {
    assertSender(event);
    const { identity, lifecycle } = await host;
    return { ...(await lifecycle.endpoint()), identity };
  });
  ipcMain.handle(IPC_CHANNELS.getHostStatus, async (event): Promise<HostProcessStatus> => {
    assertSender(event);
    return host.then(({ lifecycle }) => lifecycle.status, setupFailure);
  });
  ipcMain.handle(IPC_CHANNELS.retryHost, async (event): Promise<void> => {
    assertSender(event);
    const { lifecycle } = await host;
    void lifecycle.retry();
  });
  ipcMain.handle(IPC_CHANNELS.selectFolder, async (event): Promise<string | null> => {
    const window = assertSender(event);
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle(
    IPC_CHANNELS.selectPaths,
    async (event, defaultPath: unknown): Promise<string[]> => {
      const window = assertSender(event);
      const result = await dialog.showOpenDialog(window, {
        // macOS 能同时选文件与文件夹；其他平台的对话框只认其中一种，取文件。
        properties: [
          'openFile',
          ...(process.platform === 'darwin' ? (['openDirectory'] as const) : []),
          'multiSelections',
        ],
        ...(typeof defaultPath === 'string' && isAbsolute(defaultPath) && { defaultPath }),
      });
      return result.canceled ? [] : result.filePaths;
    },
  );
  ipcMain.handle(IPC_CHANNELS.openExternal, async (event, url: unknown): Promise<void> => {
    assertSender(event);
    if (typeof url !== 'string' || !isExternalUrl(url)) {
      throw new Error('only http, https and mailto links can be opened');
    }
    await shell.openExternal(url);
  });
  ipcMain.handle(IPC_CHANNELS.copyText, async (event, text: unknown): Promise<void> => {
    assertSender(event);
    if (typeof text !== 'string' || text.length > MAX_COPY_LENGTH) {
      throw new Error('only strings of at most 8M characters can be copied');
    }
    clipboard.writeText(text);
  });
  ipcMain.handle(IPC_CHANNELS.setThemeSource, async (event, mode: unknown): Promise<void> => {
    const window = assertSender(event);
    if (!isThemeMode(mode)) throw new Error('theme mode must be system, light or dark');
    nativeTheme.themeSource = mode;
    window.setBackgroundColor(windowBackground());
  });

  // 系统通知（U31）：显示中的通知按 tag 留着引用，否则可能被回收，点击就没有回调了。同一个 tag 的新通知替换旧的。
  const notifications = new Map<string, Notification>();
  ipcMain.handle(IPC_CHANNELS.notify, async (event, value: unknown): Promise<boolean> => {
    assertSender(event);
    const input = parseDesktopNotification(value);
    if (!input) throw new Error('invalid notification');
    if (!Notification.isSupported()) return false;
    notifications.get(input.tag)?.close();
    const notification = new Notification({
      title: input.title,
      body: input.body,
      silent: !input.sound,
    });
    notifications.set(input.tag, notification);
    const forget = () => {
      if (notifications.get(input.tag) === notification) notifications.delete(input.tag);
    };
    notification.on('click', () => {
      forget();
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send(IPC_CHANNELS.notificationClick, input.tag);
    });
    notification.on('close', forget);
    notification.show();
    return true;
  });
  ipcMain.handle(IPC_CHANNELS.closeNotifications, async (event, tag: unknown): Promise<void> => {
    assertSender(event);
    if (tag !== undefined && typeof tag !== 'string') throw new Error('tag must be a string');
    for (const [key, notification] of notifications) {
      if (tag !== undefined && key !== tag) continue;
      notification.close();
      notifications.delete(key);
    }
  });
  ipcMain.handle(IPC_CHANNELS.setBadgeCount, async (event, count: unknown): Promise<void> => {
    assertSender(event);
    if (!isBadgeCount(count)) throw new Error('badge count must be an integer from 0 to 9999');
    app.setBadgeCount(count);
  });

  // 外部编辑器与访达（U32，文件窗格）：路径要是绝对的、存在；编辑器只从本机找到的那张表里选。
  const editors = new Editors();
  ipcMain.handle(IPC_CHANNELS.listEditors, async (event) => {
    assertSender(event);
    return editors.list();
  });
  ipcMain.handle(
    IPC_CHANNELS.openInEditor,
    async (event, editorId: unknown, path: unknown, line: unknown): Promise<void> => {
      assertSender(event);
      if (typeof editorId !== 'string' || typeof path !== 'string' || !isAbsolute(path)) {
        throw new Error('editor id and an absolute path are required');
      }
      if (line !== undefined && !isLineNumber(line)) throw new Error('line must be positive');
      await editors.open(editorId, path, line);
    },
  );
  ipcMain.handle(IPC_CHANNELS.revealPath, async (event, path: unknown): Promise<void> => {
    assertSender(event);
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('path must be absolute');
    await stat(path);
    shell.showItemInFolder(path);
  });
  // 文件窗格（0.32.0）：Office 等窗格里看不了的文件交给系统。只认文档与媒体（shared/open-path.ts），不打开可执行文件。
  const openablePath = async (path: unknown): Promise<string> => {
    if (typeof path !== 'string' || !isAbsolute(path) || !canOpenExternally(path)) {
      throw new Error('an absolute path to a document or media file is required');
    }
    if (!(await stat(path)).isFile()) throw new Error('not a file');
    return path;
  };
  ipcMain.handle(IPC_CHANNELS.previewFile, async (event, path: unknown): Promise<boolean> => {
    assertSender(event);
    const file = await openablePath(path);
    // Quick Look 只有 macOS 有（Electron 的 previewFile）；其他平台由渲染进程改用 openPath。
    if (process.platform !== 'darwin' || !mainWindow || mainWindow.isDestroyed()) return false;
    mainWindow.previewFile(file);
    return true;
  });
  ipcMain.handle(IPC_CHANNELS.openPath, async (event, path: unknown): Promise<void> => {
    assertSender(event);
    const error = await shell.openPath(await openablePath(path));
    if (error !== '') throw new Error(error);
  });

  // 自动更新（ADR-0007 补记 4）：开发构建里是 disabled，界面不显示入口。
  const updates = createUpdateController(log);
  updates.onState((state: UpdateState) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.updateState, state);
    }
  });
  ipcMain.handle(IPC_CHANNELS.getUpdateState, async (event): Promise<UpdateState> => {
    assertSender(event);
    return updates.state;
  });
  ipcMain.handle(IPC_CHANNELS.checkForUpdates, async (event): Promise<void> => {
    assertSender(event);
    await updates.check();
  });
  ipcMain.handle(IPC_CHANNELS.downloadUpdate, async (event): Promise<void> => {
    assertSender(event);
    await updates.download();
  });
  ipcMain.handle(IPC_CHANNELS.installUpdate, async (event): Promise<void> => {
    assertSender(event);
    updates.install();
  });
  ipcMain.handle(IPC_CHANNELS.setUpdateChannel, async (event, channel: unknown): Promise<void> => {
    assertSender(event);
    if (channel !== 'stable' && channel !== 'dev') throw new Error('unknown update channel');
    await updates.setChannel(channel);
  });
  ipcMain.handle(IPC_CHANNELS.moveToApplications, async (event): Promise<void> => {
    assertSender(event);
    if (process.platform !== 'darwin') return;
    // 成功时 Electron 把应用移过去并重新打开，这个进程随之退出。
    app.moveToApplicationsFolder();
  });

  // 内置浏览器（0.33.0，browser/）：标签页是主窗口里的 WebContentsView，用自己的 session 分区与导航规则。
  const browser = registerBrowserIpc({
    getWindow: () => mainWindow,
    assertSender,
    log,
  });

  // 所有 webContents（含将来的）一律：新窗口拒绝，外部链接交给系统浏览器；只允许同 origin 的导航
  // （开发服务器的整页刷新）；不允许挂 <webview>（Electron 安全清单第 12、13 条）。内置浏览器的标签页有自己的规则
  // （只放行 http(s)，弹窗变成新标签页，外部协议一律拒绝），这里只给它们加上“不许挂 <webview>”。
  app.on('web-contents-created', (_event, contents) => {
    if (browser.isBrowserContents(contents)) {
      contents.on('will-attach-webview', (event) => event.preventDefault());
      return;
    }
    contents.setWindowOpenHandler(({ url }) => {
      openIfExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (rendererOriginOf(url) === rendererOrigin) return;
      event.preventDefault();
      openIfExternal(url);
    });
    // 子框架（0.32.0，文件窗格的 PDF 与网页预览）：只能加载 Host 的文件地址（host-api.md §1 的 `/files/`）与 PDF 查看器自己的
    // 框架。沙箱里的网页（跨 origin 的子框架）自己发起的跳转不触发这个事件，由 whenReady 里的 webRequest 拦下。
    contents.on('will-frame-navigate', (details) => {
      if (details.isMainFrame || isFilePreviewUrl(details.url)) return;
      details.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  // 骨架没有托盘，关掉窗口就退出（macOS 也一样），自己拉起的 Host 随之停止。
  app.on('window-all-closed', () => app.quit());

  // 退出前只停自己拉起的 Host（附着的不停），停完再真正退出。
  let quitReady = false;
  let quitting = false;
  app.on('before-quit', (event) => {
    if (quitReady) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void host
      .then(({ lifecycle }) => lifecycle.stop())
      .catch((error: unknown) => log('error', 'failed to stop host', { error: String(error) }))
      .finally(() => {
        quitReady = true;
        app.quit();
      });
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => app.quit());

  void app.whenReady().then(() => {
    // 渲染进程不需要任何权限（摄像头、通知、剪贴板读取等），一律拒绝（Electron 安全清单第 5 条）。
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    session.defaultSession.setPermissionCheckHandler(() => false);
    // 文件窗格里的网页（0.32.0）：子框架只许加载 Host 的文件地址，页面里的链接、跳转与 meta refresh 都不让框架离开（Paseo 的 HTML
    // 预览同样要挡导航，CSP 管不到）。新窗口（target=_blank、window.open）照旧由 setWindowOpenHandler 交给系统浏览器，Chromium
    // 只在用户点了之后才放行弹窗。
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'] },
      (details, callback) => {
        callback({
          cancel: details.resourceType === 'subFrame' && !isFilePreviewUrl(details.url),
        });
      },
    );
    const rendererDir = fileURLToPath(new URL('../renderer/', import.meta.url));
    protocol.handle(APP_SCHEME, (request) => serveRendererFile(request, rendererDir));
    applyAppIcon();
    mainWindow = createWindow();
    // 内置浏览器的后台标签页停在一个不显示的窗口里：主窗口关掉时一起关，否则 window-all-closed 不会触发。
    mainWindow.on('closed', () => browser.destroy());
    updates.start();
  });
}

/**
 * 窗口底色，与渲染进程的 --background（tokens.css）一致，窗口缩放露出未绘制区域时不闪色。
 * 启动时 themeSource 是 'system'，渲染进程按存储的主题模式调用 setThemeSource 后再更新。
 */
function windowBackground(): string {
  return THEME_BACKGROUND[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'];
}

/**
 * macOS 隐藏系统标题栏，由页面的顶栏（高 44 px，h-11）充当标题栏，红绿灯浮在它的左侧、垂直居中。页面给
 * 红绿灯让出的宽度在渲染进程的 index.css（--traffic-lights-inset）。其他平台仍用系统标题栏。
 */
const HIDDEN_TITLE_BAR = process.platform === 'darwin';
const TRAFFIC_LIGHT_POSITION = { x: 16, y: 15 };

/** 红绿灯浮在页面上的时候：隐藏了系统标题栏，且不在全屏（全屏时系统把它们收进菜单栏）。 */
function windowChrome(window: BrowserWindow): WindowChrome {
  return { trafficLights: HIDDEN_TITLE_BAR && !window.isFullScreen() };
}

function createWindow(): BrowserWindow {
  const icon = windowIcon();
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    // 左栏最窄 220 + 中栏最窄 560，再留出拖动与边框的余量；更窄（例如放大界面后）由渲染进程的
    // 折叠规则处理（src/renderer/src/layout/layout-rules.ts）。
    minWidth: 960,
    minHeight: 600,
    title: 'Wevir',
    ...(icon !== undefined && { icon }),
    ...(HIDDEN_TITLE_BAR && {
      titleBarStyle: 'hidden',
      trafficLightPosition: TRAFFIC_LIGHT_POSITION,
    }),
    backgroundColor: windowBackground(),
    show: false,
    webPreferences: {
      // 沙箱里的 preload 不能是 ESM，electron-vite 把它打成单个 CJS 文件（ADR-0004 §3）。
      preload: fileURLToPath(new URL('../preload/index.cjs', import.meta.url)),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
    },
  });
  window.once('ready-to-show', () => window.show());
  // preload 按平台给出初值；进出全屏与页面（重新）加载完成时推送实际状态，例如在全屏里刷新页面。
  const pushWindowChrome = () =>
    window.webContents.send(IPC_CHANNELS.windowChrome, windowChrome(window));
  window.on('enter-full-screen', pushWindowChrome);
  window.on('leave-full-screen', pushWindowChrome);
  window.webContents.on('dom-ready', pushWindowChrome);
  void window.loadURL(devServerUrl ?? APP_ENTRY_URL);
  return window;
}

/** copyText 一次最多复制的字符数（UTF-16 code unit），挡住渲染进程塞来的超大字符串。 */
const MAX_COPY_LENGTH = 8 * 1024 * 1024;

function isExternalUrl(url: string): boolean {
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** Chromium 自带的 PDF 查看器（扩展的 ID）：它在 PDF 的框架里再开一个自己的框架显示内容。 */
const PDF_VIEWER_EXTENSION = 'mhjfbmdgcfjbbpaeojofohoefgiehjai';

/** Host 发的文件预览地址（`workspace.fileUrl`）：本机、任意端口、`/files/` 下；以及 PDF 查看器自己的框架。 */
function isFilePreviewUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    // chrome-extension: 不是特殊协议，URL 的 origin 是 'null'，按协议与主机比。
    if (parsed.protocol === 'chrome-extension:' && parsed.host === PDF_VIEWER_EXTENSION)
      return true;
    return (
      parsed.protocol === 'http:' &&
      parsed.hostname === '127.0.0.1' &&
      parsed.pathname.startsWith('/files/')
    );
  } catch {
    return false;
  }
}

function openIfExternal(url: string): void {
  if (!isExternalUrl(url)) return;
  shell
    .openExternal(url)
    .catch((error: unknown) =>
      log('warn', 'failed to open external url', { error: String(error) }),
    );
}
