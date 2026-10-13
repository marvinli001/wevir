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
  | { phase: 'restarting'; attempt: number; maxAttempts: number; reason: string }
  /** 附着的 Host 不在了：桌面端不替它拉起，等它（或别人重新启动的 Host）写出 `run/host.json`。 */
  | { phase: 'waiting'; pid: number }
  /** Host 起不来（首次启动失败，或重新拉起都失败了）：`error` 是给人看的中文说明。 */
  | { phase: 'failed'; error: string; logPath: string };

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
}

export const IPC_CHANNELS = {
  getHostConnection: 'wevir:get-host-connection',
  getHostStatus: 'wevir:get-host-status',
  /** 主进程 → 渲染进程的推送。 */
  hostStatus: 'wevir:host-status',
  retryHost: 'wevir:retry-host',
  selectFolder: 'wevir:select-folder',
  openExternal: 'wevir:open-external',
  copyText: 'wevir:copy-text',
  setThemeSource: 'wevir:set-theme-source',
} as const;
