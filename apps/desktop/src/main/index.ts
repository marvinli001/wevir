// Wevir 桌面主进程（T5.1）：窗口与安全基线、Host 的附着 / 拉起 / 停止、给 preload 的 IPC。
// Host 的生命周期见 host-lifecycle.ts（ADR-0002 §6）；渲染进程只经 client-sdk 与 Host 通信。

import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sand, sandDark } from '@radix-ui/colors';
import { resolveHome } from '@wevir/host/runtime';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  nativeTheme,
  protocol,
  session,
  shell,
} from 'electron';
import { type HostConnection, IPC_CHANNELS } from '../shared/desktop-api.js';
import {
  APP_ENTRY_URL,
  APP_ORIGIN,
  APP_SCHEME,
  DEV_SERVER_ORIGIN,
  rendererOriginOf,
} from '../shared/renderer-origin.js';
import { isThemeMode } from '../shared/theme.js';
import {
  HostLifecycle,
  type Log,
  resolveHostEntry,
  resolveNodeExecutable,
} from './host-lifecycle.js';
import { loadDesktopIdentity } from './identity.js';
import { serveRendererFile } from './renderer-files.js';

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

  // Host 与窗口并行准备。只尝试一次；失败时 getHostConnection 把原因交给渲染进程显示。
  const host = (async () => {
    const identity = await loadDesktopIdentity(home);
    const lifecycle = new HostLifecycle({
      home,
      identity,
      nodePath: resolveNodeExecutable(),
      hostEntry: resolveHostEntry(),
      log,
    });
    return { identity, lifecycle };
  })();
  void host
    .then(({ lifecycle }) => lifecycle.start())
    .catch((error: unknown) => log('error', 'host unavailable', { error: String(error) }));

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
      throw new Error('拒绝来自未知页面的调用');
    }
    return mainWindow;
  };

  ipcMain.handle(IPC_CHANNELS.getHostConnection, async (event): Promise<HostConnection> => {
    assertSender(event);
    const { identity, lifecycle } = await host;
    return { ...(await lifecycle.endpoint()), identity };
  });
  ipcMain.handle(IPC_CHANNELS.selectFolder, async (event): Promise<string | null> => {
    const window = assertSender(event);
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle(IPC_CHANNELS.openExternal, async (event, url: unknown): Promise<void> => {
    assertSender(event);
    if (typeof url !== 'string' || !isExternalUrl(url)) {
      throw new Error('只能打开 http、https 或 mailto 链接');
    }
    await shell.openExternal(url);
  });
  ipcMain.handle(IPC_CHANNELS.copyText, async (event, text: unknown): Promise<void> => {
    assertSender(event);
    if (typeof text !== 'string' || text.length > MAX_COPY_LENGTH) {
      throw new Error('只能复制字符串，且不超过 8M 个字符');
    }
    clipboard.writeText(text);
  });
  ipcMain.handle(IPC_CHANNELS.setThemeSource, async (event, mode: unknown): Promise<void> => {
    const window = assertSender(event);
    if (!isThemeMode(mode)) throw new Error('主题模式只能是 system、light 或 dark');
    nativeTheme.themeSource = mode;
    window.setBackgroundColor(windowBackground());
  });

  // 所有 webContents（含将来的）一律：新窗口拒绝，外部链接交给系统浏览器；只允许同 origin 的导航
  // （开发服务器的整页刷新）；不允许挂 <webview>（Electron 安全清单第 12、13 条）。
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      openIfExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (rendererOriginOf(url) === rendererOrigin) return;
      event.preventDefault();
      openIfExternal(url);
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
    const rendererDir = fileURLToPath(new URL('../renderer/', import.meta.url));
    protocol.handle(APP_SCHEME, (request) => serveRendererFile(request, rendererDir));
    mainWindow = createWindow();
  });
}

/**
 * 窗口底色，与渲染进程的 --background（tokens.css：sand 第 1 阶）一致，窗口缩放露出未绘制区域时不闪色。
 * 启动时 themeSource 是 'system'，渲染进程按存储的主题模式调用 setThemeSource 后再更新。
 */
function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? sandDark.sand1 : sand.sand1;
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    // 左栏最窄 220 + 中栏最窄 560，再留出拖动与边框的余量；更窄（例如放大界面后）由渲染进程的
    // 折叠规则处理（src/renderer/src/layout/layout-rules.ts）。
    minWidth: 960,
    minHeight: 600,
    title: 'Wevir',
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

function openIfExternal(url: string): void {
  if (!isExternalUrl(url)) return;
  shell
    .openExternal(url)
    .catch((error: unknown) =>
      log('warn', 'failed to open external url', { error: String(error) }),
    );
}
