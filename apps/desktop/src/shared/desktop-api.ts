// preload 经 contextBridge 交给渲染进程的接口（`window.wevir`），以及它背后的 IPC 通道。只有类型和
// 通道名，渲染进程、preload、主进程共用；不 import Node 或 Electron 的东西。

import type { ClientIdentity } from '@wevir/protocol';
import type { ThemeMode } from './theme.js';

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

/** 窗口标题栏的形态。macOS 隐藏了系统标题栏，红绿灯浮在页面左上角，由页面的顶栏充当标题栏。 */
export interface WindowChrome {
  /** 红绿灯此刻浮在页面左上角（macOS 且不在全屏）：左上角的顶栏要给它们让出位置。 */
  trafficLights: boolean;
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
  /** 当前的窗口标题栏形态。同步取值：preload 按平台给出初值，之后跟着主进程的推送更新。 */
  getWindowChrome(): WindowChrome;
  /** 订阅窗口标题栏形态的变化（进出全屏、页面重新加载），返回取消订阅的函数。 */
  onWindowChrome(listener: (chrome: WindowChrome) => void): () => void;
  /** 显示一条系统通知（U31）；系统不支持通知时返回 false。 */
  notify(notification: DesktopNotification): Promise<boolean>;
  /** 收回还在通知中心里的通知：给了 tag 只收回那一条，否则全部。 */
  closeNotifications(tag?: string): Promise<void>;
  /** 程序坞（macOS）与任务栏（Linux Unity）上的角标数字，0 清除。 */
  setBadgeCount(count: number): Promise<void>;
  /** 订阅系统通知的点击，交回通知的 tag；返回取消订阅的函数。 */
  onNotificationClick(listener: (tag: string) => void): () => void;
  /** 本机装了的外部编辑器（U32）。 */
  listEditors(): Promise<EditorInfo[]>;
  /** 用外部编辑器打开文件或文件夹（绝对路径），可跳到行。 */
  openInEditor(editorId: string, path: string, line?: number): Promise<void>;
  /** 在访达（资源管理器、文件管理器）中显示（绝对路径）。 */
  revealPath(path: string): Promise<void>;
}

export const IPC_CHANNELS = {
  getHostConnection: 'wevir:get-host-connection',
  getHostStatus: 'wevir:get-host-status',
  /** 主进程 → 渲染进程的推送。 */
  hostStatus: 'wevir:host-status',
  retryHost: 'wevir:retry-host',
  selectFolder: 'wevir:select-folder',
  selectPaths: 'wevir:select-paths',
  openExternal: 'wevir:open-external',
  copyText: 'wevir:copy-text',
  setThemeSource: 'wevir:set-theme-source',
  /** 主进程 → 渲染进程的推送。 */
  windowChrome: 'wevir:window-chrome',
  notify: 'wevir:notify',
  closeNotifications: 'wevir:close-notifications',
  setBadgeCount: 'wevir:set-badge-count',
  /** 主进程 → 渲染进程的推送。 */
  notificationClick: 'wevir:notification-click',
  listEditors: 'wevir:list-editors',
  openInEditor: 'wevir:open-in-editor',
  revealPath: 'wevir:reveal-path',
} as const;

/** `DesktopNotification` 各字段的长度上限，主进程按它校验。 */
export const NOTIFICATION_LIMITS = { tag: 200, title: 200, body: 1000 } as const;
