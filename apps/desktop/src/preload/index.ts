// preload（T5.1）：只经 contextBridge 暴露 `window.wevir` 的几个方法，不把 ipcRenderer 或任何 Node / Electron
// 对象交给页面（Electron 安全清单第 3、20 条）。渲染进程开着 sandbox，这个文件由 electron-vite 打成单个
// CJS 文件（沙箱里的 preload 不能是 ESM），只能 import `electron`。

import { contextBridge, type IpcRendererEvent, ipcRenderer } from 'electron';
import { type DesktopApi, type HostProcessStatus, IPC_CHANNELS } from '../shared/desktop-api.js';

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
};

contextBridge.exposeInMainWorld('wevir', api);
