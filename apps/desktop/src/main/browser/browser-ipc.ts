// 内置浏览器（0.33.0）给 preload 的 IPC：只接受主窗口主框架的调用（同 index.ts 的 assertSender），参数逐个校验；地址在
// 这里规范化（url-policy.ts），渲染进程交来什么都不直接 loadURL。

import { type BrowserWindow, type IpcMainInvokeEvent, ipcMain } from 'electron';
import {
  type BrowserBounds,
  type BrowserController,
  IPC_CHANNELS,
} from '../../shared/desktop-api.js';
import { type BrowserHost, createBrowserHost } from './browser-host.js';
import { addressToUrl } from './url-policy.js';

export interface BrowserIpcOptions {
  getWindow(): BrowserWindow | undefined;
  assertSender(event: IpcMainInvokeEvent): BrowserWindow;
  log(level: 'info' | 'warn' | 'error', message: string, detail?: Record<string, unknown>): void;
}

const SESSION_ID = /^ses_[0-9A-Za-z]{1,64}$/;
const TAB_ID = /^[0-9A-Za-z_-]{1,64}$/;

function sessionId(value: unknown): string {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) throw new Error('invalid session id');
  return value;
}

function tabId(value: unknown): string {
  if (typeof value !== 'string' || !TAB_ID.test(value)) throw new Error('invalid tab id');
  return value;
}

function bounds(value: unknown): BrowserBounds {
  const record = value as Record<string, unknown> | null;
  const keys = ['x', 'y', 'width', 'height'] as const;
  if (
    record === null ||
    typeof record !== 'object' ||
    !keys.every((key) => typeof record[key] === 'number' && Number.isFinite(record[key]))
  ) {
    throw new Error('invalid bounds');
  }
  return {
    x: record.x as number,
    y: record.y as number,
    width: record.width as number,
    height: record.height as number,
  };
}

function address(value: unknown): string {
  const url = typeof value === 'string' ? addressToUrl(value) : undefined;
  if (url === undefined) throw new Error('only http and https addresses can be opened');
  return url;
}

export function registerBrowserIpc(options: BrowserIpcOptions): BrowserHost {
  const send = (channel: string, payload: unknown) => {
    const window = options.getWindow();
    if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
    try {
      window.webContents.send(channel, payload);
    } catch {
      // 窗口正在关
    }
  };
  const host = createBrowserHost({
    getWindow: options.getWindow,
    sendState: (state) => send(IPC_CHANNELS.browserState, state),
    sendReveal: (reveal) => send(IPC_CHANNELS.browserReveal, reveal),
    log: options.log,
  });

  const handle = (channel: string, listener: (...args: unknown[]) => unknown) =>
    ipcMain.handle(channel, (event, ...args) => {
      options.assertSender(event);
      return listener(...args);
    });

  handle(IPC_CHANNELS.browserExecute, (request) => host.execute(request));
  handle(IPC_CHANNELS.browserGetState, () => host.state());
  handle(IPC_CHANNELS.browserSetVisibleSession, (id) => {
    host.setVisibleSession(id === null ? null : sessionId(id));
  });
  handle(IPC_CHANNELS.browserShow, (rect, id) => host.showPane(bounds(rect), sessionId(id)));
  handle(IPC_CHANNELS.browserHide, () => host.hidePane());
  handle(IPC_CHANNELS.browserOpen, (id, value) =>
    host.openForUser(
      sessionId(id),
      value === undefined || value === '' ? undefined : address(value),
    ),
  );
  handle(IPC_CHANNELS.browserClose, (id) => host.closeTab(tabId(id)));
  handle(IPC_CHANNELS.browserSelect, (id) => host.selectTab(tabId(id)));
  handle(IPC_CHANNELS.browserNavigate, (id, value) =>
    host.navigateForUser(tabId(id), address(value)),
  );
  handle(IPC_CHANNELS.browserHistory, (id, action) => {
    if (action !== 'back' && action !== 'forward' && action !== 'reload' && action !== 'stop') {
      throw new Error('unknown history action');
    }
    host.historyForUser(tabId(id), action);
  });
  handle(IPC_CHANNELS.browserSetController, (id, controller) => {
    if (controller !== 'agent' && controller !== 'user') throw new Error('unknown controller');
    host.setController(tabId(id), controller as BrowserController);
  });
  return host;
}
