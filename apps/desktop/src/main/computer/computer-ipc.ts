// 电脑操作（0.114.0）给 preload 的 IPC：只接受主窗口主框架的调用（同 index.ts 的 assertSender），参数逐个校验；Host 交来的
// 请求按协议的 schema 再解析一遍。授权框由渲染进程画，档位与能批准哪些应用由这里（service.ts）定。

import { existsSync } from 'node:fs';
import { ComputerRequestSchema } from '@wevir/protocol';
import { app, type BrowserWindow, type IpcMainInvokeEvent, ipcMain, shell } from 'electron';
import { IPC_CHANNELS } from '../../shared/desktop-api.js';
import type { Log } from '../host-lifecycle.js';
import { ComputerHelper, HelperError, resolveHelperBinary } from './helper.js';
import { createComputerOverlay } from './overlay.js';
import { ComputerService } from './service.js';

export interface ComputerIpcOptions {
  getWindow(): BrowserWindow | undefined;
  assertSender(event: IpcMainInvokeEvent): BrowserWindow;
  log: Log;
}

const SESSION_ID = /^ses_[0-9A-Za-z]{1,64}$/;
const SETTINGS_PANES = {
  screen_recording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
} as const;

function sessionId(value: unknown): string {
  if (typeof value !== 'string' || !SESSION_ID.test(value)) throw new Error('invalid session id');
  return value;
}

function strings(value: unknown, max: number, limit = 200): string[] {
  if (!Array.isArray(value) || value.length > max) throw new Error('invalid list');
  return value.map((item) => {
    if (typeof item !== 'string' || item.length === 0 || item.length > limit) {
      throw new Error('invalid list item');
    }
    return item;
  });
}

export function registerComputerIpc(options: ComputerIpcOptions): { dispose(): void } {
  const binary = () =>
    resolveHelperBinary({ packaged: app.isPackaged, resourcesPath: process.resourcesPath });
  const helper = new ComputerHelper({ binary, log: options.log });
  const overlay = createComputerOverlay('Wevir is using your computer · Esc to stop');
  const service = new ComputerService({
    helper,
    overlay,
    hasHelper: () => binary() !== undefined,
    onStopped: (sessionIds) => {
      const window = options.getWindow();
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return;
      window.webContents.send(IPC_CHANNELS.computerStopped, sessionIds);
    },
  });

  const handle = (channel: string, listener: (...args: unknown[]) => unknown) =>
    ipcMain.handle(channel, (event, ...args) => {
      options.assertSender(event);
      return listener(...args);
    });

  handle(IPC_CHANNELS.computerExecute, (raw) => {
    const parsed = ComputerRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          code: 'computer_invalid_argument',
          message: 'The request does not match its schema.',
        },
      };
    }
    return service.execute(parsed.data);
  });
  handle(IPC_CHANNELS.computerPrepareAccess, async (id, apps, reason) => {
    if (typeof reason !== 'string' || reason.length > 500) throw new Error('invalid reason');
    try {
      return await service.prepareAccess(sessionId(id), strings(apps, 10), reason);
    } catch (error) {
      if (error instanceof HelperError)
        return { error: { code: error.code, message: error.message } };
      throw error;
    }
  });
  handle(IPC_CHANNELS.computerGrant, (accessId, bundleIds) => {
    if (typeof accessId !== 'string') throw new Error('invalid access id');
    return service.grant(accessId, strings(bundleIds, 10, 300));
  });
  handle(IPC_CHANNELS.computerStatus, () => service.status());
  handle(IPC_CHANNELS.computerRequestPermission, async (kind) => {
    if (kind !== 'screen_recording' && kind !== 'accessibility') throw new Error('invalid kind');
    const status = await service.requestPermission(kind);
    if (status.supported) await shell.openExternal(SETTINGS_PANES[kind]);
    return status;
  });
  handle(IPC_CHANNELS.computerSetActiveSessions, (ids) => {
    service.setActiveSessions(strings(ids, 1000, 80));
  });
  handle(IPC_CHANNELS.computerSetOverlayLabel, (label) => {
    if (typeof label !== 'string' || label.length === 0 || label.length > 120) {
      throw new Error('invalid label');
    }
    overlay.setLabel(label);
  });
  handle(IPC_CHANNELS.computerAppIcon, async (path) => {
    if (typeof path !== 'string' || !path.endsWith('.app') || !existsSync(path)) return null;
    try {
      return (await app.getFileIcon(path, { size: 'normal' })).toDataURL();
    } catch {
      return null;
    }
  });

  return {
    dispose() {
      helper.close();
      overlay.dispose();
    },
  };
}
