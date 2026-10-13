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

export interface DesktopApi {
  /**
   * 当前 Host 的连接信息。主进程等 Host 就绪（附着或拉起）后每次重读 `run/host.json`，所以 Host 换了
   * 端口与令牌也能拿到新的；client-sdk 每次连接尝试前调用它（ADR-0002 补记 4）。Host 不可用时 reject。
   */
  getHostConnection(): Promise<HostConnection>;
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
  selectFolder: 'wevir:select-folder',
  openExternal: 'wevir:open-external',
  copyText: 'wevir:copy-text',
  setThemeSource: 'wevir:set-theme-source',
} as const;
