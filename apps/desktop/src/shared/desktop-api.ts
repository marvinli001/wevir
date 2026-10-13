// preload 经 contextBridge 交给渲染进程的接口（`window.wevir`），以及它背后的 IPC 通道。只有类型和
// 通道名，渲染进程、preload、主进程共用；不 import Node 或 Electron 的东西。

import type { ClientIdentity } from '@wevir/protocol';

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
}

export const IPC_CHANNELS = {
  getHostConnection: 'wevir:get-host-connection',
  selectFolder: 'wevir:select-folder',
  openExternal: 'wevir:open-external',
} as const;
