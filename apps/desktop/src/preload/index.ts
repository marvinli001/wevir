// preload（T5.1）：只经 contextBridge 暴露 `window.wevir` 的几个方法，不把 ipcRenderer 或任何 Node / Electron
// 对象交给页面（Electron 安全清单第 3、20 条）。渲染进程开着 sandbox，这个文件由 electron-vite 打成单个
// CJS 文件（沙箱里的 preload 不能是 ESM），只能 import `electron`。

import { contextBridge, type IpcRendererEvent, ipcRenderer } from 'electron';
import {
  type DesktopApi,
  type HostProcessStatus,
  IPC_CHANNELS,
  type WindowChrome,
} from '../shared/desktop-api.js';

// 窗口标题栏的形态要在首帧前就能同步读到（顶栏的左边距），所以按平台给出初值（窗口创建时不在全屏），之后由
// 主进程在进出全屏、页面加载完成时推送。沙箱里的 preload 也有 process.platform。
let windowChrome: WindowChrome = { trafficLights: process.platform === 'darwin' };
const windowChromeListeners = new Set<(chrome: WindowChrome) => void>();
ipcRenderer.on(IPC_CHANNELS.windowChrome, (_event: IpcRendererEvent, chrome: WindowChrome) => {
  windowChrome = chrome;
  for (const listener of windowChromeListeners) listener(chrome);
});

const api: DesktopApi = {
  getHostConnection: () => ipcRenderer.invoke(IPC_CHANNELS.getHostConnection),
  getHostStatus: () => ipcRenderer.invoke(IPC_CHANNELS.getHostStatus),
  onHostStatus: (listener) => {
    // 只把状态对象交给页面，不交出 IpcRendererEvent（它带着 sender）。
    const handler = (_event: IpcRendererEvent, status: HostProcessStatus) => listener(status);
    ipcRenderer.on(IPC_CHANNELS.hostStatus, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.hostStatus, handler);
    };
  },
  retryHost: () => ipcRenderer.invoke(IPC_CHANNELS.retryHost),
  selectFolder: () => ipcRenderer.invoke(IPC_CHANNELS.selectFolder),
  openExternal: (url) => ipcRenderer.invoke(IPC_CHANNELS.openExternal, url),
  copyText: (text) => ipcRenderer.invoke(IPC_CHANNELS.copyText, text),
  setThemeSource: (mode) => ipcRenderer.invoke(IPC_CHANNELS.setThemeSource, mode),
  getWindowChrome: () => windowChrome,
  onWindowChrome: (listener) => {
    windowChromeListeners.add(listener);
    return () => {
      windowChromeListeners.delete(listener);
    };
  },
  notify: (notification) => ipcRenderer.invoke(IPC_CHANNELS.notify, notification),
  closeNotifications: (tag) => ipcRenderer.invoke(IPC_CHANNELS.closeNotifications, tag),
  setBadgeCount: (count) => ipcRenderer.invoke(IPC_CHANNELS.setBadgeCount, count),
  onNotificationClick: (listener) => {
    const handler = (_event: IpcRendererEvent, tag: string) => listener(tag);
    ipcRenderer.on(IPC_CHANNELS.notificationClick, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.notificationClick, handler);
    };
  },
};

contextBridge.exposeInMainWorld('wevir', api);
