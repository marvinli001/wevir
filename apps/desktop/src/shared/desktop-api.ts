// preload 经 contextBridge 交给渲染进程的接口（`window.wevir`），以及它背后的 IPC 通道。只有类型和
// 通道名，渲染进程、preload、主进程共用；不 import Node 或 Electron 的东西。

import type { BrowserRequest, BrowserResponse, ClientIdentity } from '@wevir/protocol';
import type { CleanableCategory, StorageUsage } from './storage.js';
import type { ResolvedTheme, ThemeMode } from './theme.js';

/** 连接 Host 需要的全部信息。令牌只放在渲染进程的内存里，不写 localStorage 等任何持久化位置。 */
export interface HostConnection {
  /** `run/host.json` 里的端点，照用、不自己拼（host-api.md §1）。 */
  url: string;
  token: string;
  /** `host.hello` 里的身份（host-api.md §2）。 */
  identity: ClientIdentity;
}

/** Host 进程的归属（ADR-0002 §6）。`{pid, startedAt}` 取自 `run/host.json`，一起认定“是不是同一个 Host”。 */
export interface HostOwnership {
  /**
   * `owned`：本次桌面会话拉起的 Host，持有它的 stdin 归属管道，退出时停止它，意外退出时重新拉起。
   * `attached`：已在运行的 Host（`wevir host start`、手动的 wevir-host 等），只连接，不停止也不替它拉起。
   */
  kind: 'owned' | 'attached';
  pid: number;
  startedAt: string;
}

/** 重新拉起自己拥有的 Host 的最多次数（T5.5）。 */
export const MAX_HOST_RESTARTS = 3;

/**
 * 主进程看到的 Host 进程状态（T5.5），与渲染进程到 Host 的连接状态（client-sdk）是两回事：连接断了时，界面据此
 * 说明是 Host 在重新启动、在等外部的 Host 回来，还是已经放弃。
 */
export type HostProcessStatus =
  /** 首次附着或拉起，或失败后手动重试。 */
  | { phase: 'starting' }
  | { phase: 'running'; ownership: HostOwnership }
  /** 自己拉起的 Host 意外退出，正在重新拉起：第 `attempt` 次，最多 `maxAttempts` 次。 */
  | { phase: 'restarting'; attempt: number; maxAttempts: number; reason: HostFailure }
  /** 附着的 Host 不在了：桌面端不替它拉起，等它（或别人重新启动的 Host）写出 `run/host.json`。 */
  | { phase: 'waiting'; pid: number }
  /** Host 起不来（首次启动失败，或重新拉起都失败了）。 */
  | { phase: 'failed'; error: HostFailure; logPath: string };

/** 进程怎么结束的：退出码，或结束它的信号。 */
export type HostExit = { exitCode: number } | { signal: string };

/**
 * Host 起不来或意外退出的原因（多语言 2026-10-15）：主进程只给原因码与参数，由渲染进程按界面语言说成话
 * （host/host-failure.ts）。`detail` 是原文（Host 的 stderr 尾部、底层错误），不翻译，原样附在后面。
 */
export type HostFailure =
  /** 桌面端正在退出。 */
  (
    | { code: 'quitting' }
    /** 正在重新拉起，端点暂时没有。 */
    | { code: 'restarting' }
    /** 拉起的 Host 在就绪之前结束了。 */
    | { code: 'startFailed'; exit: HostExit }
    /** 拥有的 Host 在就绪之后意外结束了。 */
    | { code: 'crashed'; exit: HostExit }
    /** 运行 Host 的可执行文件起不来（多半不存在）。 */
    | { code: 'spawnFailed'; path: string }
    /** 拉起的 Host 在限时内没有就绪。 */
    | { code: 'notReady'; seconds: number }
    /** 数据目录已被别的 Host 占住，但它在限时内没有就绪。 */
    | { code: 'otherNotReady' }
    /** 重新拉起之前，旧的 Host 进程没有退出。 */
    | { code: 'staleProcess'; pid: number }
    /** `first` 之后重新拉起 `attempts` 次都失败了，最后一次是 `last`。 */
    | { code: 'restartsFailed'; attempts: number; first: HostFailure; last: HostFailure }
    /** `@wevir/host` 的 package.json 里没有 `bin.wevir-host`。 */
    | { code: 'manifestInvalid'; path: string }
    /** Host 的入口不存在（开发时没有 `pnpm build`）。 */
    | { code: 'entryMissing'; path: string }
    /** 其他异常，原文在 `detail`。 */
    | { code: 'internal' }
  ) & { detail?: string };

/**
 * 一条系统通知（U31）：要不要发由渲染进程按通知设置决定，主进程只负责显示、替换与点击。点击时窗口回到前台，`tag` 原样交回
 * 渲染进程（`onNotificationClick`），由它打开对应的会话。
 */
export interface DesktopNotification {
  /** 同一个 tag 的旧通知被这一条替换（同一个会话只留最新的一条）。最长 200 个字符。 */
  tag: string;
  /** 最长 200 个字符。 */
  title: string;
  /** 最长 1000 个字符。 */
  body: string;
  /** 播放系统提示音。 */
  sound: boolean;
}

/** 本机装了的外部编辑器（U32，文件窗格的“打开方式”）。 */
export interface EditorInfo {
  /** 稳定的 ID（`vscode`、`cursor`、`zed`…），存在本机的偏好里。 */
  id: string;
  /** 产品名，不翻译。 */
  name: string;
}

/** 插件页“添加”选哪一种来源（0.42.0）：Windows 与 Linux 的文件对话框选不了文件夹，所以分开。 */
export type InstallSourceKind = 'folder' | 'file';

/**
 * 插件页“添加”的来源是什么（0.42.0，main/plugin-source.ts）。规则同 Host 的 `plugin.install` / `skill.install`：文件夹或
 * ZIP（ZIP 可有一层导出文件夹）的根上有 `wevir-plugin.json`、`.codex-plugin/plugin.json` 或 `.claude-plugin/plugin.json` 的
 * 是插件包，`SKILL.md`、其他文件夹与没有清单的 ZIP 是 Skills。只读，不解压、不复制。
 */
export type InstallSourceInspection =
  /** Wevir 的插件包。`manifest` 是 `wevir-plugin.json` 解析后的 JSON（读不出来、超过 256 KiB 或不是 JSON 时没有），由渲染进程用协议的清单校验。 */
  | { kind: 'plugin'; format: 'wevir'; manifest?: unknown }
  /** Claude / Codex 的插件包，由 Host 导入成 Wevir 插件。 */
  | { kind: 'plugin'; format: 'claude' | 'codex' }
  /** 一个或几个 Skills。 */
  | { kind: 'skill' }
  /** 不是文件夹、ZIP 或 `SKILL.md`。 */
  | { kind: 'unsupported' };

/** 窗口标题栏的形态。macOS 隐藏了系统标题栏，红绿灯浮在页面左上角，由页面的顶栏充当标题栏。 */
export interface WindowChrome {
  /** 红绿灯此刻浮在页面左上角（macOS 且不在全屏）：左上角的顶栏要给它们让出位置。 */
  trafficLights: boolean;
}

/** 更新通道（ADR-0007 补记 2）：正式版只收正式版，开发版也收正式版。 */
export type UpdateChannel = 'stable' | 'dev';

/** macOS 应用菜单（main/app-menu.ts）各项的文字，渲染进程按界面语言送来。 */
export const APP_MENU_LABEL_KEYS = [
  'about',
  'settings',
  'checkForUpdates',
  'services',
  'hide',
  'hideOthers',
  'showAll',
  'quit',
  'file',
  'closeWindow',
  'edit',
  'undo',
  'redo',
  'cut',
  'copy',
  'paste',
  'pasteAndMatchStyle',
  'delete',
  'selectAll',
  'view',
  'reload',
  'forceReload',
  'toggleDevTools',
  'resetZoom',
  'zoomIn',
  'zoomOut',
  'toggleFullScreen',
  'window',
  'minimize',
  'zoom',
  'bringAllToFront',
] as const;

export type AppMenuLabels = Record<(typeof APP_MENU_LABEL_KEYS)[number], string>;

/** 应用菜单要求打开的设置页：设置…打开常规，检查更新…打开关于（更新状态在那里）。 */
export type MenuSettingsTab = 'general' | 'about';

/** 自动更新出错的原因码，由渲染进程说成话；`detail` 是原文。 */
export type UpdateErrorCode =
  /** 所有线路都连不上或没有清单。 */
  | 'unreachable'
  /** 有线路的清单签名对不上（可能被篡改），没有下载。 */
  | 'signature'
  /** 下载或校验安装包失败（两条线路都试过）。 */
  | 'download'
  /** 安装失败（macOS 的 Squirrel、Windows 的安装程序报错）。 */
  | 'install'
  | 'internal';

/**
 * 主进程的自动更新状态（ADR-0007 补记 4）。`disabled` 时界面不显示更新入口：开发构建（不是安装包）、这个安装包没带公钥，
 * 或 macOS 上应用在只读的位置运行（从 dmg 直接打开、被系统转移到临时位置），后者可以移到“应用程序”。
 */
export type UpdatePhase =
  | { phase: 'disabled'; reason: 'development' | 'unsigned' | 'location' }
  | { phase: 'idle' }
  | { phase: 'checking' }
  /** 没有更新。 */
  | { phase: 'latest' }
  | { phase: 'available'; version: string }
  | { phase: 'downloading'; version: string; percent: number; bytesPerSecond: number }
  | { phase: 'downloaded'; version: string }
  | { phase: 'installing'; version: string }
  | { phase: 'error'; code: UpdateErrorCode; detail?: string; version?: string };

export type UpdateState = UpdatePhase & {
  /** 当前版本（`app.getVersion()`）。 */
  currentVersion: string;
  channel: UpdateChannel;
  /** 上次检查完成的时间（ISO 8601）。 */
  lastCheckedAt?: string;
  /** 上次检查或下载用的线路（`global` / `github`）与取清单的用时。 */
  mirror?: { id: string; latencyMs: number };
};

/** 内置浏览器（0.33.0）的标签页由谁操作：agent 开的归 agent；用户开的、用户在里面点过敲过的归用户，agent 只读。 */
export type BrowserController = 'agent' | 'user';

/** 浏览器窗格里内容区的位置（窗口里的 CSS 像素）。 */
export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 一个标签页，给浏览器窗格画标签与地址栏。 */
export interface BrowserTabState {
  id: string;
  /** 开它的会话。 */
  ownerSessionId: string | null;
  url: string;
  title: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  controller: BrowserController;
  /** 谁开的（0.89.0）。 */
  origin: BrowserController;
  /** agent 收尾时标的去向（0.89.0）：交付物，或交还用户接着做。 */
  disposition?: 'deliverable' | 'handoff';
  /** agent 的命令正在这个标签页上执行。 */
  agentBusy: boolean;
  /** 页面打不开（Chromium 的错误码与说明）。 */
  loadError?: { code: number; description: string; url: string };
}

export interface BrowserStatePayload {
  /** 屏幕上的标签页。 */
  activeTabId: string | null;
  /** 每个会话的当前标签页。 */
  activeTabIdByOwner: Record<string, string>;
  visibleSessionId: string | null;
  tabs: BrowserTabState[];
}

/** agent 请界面显示一个标签页（`wevir_show`）：正看着这个会话的窗口打开浏览器窗格。 */
export interface BrowserReveal {
  sessionId: string;
  tabId: string;
}

/** 浏览器窗格的操作（用户）。地址由主进程规范化，不合法时 reject。 */
export interface DesktopBrowserApi {
  /** 执行 Host 交来的一个浏览器请求（渲染进程只是转交）。 */
  execute(request: BrowserRequest): Promise<BrowserResponse>;
  state(): Promise<BrowserStatePayload>;
  onState(listener: (state: BrowserStatePayload) => void): () => void;
  onReveal(listener: (reveal: BrowserReveal) => void): () => void;
  /** 正在看的会话（主会话视图），决定哪些标签页能上屏。 */
  setVisibleSession(sessionId: string | null): Promise<void>;
  /** 窗格可见：把这个会话的当前标签页放到这个位置。 */
  show(bounds: BrowserBounds, sessionId: string): Promise<boolean>;
  hide(): Promise<void>;
  /** 新开标签页（归用户），可以带地址；返回标签页 ID。 */
  open(sessionId: string, address?: string): Promise<string>;
  close(tabId: string): Promise<void>;
  select(tabId: string): Promise<void>;
  navigate(tabId: string, address: string): Promise<void>;
  history(tabId: string, action: 'back' | 'forward' | 'reload' | 'stop'): Promise<void>;
  setController(tabId: string, controller: BrowserController): Promise<void>;
}

/** 渲染进程告诉主进程的窗口外观（setWindowAppearance）。 */
export interface WindowAppearanceInput {
  /** `#rrggbb`。 */
  background: Record<ResolvedTheme, string>;
  translucentSidebar: boolean;
}

export interface DesktopApi {
  /**
   * 当前 Host 的连接信息。首次启动时等 Host 就绪（附着或拉起）；之后每次重读 `run/host.json`，所以 Host 换了
   * 端口与令牌也能拿到新的；client-sdk 每次连接尝试前调用它（ADR-0002 补记 4）。Host 正在重新拉起或起不来时
   * reject。
   */
  getHostConnection(): Promise<HostConnection>;
  /** 主进程看到的 Host 进程状态。 */
  getHostStatus(): Promise<HostProcessStatus>;
  /** 订阅 Host 进程状态的变化，返回取消订阅的函数。 */
  onHostStatus(listener: (status: HostProcessStatus) => void): () => void;
  /** Host 起不来（`failed`）之后手动重试：重新附着或拉起，重试次数清零。其他状态下什么也不做。 */
  retryHost(): Promise<void>;
  /** 系统的文件夹选择对话框；取消时为 null。 */
  selectFolder(): Promise<string | null>;
  /** 选文件与文件夹（多选，U33 输入框的“文件和文件夹”），从 `defaultPath` 开始；取消时是空表。 */
  selectPaths(defaultPath?: string): Promise<string[]>;
  /** 插件页“添加”的文件夹或文件（ZIP、SKILL.md）选择对话框（0.42.0）；取消时为 null。 */
  selectInstallSource(kind: InstallSourceKind): Promise<string | null>;
  /** 判断“添加”的来源是插件包还是 Skills（0.42.0）；路径要是绝对的、存在。 */
  inspectInstallSource(path: string): Promise<InstallSourceInspection>;
  /** 读一个 `SKILL.md` 的文本给 Skills 预览（0.42.0）：只认名为 SKILL.md 的普通文件，最大 512 KiB。 */
  readSkillFile(path: string): Promise<string>;
  /**
   * 拖进页面的文件在本机的路径（Electron 的 `webUtils.getPathForFile`，0.42.0）：插件页的拖放把路径交给 Host 安装。同步取值；
   * 不是磁盘上的文件（网页里拖出来的内容）时是空字符串。
   */
  getPathForFile(file: File): string;
  /** 用系统浏览器打开链接；只接受 http、https、mailto。 */
  openExternal(url: string): Promise<void>;
  /**
   * 把文本写进系统剪贴板（代码块的“复制”等）。渲染进程的权限一律拒绝（T5.1），`navigator.clipboard`
   * 用不了，由主进程代写；只写不读。
   */
  copyText(text: string): Promise<void>;
  /**
   * 让窗口外观跟随界面主题（Electron `nativeTheme.themeSource`）：标题栏、原生控件、窗口底色；也决定
   * 渲染进程里 `prefers-color-scheme` 的取值。界面主题本身由渲染进程的 data-theme 决定（T5.2）。
   */
  setThemeSource(mode: ThemeMode): Promise<void>;
  /**
   * 窗口的底色与半透明侧栏（设置 → 外观）：底色是浅色、深色下的 --background（自定义的背景，没改时是默认值），窗口缩放露出
   * 未绘制的区域时用它；半透明侧栏（macOS）给窗口加上 sidebar 材质（vibrancy）并把窗口底色设成透明，页面里只有侧栏是半透明的。
   * 主进程记下来（连同 setThemeSource 的模式），下次启动时窗口一创建就用上，不闪默认的底色。
   */
  setWindowAppearance(appearance: WindowAppearanceInput): Promise<void>;
  /** 运行时防止系统休眠（设置 → 常规）：有回合在跑且打开了这一项时为 true，系统不会因空闲而睡眠。 */
  setPreventSleep(active: boolean): Promise<void>;
  /** 当前的窗口标题栏形态。同步取值：preload 按平台给出初值，之后跟着主进程的推送更新。 */
  getWindowChrome(): WindowChrome;
  /** 订阅窗口标题栏形态的变化（进出全屏、页面重新加载），返回取消订阅的函数。 */
  onWindowChrome(listener: (chrome: WindowChrome) => void): () => void;
  /** 显示一条系统通知（U31）；系统不支持通知时返回 false。 */
  notify(notification: DesktopNotification): Promise<boolean>;
  /** 收回还在通知中心里的通知：给了 tag 只收回那一条，否则全部。 */
  closeNotifications(tag?: string): Promise<void>;
  /**
   * 菜单栏（macOS）与通知区域（Windows、Linux）图标的菜单文字，按界面语言（main/tray.ts）。窗口关掉后 Wevir 留在后台，
   * 从这个菜单打开或退出。
   */
  setTrayLabels(labels: { open: string; quit: string }): Promise<void>;
  /** macOS 应用菜单的文字，按界面语言（main/app-menu.ts）；其他平台不做事。 */
  setAppMenuLabels(labels: AppMenuLabels): Promise<void>;
  /** 订阅应用菜单的“设置…”与“检查更新…”：主进程已显示窗口，渲染进程跳到对应的设置页。返回取消订阅的函数。 */
  onOpenSettings(listener: (tab: MenuSettingsTab) => void): () => void;
  /** 设置 → 存储：数据目录各类占了多少（shared/storage.ts）。要把整个目录走一遍，大的 worktree 会慢。 */
  getStorageUsage(): Promise<StorageUsage>;
  /** 清理所选的几类（缓存、内置浏览器的数据、日志），返回清完之后重新量的结果。 */
  cleanStorage(categories: CleanableCategory[]): Promise<StorageUsage>;
  /** 程序坞（macOS）与任务栏（Linux Unity）上的角标数字，0 清除。 */
  setBadgeCount(count: number): Promise<void>;
  /** 订阅系统通知的点击，交回通知的 tag；返回取消订阅的函数。 */
  onNotificationClick(listener: (tag: string) => void): () => void;
  /** 订阅锁屏与睡眠（true）、解锁与唤醒（false）：渲染进程据此报在场（0.104.0）。返回取消订阅的函数。 */
  onScreenLock(listener: (locked: boolean) => void): () => void;
  /** 本机装了的外部编辑器（U32）。 */
  listEditors(): Promise<EditorInfo[]>;
  /** 用外部编辑器打开文件或文件夹（绝对路径），可跳到行。 */
  openInEditor(editorId: string, path: string, line?: number): Promise<void>;
  /** 在访达（资源管理器、文件管理器）中显示（绝对路径）。 */
  revealPath(path: string): Promise<void>;
  /**
   * 用系统预览看一个文件（0.32.0，文件窗格的 Office 文件等）：macOS 是 Quick Look（`BrowserWindow.previewFile`），其他平台
   * 返回 false，由调用方改用 `openPath`。只认文档与媒体的扩展名（shared/open-path.ts）。
   */
  previewFile(path: string): Promise<boolean>;
  /** 用系统的默认应用打开一个文件（`shell.openPath`）。只认文档与媒体的扩展名，不打开可执行文件。 */
  openPath(path: string): Promise<void>;
  /**
   * 另存为（0.40.0，agent 交给用户的文件）：弹出保存对话框（默认在“下载”里、用 `name`），把文件（绝对路径）复制过去。用户取消时
   * 是 `cancelled`。
   */
  saveFileAs(path: string, name: string): Promise<'saved' | 'cancelled'>;
  /**
   * 把一段文本另存为（0.76.0，任务回顾的导出）：弹出保存对话框（默认在“下载”里、用 `name`），写入 `text`（UTF-8）。只认 `.md` 与
   * `.json`；用户取消时是 `cancelled`。
   */
  saveTextAs(name: string, text: string): Promise<'saved' | 'cancelled'>;
  /** 自动更新的状态（ADR-0007 补记 4）。 */
  getUpdateState(): Promise<UpdateState>;
  /** 订阅自动更新状态的变化，返回取消订阅的函数。 */
  onUpdateState(listener: (state: UpdateState) => void): () => void;
  /** 立即检查更新（设置 → 关于的“检查更新”）。 */
  checkForUpdates(): Promise<void>;
  /** 下载已发现的新版本。 */
  downloadUpdate(): Promise<void>;
  /** 退出、安装下载好的新版本并重新打开。没有回合在跑时由渲染进程在下载完后自动调用，否则等用户点。 */
  installUpdate(): Promise<void>;
  /** 换更新通道，换完立即检查一次。 */
  setUpdateChannel(channel: UpdateChannel): Promise<void>;
  /** 把应用移到“应用程序”文件夹并重新打开（macOS，`disabled` 的 `location`）。 */
  moveToApplications(): Promise<void>;
  /** 内置浏览器（0.33.0）。 */
  browser: DesktopBrowserApi;
}

export const IPC_CHANNELS = {
  getHostConnection: 'wevir:get-host-connection',
  getHostStatus: 'wevir:get-host-status',
  /** 主进程 → 渲染进程的推送。 */
  hostStatus: 'wevir:host-status',
  retryHost: 'wevir:retry-host',
  selectFolder: 'wevir:select-folder',
  selectPaths: 'wevir:select-paths',
  selectInstallSource: 'wevir:select-install-source',
  inspectInstallSource: 'wevir:inspect-install-source',
  readSkillFile: 'wevir:read-skill-file',
  openExternal: 'wevir:open-external',
  copyText: 'wevir:copy-text',
  setThemeSource: 'wevir:set-theme-source',
  setWindowAppearance: 'wevir:set-window-appearance',
  setPreventSleep: 'wevir:set-prevent-sleep',
  /** 主进程 → 渲染进程的推送。 */
  windowChrome: 'wevir:window-chrome',
  notify: 'wevir:notify',
  closeNotifications: 'wevir:close-notifications',
  setBadgeCount: 'wevir:set-badge-count',
  /** 主进程 → 渲染进程的推送。 */
  notificationClick: 'wevir:notification-click',
  /** 主进程 → 渲染进程的推送。 */
  screenLock: 'wevir:screen-lock',
  listEditors: 'wevir:list-editors',
  openInEditor: 'wevir:open-in-editor',
  revealPath: 'wevir:reveal-path',
  previewFile: 'wevir:preview-file',
  openPath: 'wevir:open-path',
  saveFileAs: 'wevir:save-file-as',
  saveTextAs: 'wevir:save-text-as',
  getUpdateState: 'wevir:get-update-state',
  /** 主进程 → 渲染进程的推送。 */
  updateState: 'wevir:update-state',
  checkForUpdates: 'wevir:check-for-updates',
  downloadUpdate: 'wevir:download-update',
  installUpdate: 'wevir:install-update',
  setUpdateChannel: 'wevir:set-update-channel',
  moveToApplications: 'wevir:move-to-applications',
  setTrayLabels: 'wevir:set-tray-labels',
  setAppMenuLabels: 'wevir:set-app-menu-labels',
  /** 主进程 → 渲染进程的推送。 */
  openSettings: 'wevir:open-settings',
  getStorageUsage: 'wevir:get-storage-usage',
  cleanStorage: 'wevir:clean-storage',
  browserExecute: 'wevir:browser-execute',
  browserGetState: 'wevir:browser-get-state',
  /** 主进程 → 渲染进程的推送。 */
  browserState: 'wevir:browser-state',
  /** 主进程 → 渲染进程的推送。 */
  browserReveal: 'wevir:browser-reveal',
  browserSetVisibleSession: 'wevir:browser-set-visible-session',
  browserShow: 'wevir:browser-show',
  browserHide: 'wevir:browser-hide',
  browserOpen: 'wevir:browser-open',
  browserClose: 'wevir:browser-close',
  browserSelect: 'wevir:browser-select',
  browserNavigate: 'wevir:browser-navigate',
  browserHistory: 'wevir:browser-history',
  browserSetController: 'wevir:browser-set-controller',
} as const;

/** `DesktopNotification` 各字段的长度上限，主进程按它校验。 */
export const NOTIFICATION_LIMITS = { tag: 200, title: 200, body: 1000 } as const;

/** 插件页读文件的上限（0.42.0，main/plugin-source.ts 按它校验）。 */
export const INSTALL_SOURCE_LIMITS = { manifestBytes: 256 * 1024, skillBytes: 512 * 1024 } as const;
