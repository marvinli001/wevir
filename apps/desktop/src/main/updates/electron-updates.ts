// 把 UpdateController 接到真实的 Electron 与 electron-updater 上（index.ts 用）。网络请求走 Electron 的 net.fetch（Chromium
// 的网络栈，跟随系统代理），通道偏好存在 `<userData>/updates.json`。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { app, net } from 'electron';
import electronUpdater from 'electron-updater';
import type { UpdateChannel } from '../../shared/desktop-api.js';
import { type Fetcher, mirrorsFromEnv, UPDATE_MIRRORS } from './feed.js';
import { UPDATE_PUBLIC_KEYS } from './keys.js';
import {
  UpdateController,
  type UpdateControllerOptions,
  type UpdateLog,
  type UpdatePrefs,
  type UpdaterLike,
} from './updater.js';

/** macOS 上应用从 dmg 直接打开（/Volumes）或被系统转移到临时位置（AppTranslocation）时，Squirrel 换不了它。 */
export function isReadOnlyLocation(platform: NodeJS.Platform, execPath: string): boolean {
  if (platform !== 'darwin') return false;
  return execPath.includes('/AppTranslocation/') || execPath.startsWith('/Volumes/');
}

function isChannel(value: unknown): value is UpdateChannel {
  return value === 'stable' || value === 'dev';
}

export function createUpdateController(
  log: UpdateLog,
  hooks: Pick<UpdateControllerOptions, 'prepareInstall'> = {},
): UpdateController {
  const prefsPath = join(app.getPath('userData'), 'updates.json');
  const readPrefs = (): UpdatePrefs => {
    try {
      const value = JSON.parse(readFileSync(prefsPath, 'utf8')) as { channel?: unknown };
      return isChannel(value.channel) ? { channel: value.channel } : {};
    } catch {
      return {};
    }
  };
  const writePrefs = (prefs: UpdatePrefs) => {
    mkdirSync(dirname(prefsPath), { recursive: true });
    writeFileSync(prefsPath, `${JSON.stringify(prefs)}\n`);
  };
  const fetcher: Fetcher = (url, init) =>
    net.fetch(url, {
      ...(init?.headers !== undefined && { headers: init.headers }),
      ...(init?.signal !== undefined && { signal: init.signal }),
    });
  const mirrors = mirrorsFromEnv(process.env.WEVIR_UPDATE_MIRRORS) ?? UPDATE_MIRRORS;
  return new UpdateController({
    updater: electronUpdater.autoUpdater as unknown as UpdaterLike,
    currentVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    mirrors,
    publicKeys: UPDATE_PUBLIC_KEYS,
    fetcher,
    packaged: app.isPackaged,
    readOnlyLocation: isReadOnlyLocation(process.platform, process.execPath),
    readPrefs,
    writePrefs,
    log,
    ...hooks,
    ...(process.env.WEVIR_UPDATE_FIRST_CHECK_MS !== undefined && {
      firstCheckMs: Number(process.env.WEVIR_UPDATE_FIRST_CHECK_MS),
    }),
  });
}
