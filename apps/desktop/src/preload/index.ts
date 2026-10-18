// preload（T5.1）：只经 contextBridge 暴露 `window.wevir` 的几个方法，不把 ipcRenderer 或任何 Node / Electron
// 对象交给页面（Electron 安全清单第 3、20 条）。渲染进程开着 sandbox，这个文件由 electron-vite 打成单个
// CJS 文件（沙箱里的 preload 不能是 ESM），只能 import `electron`。

import { contextBridge, type IpcRendererEvent, ipcRenderer, webUtils } from 'electron';
import {
  type BrowserReveal,
  type BrowserStatePayload,
  type DesktopApi,
  type HostProcessStatus,
  IPC_CHANNELS,
  type MenuSettingsTab,
  type UpdateState,
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
  selectPaths: (defaultPath) => ipcRenderer.invoke(IPC_CHANNELS.selectPaths, defaultPath),
  selectInstallSource: (kind) => ipcRenderer.invoke(IPC_CHANNELS.selectInstallSource, kind),
  inspectInstallSource: (path) => ipcRenderer.invoke(IPC_CHANNELS.inspectInstallSource, path),
  readSkillFile: (path) => ipcRenderer.invoke(IPC_CHANNELS.readSkillFile, path),
  // 拖放取路径：File 对象过 contextBridge，由 preload 里的 webUtils 换成本机路径。
  getPathForFile: (file) => webUtils.getPathForFile(file),
  openExternal: (url) => ipcRenderer.invoke(IPC_CHANNELS.openExternal, url),
  copyText: (text) => ipcRenderer.invoke(IPC_CHANNELS.copyText, text),
  setThemeSource: (mode) => ipcRenderer.invoke(IPC_CHANNELS.setThemeSource, mode),
  setWindowAppearance: (appearance) =>
    ipcRenderer.invoke(IPC_CHANNELS.setWindowAppearance, appearance),
  setPreventSleep: (active) => ipcRenderer.invoke(IPC_CHANNELS.setPreventSleep, active),
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
  setTrayLabels: (labels) => ipcRenderer.invoke(IPC_CHANNELS.setTrayLabels, labels),
  setAppMenuLabels: (labels) => ipcRenderer.invoke(IPC_CHANNELS.setAppMenuLabels, labels),
  onOpenSettings: (listener) => {
    const handler = (_event: IpcRendererEvent, tab: MenuSettingsTab) => listener(tab);
    ipcRenderer.on(IPC_CHANNELS.openSettings, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.openSettings, handler);
    };
  },
  getStorageUsage: () => ipcRenderer.invoke(IPC_CHANNELS.getStorageUsage),
  cleanStorage: (categories) => ipcRenderer.invoke(IPC_CHANNELS.cleanStorage, categories),
  onNotificationClick: (listener) => {
    const handler = (_event: IpcRendererEvent, tag: string) => listener(tag);
    ipcRenderer.on(IPC_CHANNELS.notificationClick, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.notificationClick, handler);
    };
  },
  listEditors: () => ipcRenderer.invoke(IPC_CHANNELS.listEditors),
  openInEditor: (editorId, path, line) =>
    ipcRenderer.invoke(IPC_CHANNELS.openInEditor, editorId, path, line),
  revealPath: (path) => ipcRenderer.invoke(IPC_CHANNELS.revealPath, path),
  previewFile: (path) => ipcRenderer.invoke(IPC_CHANNELS.previewFile, path),
  openPath: (path) => ipcRenderer.invoke(IPC_CHANNELS.openPath, path),
  saveFileAs: (path, name) => ipcRenderer.invoke(IPC_CHANNELS.saveFileAs, path, name),
  getUpdateState: () => ipcRenderer.invoke(IPC_CHANNELS.getUpdateState),
  onUpdateState: (listener) => {
    const handler = (_event: IpcRendererEvent, state: UpdateState) => listener(state);
    ipcRenderer.on(IPC_CHANNELS.updateState, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.updateState, handler);
    };
  },
  checkForUpdates: () => ipcRenderer.invoke(IPC_CHANNELS.checkForUpdates),
  downloadUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.downloadUpdate),
  installUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.installUpdate),
  setUpdateChannel: (channel) => ipcRenderer.invoke(IPC_CHANNELS.setUpdateChannel, channel),
  moveToApplications: () => ipcRenderer.invoke(IPC_CHANNELS.moveToApplications),
  browser: {
    execute: (request) => ipcRenderer.invoke(IPC_CHANNELS.browserExecute, request),
    state: () => ipcRenderer.invoke(IPC_CHANNELS.browserGetState),
    onState: (listener) => {
      const handler = (_event: IpcRendererEvent, state: BrowserStatePayload) => listener(state);
      ipcRenderer.on(IPC_CHANNELS.browserState, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.browserState, handler);
      };
    },
    onReveal: (listener) => {
      const handler = (_event: IpcRendererEvent, reveal: BrowserReveal) => listener(reveal);
      ipcRenderer.on(IPC_CHANNELS.browserReveal, handler);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.browserReveal, handler);
      };
    },
    setVisibleSession: (sessionId) =>
      ipcRenderer.invoke(IPC_CHANNELS.browserSetVisibleSession, sessionId),
    show: (bounds, sessionId) => ipcRenderer.invoke(IPC_CHANNELS.browserShow, bounds, sessionId),
    hide: () => ipcRenderer.invoke(IPC_CHANNELS.browserHide),
    open: (sessionId, address) => ipcRenderer.invoke(IPC_CHANNELS.browserOpen, sessionId, address),
    close: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.browserClose, tabId),
    select: (tabId) => ipcRenderer.invoke(IPC_CHANNELS.browserSelect, tabId),
    navigate: (tabId, address) => ipcRenderer.invoke(IPC_CHANNELS.browserNavigate, tabId, address),
    history: (tabId, action) => ipcRenderer.invoke(IPC_CHANNELS.browserHistory, tabId, action),
    setController: (tabId, controller) =>
      ipcRenderer.invoke(IPC_CHANNELS.browserSetController, tabId, controller),
  },
};

contextBridge.exposeInMainWorld('wevir', api);
