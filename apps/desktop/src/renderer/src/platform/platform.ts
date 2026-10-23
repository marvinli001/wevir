// 渲染进程跑在什么外壳里：Electron 桌面端（preload 的 `window.wevir`），或别的外壳（浏览器客户端）。界面只经这里调外壳的接口、
// 按能力位决定显示什么；外壳没有的功能隐藏或只读，不在点了之后才失败。桌面端不装任何东西，一切照旧走 `window.wevir`。

import { type HostEndpoint, type TransportFactory, webSocketTransport } from '@wevir/client-sdk';
import type { ClientIdentity } from '@wevir/protocol';
import type { ReactNode } from 'react';
import type { DesktopApi, HostProcessStatus } from '../../../shared/desktop-api.js';

/** 外壳能做的事。桌面端全部为 true。 */
export interface PlatformCapabilities {
  /** Host 在这台电脑上、由外壳管着：Host 进程状态与重试、数据目录的存储页。 */
  localHost: boolean;
  /**
   * 路径指的是这台电脑上的文件：在访达里显示、用系统应用或编辑器打开、文件选择框、拖放取路径、插件来源、本机文件另存为。连着别的电脑
   * 上的 Host 时没有。
   */
  localFiles: boolean;
  /** 内置浏览器窗格（0.33.0）。 */
  browserPane: boolean;
  /** 电脑操作（0.114.0）。 */
  computerUse: boolean;
  /** 应用自己的更新。 */
  updates: boolean;
  /** 防休眠由外壳执行。 */
  preventSleep: boolean;
  /** 系统通知。 */
  notifications: boolean;
  /** 把文本存成文件（另存为、下载）。 */
  saveText: boolean;
}

export const DESKTOP_CAPABILITIES: PlatformCapabilities = Object.freeze({
  localHost: true,
  localFiles: true,
  browserPane: true,
  computerUse: true,
  updates: true,
  preventSleep: true,
  notifications: true,
  saveText: true,
});

/** 连 Host 要的东西：身份、端点与传输。每次（重新）建立连接前取一次。 */
export interface HostConnectionTarget {
  identity: ClientIdentity;
  endpoint: HostEndpoint | (() => Promise<HostEndpoint>);
  transport: TransportFactory;
}

/**
 * Host 连接从哪来。桌面端问主进程要本机 Host 的端点，并转达主进程看到的 Host 进程状态；浏览器客户端给出经中继的远程传输，没有
 * 进程状态。
 */
export interface HostConnectionSource {
  open(): Promise<HostConnectionTarget>;
  /** 外壳看到的 Host 进程状态（只有管着本机 Host 的外壳有）。 */
  getHostStatus?(): Promise<HostProcessStatus>;
  onHostStatus?(listener: (status: HostProcessStatus) => void): () => void;
  /** Host 起不来之后手动重试。 */
  retryHost?(): Promise<void>;
}

/** 外壳往界面里放的东西。 */
export interface PlatformSlots {
  /** 左栏底部、设置上面（浏览器客户端放“切换电脑”）。 */
  sidebarFooter?(): ReactNode;
}

export interface Platform {
  /** 外壳的接口，形状同桌面端的 `window.wevir`；做不到的方法由 `unsupportedPlatformApi` 补上。 */
  readonly api: DesktopApi;
  readonly capabilities: PlatformCapabilities;
  readonly connection: HostConnectionSource;
  readonly slots?: PlatformSlots;
}

let installed: Platform | undefined;

/** 非 Electron 的外壳在渲染之前装上自己的实现。只装一次。 */
export function installPlatform(platform: Platform): void {
  if (installed !== undefined) throw new Error('platform is already installed');
  installed = platform;
}

/** 外壳的接口：装了别的外壳就是它的，否则是 preload 的 `window.wevir`（测试里可能没有）。 */
export function platformApi(): DesktopApi {
  return installed?.api ?? window.wevir;
}

export function capabilities(): PlatformCapabilities {
  return installed?.capabilities ?? DESKTOP_CAPABILITIES;
}

export function platformSlots(): PlatformSlots {
  return installed?.slots ?? {};
}

/** 桌面端的连接：每次连接尝试前向主进程要端点（令牌只在内存里），Host 进程状态由主进程推来。 */
const desktopConnection: HostConnectionSource = {
  async open() {
    const { identity } = await window.wevir.getHostConnection();
    return {
      identity,
      endpoint: async () => {
        const { url, token } = await window.wevir.getHostConnection();
        return { url, token };
      },
      transport: webSocketTransport(WebSocket),
    };
  },
  getHostStatus: () => window.wevir.getHostStatus(),
  onHostStatus: (listener) => window.wevir.onHostStatus(listener),
  retryHost: () => window.wevir.retryHost(),
};

export function hostConnectionSource(): HostConnectionSource {
  return installed?.connection ?? desktopConnection;
}

const unsupported = (): Promise<never> => Promise.reject(new Error('not available here'));
const resolved = (): Promise<void> => Promise.resolve();
const noListener = () => () => {};

/**
 * 什么都做不了的外壳接口：读状态的给出“没有”，只是通知外壳的什么也不做，要外壳去做事的 reject。别的外壳在它上面换掉自己能做的。
 * 界面按 `capabilities()` 隐藏做不了的入口，所以这些 reject 只在漏网时出现。
 */
export function unsupportedPlatformApi(overrides: Partial<DesktopApi> = {}): DesktopApi {
  return {
    getHostConnection: unsupported,
    getHostStatus: unsupported,
    onHostStatus: noListener,
    retryHost: resolved,
    selectFolder: () => Promise.resolve(null),
    selectPaths: () => Promise.resolve([]),
    selectInstallSource: () => Promise.resolve(null),
    inspectInstallSource: () => Promise.resolve({ kind: 'unsupported' }),
    readSkillFile: unsupported,
    getPathForFile: () => '',
    openExternal: unsupported,
    copyText: unsupported,
    setThemeSource: resolved,
    setWindowAppearance: resolved,
    setPreventSleep: resolved,
    getWindowChrome: () => ({ trafficLights: false, material: false }),
    onWindowChrome: noListener,
    notify: () => Promise.resolve(false),
    closeNotifications: resolved,
    setBadgeCount: resolved,
    setTrayLabels: resolved,
    setAppMenuLabels: resolved,
    onOpenSettings: noListener,
    getStorageUsage: unsupported,
    cleanStorage: unsupported,
    onNotificationClick: noListener,
    onScreenLock: noListener,
    listEditors: () => Promise.resolve([]),
    openInEditor: unsupported,
    revealPath: unsupported,
    previewFile: unsupported,
    openPath: unsupported,
    saveFileAs: unsupported,
    saveTextAs: unsupported,
    getUpdateState: unsupported,
    onUpdateState: noListener,
    checkForUpdates: resolved,
    downloadUpdate: resolved,
    installUpdate: resolved,
    setUpdateChannel: resolved,
    moveToApplications: unsupported,
    browser: {
      execute: unsupported,
      state: unsupported,
      onState: noListener,
      onReveal: noListener,
      setVisibleSession: resolved,
      show: () => Promise.resolve(false),
      hide: resolved,
      open: unsupported,
      close: resolved,
      select: resolved,
      navigate: resolved,
      history: resolved,
      setController: resolved,
    },
    computer: {
      execute: unsupported,
      prepareAccess: unsupported,
      grant: unsupported,
      status: () => Promise.resolve({ supported: false, reason: 'platform' }),
      requestPermission: () => Promise.resolve({ supported: false, reason: 'platform' }),
      setActiveSessions: resolved,
      setOverlayLabel: resolved,
      appIcon: () => Promise.resolve(null),
      onStopped: noListener,
    },
    ...overrides,
  };
}
