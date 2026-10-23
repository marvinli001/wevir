// Wevir 桌面主进程（T5.1）：窗口与安全基线、Host 的附着 / 拉起 / 停止、给 preload 的 IPC。
// Host 的生命周期见 host-lifecycle.ts（ADR-0002 §6）；渲染进程只经 client-sdk 与 Host 通信。

// 第一个求值：冷启动计时的起点在其他模块之前（startup-timing.ts）。
import './startup-timing.js';
import { existsSync } from 'node:fs';
import { copyFile, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOME_LAYOUT, LOG_FILE, resolveHome } from '@wevir/host/runtime';
import {
  app,
  autoUpdater,
  BrowserWindow,
  clipboard,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  Menu,
  Notification,
  nativeTheme,
  powerMonitor,
  powerSaveBlocker,
  protocol,
  screen,
  session,
  shell,
} from 'electron';
import {
  type HostConnection,
  type HostProcessStatus,
  IPC_CHANNELS,
  type MenuSettingsTab,
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
import { isCleanableCategory, type StorageUsage } from '../shared/storage.js';
import { isThemeMode } from '../shared/theme.js';
import { applyAppIcon, windowIcon } from './app-icon.js';
import { appMenuTemplate, DEFAULT_APP_MENU_LABELS, parseAppMenuLabels } from './app-menu.js';
import { BROWSER_PARTITION } from './browser/browser-host.js';
import { registerBrowserIpc } from './browser/browser-ipc.js';
import { registerComputerIpc } from './computer/computer-ipc.js';
import { Editors, isLineNumber } from './editors.js';
import {
  failureOf,
  HostLifecycle,
  hostEnvironment,
  type Log,
  nodeHostSpawner,
  nodeOverride,
  packagedHostEntry,
  resolveHostEntry,
} from './host-lifecycle.js';
import { loadDesktopIdentity } from './identity.js';
import { allowMicrophoneCheck, allowMicrophoneRequest } from './media-permission.js';
import { isBadgeCount, parseDesktopNotification } from './notification-input.js';
import { inspectInstallSource, readSkillFile } from './plugin-source.js';
import { serveRendererFile } from './renderer-files.js';
import { markStartup, type StartupMark } from './startup-timing.js';
import { BROWSER_PARTITION_DIR, cleanLogs, measureStorage } from './storage.js';
import { type AppTray, createAppTray, parseTrayLabels } from './tray.js';
import { createUpdateController } from './updates/electron-updates.js';
import {
  finishInstallTiming,
  INSTALL_TIMING_LOG,
  markInstallTiming,
  PENDING_INSTALL_FILE,
  type StartupMarks,
  startInstallTiming,
} from './updates/install-timing.js';
import { utilityHostSpawner } from './utility-host.js';
import {
  DEFAULT_WINDOW_APPEARANCE,
  loadWindowAppearance,
  parseWindowAppearanceInput,
  saveWindowAppearance,
  type WindowAppearance,
} from './window-appearance.js';
import {
  fitWindowState,
  loadWindowState,
  saveWindowState,
  type WindowState,
} from './window-state.js';

const log: Log = (level, message, detail) => {
  const line = `[wevir-desktop] ${level} ${message}${detail ? ` ${JSON.stringify(detail)}` : ''}`;
  if (level === 'info') console.log(line);
  else console.error(line);
};

/** 冷启动各段的计时（startup-timing.ts），齐了打一行日志。 */
const mark = (name: StartupMark) =>
  markStartup(name, (timings) => log('info', 'startup timings (ms since process start)', timings));
mark('mainEvaluated');

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
  let tray: AppTray | undefined;
  /**
   * 关掉主窗口只是隐藏，Wevir 留在后台（菜单栏 / 通知区域的图标，tray.ts）；真正退出（菜单的退出、⌘Q、托盘的退出、
   * 安装更新、关机）之前置位，窗口才真的关。
   */
  let allowClose = false;
  /** 显示并聚焦主窗口（托盘、程序坞、第二个实例、通知的点击）。 */
  const showMainWindow = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  };

  // 启动各阶段的时间点：窗口显示且 Host 就绪（或失败）后记一行日志；刚装完更新时连同旧版本记下的时间点追加到
  // logs/update-timing.log（install-timing.ts）。
  const installTimingFile = join(app.getPath('userData'), PENDING_INSTALL_FILE);
  const startup: StartupMarks = {
    processAt: process.getCreationTime() ?? Date.now() - process.uptime() * 1000,
  };
  const markInstallStartup = (key: 'windowAt' | 'hostAt') => {
    if (startup[key] !== undefined) return;
    startup[key] = Date.now();
    if (startup.windowAt === undefined || startup.hostAt === undefined) return;
    const since = (at: number | undefined) =>
      at === undefined ? undefined : Math.round(at - startup.processAt);
    log('info', 'startup timing', {
      appReadyMs: since(startup.readyAt),
      windowMs: since(startup.windowAt),
      hostMs: since(startup.hostAt),
    });
    try {
      const timing = finishInstallTiming({
        file: installTimingFile,
        logFile: join(home, HOME_LAYOUT.logsDir, INSTALL_TIMING_LOG),
        currentVersion: app.getVersion(),
        marks: startup,
        now: Date.now(),
      });
      if (timing !== undefined) log('info', 'update install timing', { ...timing });
    } catch (error) {
      log('warn', 'failed to record the update install timing', { error: String(error) });
    }
  };

  // Host 与窗口并行准备。首次只尝试一次，失败时 getHostConnection 把原因交给渲染进程显示；之后拥有的 Host
  // 意外退出由 HostLifecycle 重新拉起，状态经 hostStatus 推给渲染进程（T5.5）。
  // 在这里（app ready 之前）就拉起：Host 是打开后可用的关键路径，身份文件并行读，只有探活的 hello 等它。
  const host = (async () => {
    const identity = loadDesktopIdentity(home);
    // Host 是 Electron 的 utility process，用户不用装 Node（ADR-0007 决策 4、补记 10）；WEVIR_NODE 改用别的 Node 时以子进程跑。
    const node = nodeOverride();
    const lifecycle = new HostLifecycle({
      home,
      identity,
      spawner: node === undefined ? utilityHostSpawner() : nodeHostSpawner(node),
      hostEntry: app.isPackaged ? packagedHostEntry(process.resourcesPath) : resolveHostEntry(),
      // 打包后随附的 Host、codex-app-server 与提示词都在资源目录里（ADR-0007 决策 5）。
      env: hostEnvironment(process.env, app.isPackaged ? process.resourcesPath : undefined),
      log,
    });
    lifecycle.onStatus((status) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.hostStatus, status);
      }
    });
    void lifecycle
      .start()
      .then(() => mark('hostReady'))
      .catch((error: unknown) => log('error', 'host unavailable', { error: String(error) }))
      .finally(() => markInstallStartup('hostAt'));
    try {
      return { identity: await identity, lifecycle };
    } catch (error) {
      // 读不了身份就同连 HostLifecycle 都建不起来一样（setupFailure）；已经拉起的 Host 停掉。
      void lifecycle.stop();
      throw error;
    }
  })();
  void host.catch((error: unknown) => {
    log('error', 'host unavailable', { error: String(error) });
    markInstallStartup('hostAt');
  });
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
    const connection = { ...(await lifecycle.endpoint()), identity };
    mark('hostConnection');
    return connection;
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
  // 插件页（0.42.0）：“添加”的来源选择与判断、Skills 预览读 SKILL.md（plugin-source.ts，只读）。
  ipcMain.handle(
    IPC_CHANNELS.selectInstallSource,
    async (event, kind: unknown): Promise<string | null> => {
      const window = assertSender(event);
      if (kind !== 'folder' && kind !== 'file') throw new Error('kind must be folder or file');
      // Windows 与 Linux 的对话框不能同时选文件与文件夹，所以分两种；.md 里再由 inspectInstallSource 认 SKILL.md。
      const result = await dialog.showOpenDialog(
        window,
        kind === 'folder'
          ? { properties: ['openDirectory'] }
          : {
              properties: ['openFile'],
              filters: [{ name: 'ZIP, SKILL.md', extensions: ['zip', 'md'] }],
            },
      );
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  );
  ipcMain.handle(IPC_CHANNELS.inspectInstallSource, async (event, path: unknown) => {
    assertSender(event);
    if (typeof path !== 'string') throw new Error('path must be a string');
    return inspectInstallSource(path);
  });
  ipcMain.handle(IPC_CHANNELS.readSkillFile, async (event, path: unknown): Promise<string> => {
    assertSender(event);
    if (typeof path !== 'string') throw new Error('path must be a string');
    return readSkillFile(path);
  });
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
    rememberWindowAppearance({ ...windowAppearance, themeMode: mode });
  });
  ipcMain.handle(IPC_CHANNELS.setWindowAppearance, async (event, value: unknown): Promise<void> => {
    const window = assertSender(event);
    const input = parseWindowAppearanceInput(value);
    if (!input) throw new Error('invalid window appearance');
    const translucent = process.platform === 'darwin' && input.translucentSidebar;
    if (translucent !== windowAppearance.translucentSidebar) {
      window.setVibrancy(translucent ? 'sidebar' : null);
    }
    rememberWindowAppearance({ ...windowAppearance, ...input, translucentSidebar: translucent });
    window.setBackgroundColor(windowBackground());
  });
  // 运行时防止系统休眠（设置 → 常规）：渲染进程在“有回合在跑且打开了这一项”变化时告诉这里。
  let sleepBlocker: number | undefined;
  ipcMain.handle(IPC_CHANNELS.setPreventSleep, async (event, active: unknown): Promise<void> => {
    assertSender(event);
    if (typeof active !== 'boolean') throw new Error('active must be a boolean');
    if (active && sleepBlocker === undefined) {
      sleepBlocker = powerSaveBlocker.start('prevent-app-suspension');
    } else if (!active && sleepBlocker !== undefined) {
      powerSaveBlocker.stop(sleepBlocker);
      sleepBlocker = undefined;
    }
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
      showMainWindow();
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
  // agent 交给用户的文件（0.40.0）：另存为。目标由用户在保存对话框里选，这里只复制，不打开。
  ipcMain.handle(
    IPC_CHANNELS.saveFileAs,
    async (event, path: unknown, name: unknown): Promise<'saved' | 'cancelled'> => {
      assertSender(event);
      if (typeof path !== 'string' || !isAbsolute(path) || typeof name !== 'string') {
        throw new Error('an absolute path and a file name are required');
      }
      if (!(await stat(path)).isFile()) throw new Error('not a file');
      const fileName = basename(name.replaceAll('\\', '/')) || basename(path);
      const options = { defaultPath: join(app.getPath('downloads'), fileName) };
      const result =
        mainWindow && !mainWindow.isDestroyed()
          ? await dialog.showSaveDialog(mainWindow, options)
          : await dialog.showSaveDialog(options);
      if (result.canceled || result.filePath === undefined || result.filePath === '') {
        return 'cancelled';
      }
      await copyFile(path, result.filePath);
      return 'saved';
    },
  );
  // 任务回顾的导出（0.76.0）：渲染进程给文件名与文本，目标由用户在保存对话框里选。
  ipcMain.handle(
    IPC_CHANNELS.saveTextAs,
    async (event, name: unknown, text: unknown): Promise<'saved' | 'cancelled'> => {
      assertSender(event);
      if (typeof name !== 'string' || typeof text !== 'string' || text.length > MAX_COPY_LENGTH) {
        throw new Error('a file name and a string of at most 8M characters are required');
      }
      const fileName = basename(name.replaceAll('\\', '/'));
      if (!/\.(?:md|json)$/i.test(fileName))
        throw new Error('only .md and .json files can be saved');
      const options = { defaultPath: join(app.getPath('downloads'), fileName) };
      const result =
        mainWindow && !mainWindow.isDestroyed()
          ? await dialog.showSaveDialog(mainWindow, options)
          : await dialog.showSaveDialog(options);
      if (result.canceled || result.filePath === undefined || result.filePath === '') {
        return 'cancelled';
      }
      await writeFile(result.filePath, text, 'utf8');
      return 'saved';
    },
  );

  // 自动更新（ADR-0007 补记 4）：开发构建里是 disabled，界面不显示入口。
  // Windows 的 NSIS 安装程序在应用退出之前就启动，一两秒后查安装目录里还在跑的进程（Host 也是 Wevir.exe，引擎在资源目录里），
  // 找到就强制结束再循环等待：先把自己拉起的 Host 优雅停完，再交给安装程序。macOS 的 Squirrel 等应用退出后才替换，不用提前停。
  const updates = createUpdateController(
    log,
    process.platform === 'win32'
      ? {
          prepareInstall: async () => {
            await host.then(({ lifecycle }) => lifecycle.stop());
            markInstallTiming(installTimingFile, 'hostStoppedAt', Date.now());
          },
        }
      : {},
  );
  /** 这次退出是在安装更新：退出前补上时间点。 */
  let installingUpdate = false;
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
    // 安装更新要关掉窗口再退出；装不了（状态变成 error）时恢复“关窗口只是隐藏”。Windows 上 Host 已经为安装停掉、不能再
    // 拉起（HostLifecycle 停了就不再启动），这时重新打开应用。
    allowClose = true;
    if (updates.state.phase === 'downloaded') {
      installingUpdate = true;
      startInstallTiming(installTimingFile, {
        from: app.getVersion(),
        to: updates.state.version,
        platform: process.platform,
        clickedAt: Date.now(),
      });
    }
    await updates.install();
    if (installingUpdate) markInstallTiming(installTimingFile, 'installerAt', Date.now());
    if (updates.state.phase !== 'error') return;
    if (process.platform === 'win32') {
      log('error', 'update install failed after the host was stopped; relaunching');
      app.relaunch();
      app.quit();
    } else {
      allowClose = false;
    }
  });
  // macOS 的 Squirrel 在关窗口之前发这个事件，不经过 before-quit。
  autoUpdater.on('before-quit-for-update', () => {
    allowClose = true;
  });
  ipcMain.handle(IPC_CHANNELS.setTrayLabels, async (event, value: unknown): Promise<void> => {
    assertSender(event);
    const labels = parseTrayLabels(value);
    if (!labels) throw new Error('tray labels must be two short strings');
    tray?.setLabels(labels);
  });
  // macOS 应用菜单（app-menu.ts）：设置…与检查更新…先把窗口叫出来（可能藏在后台），再让渲染进程跳到设置页；检查更新
  // 打开设置 → 关于，结果在那里显示。
  const openSettingsFromMenu = (tab: MenuSettingsTab) => {
    showMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC_CHANNELS.openSettings, tab);
    }
  };
  const setAppMenu = (labels = DEFAULT_APP_MENU_LABELS) => {
    if (process.platform !== 'darwin') return;
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        appMenuTemplate(labels, {
          openSettings: () => openSettingsFromMenu('general'),
          checkForUpdates: () => {
            openSettingsFromMenu('about');
            void updates.check();
          },
        }),
      ),
    );
  };
  ipcMain.handle(IPC_CHANNELS.setAppMenuLabels, async (event, value: unknown): Promise<void> => {
    assertSender(event);
    const labels = parseAppMenuLabels(value);
    if (!labels) throw new Error('app menu labels must all be short strings');
    setAppMenu(labels);
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

  // 设置 → 存储：量数据目录（main/storage.ts）。缓存与内置浏览器的数据由 Chromium 自己清（文件还开着），日志直接清。
  ipcMain.handle(IPC_CHANNELS.getStorageUsage, async (event): Promise<StorageUsage> => {
    assertSender(event);
    return measureStorage(home);
  });
  ipcMain.handle(
    IPC_CHANNELS.cleanStorage,
    async (event, categories: unknown): Promise<StorageUsage> => {
      assertSender(event);
      if (!Array.isArray(categories) || !categories.every(isCleanableCategory)) {
        throw new Error('categories must be cache, browser or logs');
      }
      // 内置浏览器还没用过时没有分区目录，不为清理去建它。
      const browserSession = existsSync(join(app.getPath('userData'), BROWSER_PARTITION_DIR))
        ? session.fromPartition(BROWSER_PARTITION)
        : undefined;
      for (const category of new Set(categories)) {
        if (category === 'cache') {
          for (const target of [session.defaultSession, browserSession]) {
            await target?.clearCache();
            await target?.clearCodeCaches({});
          }
        } else if (category === 'browser') {
          // 内置浏览器的 Cookie、本地存储、登录状态：网站都要重新登录。
          await browserSession?.clearStorageData();
          await browserSession?.clearAuthCache();
          await browserSession?.clearCache();
        } else {
          await cleanLogs(home);
        }
      }
      return measureStorage(home);
    },
  );

  // 内置浏览器（0.33.0，browser/）：标签页是主窗口里的 WebContentsView，用自己的 session 分区与导航规则。
  const browser = registerBrowserIpc({
    getWindow: () => mainWindow,
    assertSender,
    log,
  });
  // 电脑操作（0.114.0，computer/）：原生 helper 由这里拉起，屏幕录制与辅助功能的权限归在 Wevir.app 上。
  const computer = registerComputerIpc({
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

  app.on('second-instance', showMainWindow);
  // macOS：点程序坞图标（窗口关掉、藏在后台时）把窗口叫回来。
  app.on('activate', showMainWindow);

  // 窗口只在真正退出时才关（见 allowClose），所以走到这里就是在退出；自己拉起的 Host 随之停止。
  app.on('window-all-closed', () => app.quit());

  // 退出前只停自己拉起的 Host（附着的不停），停完再真正退出。
  let quitReady = false;
  let quitting = false;
  app.on('before-quit', (event) => {
    allowClose = true;
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
  app.on('will-quit', () => {
    if (installingUpdate) markInstallTiming(installTimingFile, 'quitAt', Date.now());
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => app.quit());

  void app.whenReady().then(() => {
    mark('appReady');
    startup.readyAt = Date.now();
    // 渲染进程的权限（摄像头、通知、剪贴板读取等）一律拒绝（Electron 安全清单第 5 条），只有听写（0.92.0）要的麦克风例外：主窗口
    // 的主框架、应用自己的页面、只要音频（media-permission.ts）。
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) =>
      callback(
        contents === mainWindow?.webContents &&
          allowMicrophoneRequest(
            {
              permission,
              mediaTypes: 'mediaTypes' in details ? details.mediaTypes : undefined,
              requestingUrl: details.requestingUrl,
              isMainFrame: details.isMainFrame,
            },
            rendererOrigin,
          ),
      ),
    );
    session.defaultSession.setPermissionCheckHandler(
      (contents, permission, requestingOrigin, details) =>
        contents === mainWindow?.webContents &&
        allowMicrophoneCheck(permission, requestingOrigin, details.mediaType, rendererOrigin),
    );
    // 文件窗格里的网页（0.32.0）：子框架只许加载 Host 的文件地址，页面里的链接、跳转与 meta refresh 都不让框架离开（Paseo 的 HTML
    // 预览同样要挡导航，CSP 管不到）。新窗口（target=_blank、window.open）照旧由 setWindowOpenHandler 交给系统浏览器，Chromium
    // 只在用户点了之后才放行弹窗。只拦子框架：其余请求（Host 的文件、图片）不必每个都经主进程走一趟。
    session.defaultSession.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*'], types: ['subFrame'] },
      (details, callback) => {
        callback({
          cancel: details.resourceType === 'subFrame' && !isFilePreviewUrl(details.url),
        });
      },
    );
    const rendererDir = fileURLToPath(new URL('../renderer/', import.meta.url));
    protocol.handle(APP_SCHEME, (request) => serveRendererFile(request, rendererDir));
    // 上次的主题模式与底色：窗口一出现就是对的深浅色与底色，不等页面加载完再换。
    windowAppearance = loadWindowAppearance(app.getPath('userData'));
    nativeTheme.themeSource = windowAppearance.themeMode;
    mainWindow = createWindow();
    mark('windowCreated');
    mainWindow.once('show', () => markInstallStartup('windowAt'));
    // 建好窗口（页面开始载入）之后再设图标：程序坞图标要解码一张 1024 px 的 PNG，不让页面等它；窗口在首帧之前不显示。
    applyAppIcon();
    // 关窗口（红绿灯、Alt+F4、⌘W）只是隐藏，留在后台；真正退出时才关。
    mainWindow.on('close', (event) => {
      const window = mainWindow;
      if (allowClose || !window || window.isDestroyed()) return;
      event.preventDefault();
      // macOS 的全屏窗口直接隐藏会留下一块黑的桌面空间：先退出全屏，退完再隐藏。
      if (window.isFullScreen()) {
        window.once('leave-full-screen', () => window.hide());
        window.setFullScreen(false);
      } else {
        window.hide();
      }
    });
    // Windows 关机、注销：不拦窗口，直接退出。
    mainWindow.on('session-end', () => {
      allowClose = true;
      app.quit();
    });
    powerMonitor.on('shutdown', () => {
      allowClose = true;
      app.quit();
    });
    // 内置浏览器的后台标签页停在一个不显示的窗口里：主窗口关掉时一起关，否则 window-all-closed 不会触发。
    mainWindow.on('closed', () => {
      browser.destroy();
      // 电脑操作的提示条也是窗口；helper 跟着退出。
      computer.dispose();
      tray?.destroy();
      tray = undefined;
    });
    tray = createAppTray({ onOpen: showMainWindow, onQuit: () => app.quit() });
    setAppMenu();
    updates.start();
    // 定时检查的计时器在睡眠时不走：唤醒、回到前台时，上次检查过久就补查（updater.ts 的 checkIfStale）。
    powerMonitor.on('resume', () => updates.checkIfStale());
    // 锁屏与睡眠告诉渲染进程，它据此报在场（0.106.0，notifications/presence.ts）。
    const sendScreenLock = (locked: boolean) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.screenLock, locked);
      }
    };
    powerMonitor.on('lock-screen', () => sendScreenLock(true));
    powerMonitor.on('suspend', () => sendScreenLock(true));
    powerMonitor.on('unlock-screen', () => sendScreenLock(false));
    powerMonitor.on('resume', () => sendScreenLock(false));
    app.on('browser-window-focus', () => updates.checkIfStale());
  });
}

/**
 * 窗口的外观（window-appearance.ts）：主题模式、两种深浅色下的底色、半透明侧栏。app ready 时从上次记下的读回来，在创建窗口
 * 之前设好 themeSource；之后跟着渲染进程的 setThemeSource / setWindowAppearance 更新，停下 500 ms 后写回文件。
 */
let windowAppearance: WindowAppearance = DEFAULT_WINDOW_APPEARANCE;
let saveAppearanceTimer: NodeJS.Timeout | undefined;

function rememberWindowAppearance(next: WindowAppearance): void {
  if (JSON.stringify(next) === JSON.stringify(windowAppearance)) return;
  windowAppearance = next;
  clearTimeout(saveAppearanceTimer);
  saveAppearanceTimer = setTimeout(() => {
    saveWindowAppearance(app.getPath('userData'), windowAppearance).catch((error: unknown) =>
      log('warn', 'failed to save the window appearance', { error: String(error) }),
    );
  }, 500);
}

/**
 * 窗口底色，与渲染进程的 --background（tokens.css 或设置 → 外观里自定义的背景）一致，窗口缩放露出未绘制区域时不闪色；
 * 启动时用上次记下的，页面加载之前就是对的。
 */
function windowBackground(): string {
  // 半透明侧栏：窗口底色透明，露出 vibrancy 的材质（页面的内容区自己画不透明的底色）。
  if (windowAppearance.translucentSidebar) return '#00000000';
  return windowAppearance.background[nativeTheme.shouldUseDarkColors ? 'dark' : 'light'];
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

/** 左栏最窄 220 + 中栏最窄 560，再留出拖动与边框的余量；更窄（例如放大界面后）由渲染进程的折叠规则处理（layout-rules.ts）。 */
const MIN_WINDOW = { width: 960, height: 600 };
const DEFAULT_WINDOW: WindowState = { width: 1280, height: 800, maximized: false };

/** 上次的位置与大小（window-state.ts），对着当前的显示器校正过。 */
function initialWindowState(): WindowState {
  const saved = loadWindowState(app.getPath('userData')) ?? DEFAULT_WINDOW;
  return fitWindowState(
    saved,
    screen.getAllDisplays().map((display) => display.workArea),
    MIN_WINDOW,
  );
}

/** 窗口挪动、缩放、最大化时记下来（停下 500 ms 后写一次），关掉（隐藏）与退出时立刻写。 */
function trackWindowState(window: BrowserWindow): void {
  const dir = app.getPath('userData');
  let timer: NodeJS.Timeout | undefined;
  const current = (): WindowState => ({
    // 最大化、全屏时取还原后的位置与大小。
    ...window.getNormalBounds(),
    maximized: window.isMaximized(),
  });
  const save = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (window.isDestroyed() || window.isMinimized()) return;
    // 全屏期间不记，退出全屏后会再触发 resize。
    if (window.isFullScreen()) return;
    saveWindowState(dir, current()).catch((error: unknown) =>
      log('warn', 'failed to save window state', { error: String(error) }),
    );
  };
  const later = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(save, 500);
  };
  window.on('resize', later);
  window.on('move', later);
  window.on('maximize', later);
  window.on('unmaximize', later);
  window.on('close', save);
}

function createWindow(): BrowserWindow {
  const icon = windowIcon();
  const state = initialWindowState();
  const window = new BrowserWindow({
    width: state.width,
    height: state.height,
    ...(state.x !== undefined && state.y !== undefined && { x: state.x, y: state.y }),
    minWidth: MIN_WINDOW.width,
    minHeight: MIN_WINDOW.height,
    title: 'Wevir',
    ...(icon !== undefined && { icon }),
    ...(HIDDEN_TITLE_BAR && {
      titleBarStyle: 'hidden',
      trafficLightPosition: TRAFFIC_LIGHT_POSITION,
    }),
    backgroundColor: windowBackground(),
    ...(windowAppearance.translucentSidebar && { vibrancy: 'sidebar' }),
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
  // Windows / Linux 不显示 Electron 默认菜单栏（File Edit View Window）；菜单仍在，快捷键照常可用。
  if (process.platform !== 'darwin') window.setMenuBarVisibility(false);
  window.once('ready-to-show', () => {
    mark('readyToShow');
    if (state.maximized) window.maximize();
    window.show();
  });
  trackWindowState(window);
  // preload 按平台给出初值；进出全屏与页面（重新）加载完成时推送实际状态，例如在全屏里刷新页面。
  const pushWindowChrome = () =>
    window.webContents.send(IPC_CHANNELS.windowChrome, windowChrome(window));
  window.on('enter-full-screen', pushWindowChrome);
  window.on('leave-full-screen', pushWindowChrome);
  window.webContents.on('dom-ready', pushWindowChrome);
  window.webContents.once('did-finish-load', () => mark('rendererLoaded'));
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
