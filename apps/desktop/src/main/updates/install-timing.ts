// “重启以更新”各段的耗时。旧版本在交给安装程序前后记下时间点（`<userData>/update-install.json`），新版本启动、窗口显示且
// Host 就绪后补上自己的时间点，算出各段耗时，追加一行 JSON 到 `<数据目录>/logs/update-timing.log`。Windows 上的安装包是
// GUI 程序，主进程的 console 看不到，在 Windows 上复测靠这个文件。重新打开的不是新版本（没装上）也记一行，`installed: false`。
//
// 不依赖 Electron：路径与时间从参数传入，单元测试直接用临时目录。

import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** 旧版本记下的文件名（在 userData 下）。 */
export const PENDING_INSTALL_FILE = 'update-install.json';
/** 结果追加到的文件名（在数据目录的 logs/ 下）。 */
export const INSTALL_TIMING_LOG = 'update-timing.log';
/** 点击之后这么久还没被新版本读到的记录不算（例如装完没有重新打开），丢掉。 */
const STALE_MS = 60 * 60 * 1000;

/** 旧版本这边的时间点（毫秒时间戳）。 */
export interface PendingInstall {
  from: string;
  to: string;
  platform: string;
  /** 点了“重启以更新”。 */
  clickedAt: number;
  /** 自己拉起的 Host 为安装停完（只有 Windows 提前停）。 */
  hostStoppedAt?: number;
  /** 调用了 quitAndInstall：Windows 在这时启动安装程序。 */
  installerAt?: number;
  /** 主进程即将退出（will-quit）。 */
  quitAt?: number;
}

/** 新版本这边的时间点。 */
export interface StartupMarks {
  /** 进程创建（`process.getCreationTime()`）。 */
  processAt: number;
  /** app ready。 */
  readyAt?: number;
  /** 主窗口第一次显示。 */
  windowAt?: number;
  /** Host 就绪或启动失败。 */
  hostAt?: number;
}

export interface InstallTiming {
  ts: string;
  from: string;
  to: string;
  current: string;
  platform: string;
  installed: boolean;
  /** 各段耗时（毫秒），缺了哪个时间点就没有对应的段。 */
  ms: Record<string, number>;
}

/** 点了“重启以更新”时调用。记不下来不影响安装（不抛错）。 */
export function startInstallTiming(
  file: string,
  install: Pick<PendingInstall, 'from' | 'to' | 'platform' | 'clickedAt'>,
): void {
  try {
    write(file, install);
  } catch {}
}

/** 补一个旧版本这边的时间点。没有记录时什么也不做；记不下来不影响安装（不抛错）。 */
export function markInstallTiming(
  file: string,
  key: 'hostStoppedAt' | 'installerAt' | 'quitAt',
  at: number,
): void {
  const pending = read(file);
  if (pending === undefined) return;
  try {
    write(file, { ...pending, [key]: at });
  } catch {}
}

/**
 * 新版本启动后调用：有旧版本记下的、没过期的记录就算出各段耗时并追加到 `logFile`，返回这一行；没有记录时返回 undefined。
 * 读过就删掉，下次启动不再算。
 */
export function finishInstallTiming(options: {
  file: string;
  logFile: string;
  currentVersion: string;
  marks: StartupMarks;
  now: number;
}): InstallTiming | undefined {
  const pending = read(options.file);
  rmSync(options.file, { force: true });
  if (pending === undefined) return undefined;
  if (options.now - pending.clickedAt > STALE_MS || options.now < pending.clickedAt) {
    return undefined;
  }
  const { marks } = options;
  const ms: Record<string, number> = {};
  const span = (name: string, from: number | undefined, to: number | undefined) => {
    if (from !== undefined && to !== undefined) ms[name] = Math.round(to - from);
  };
  // 旧版本：点击 → Host 停完 → 交给安装程序 → 主进程退出。
  span('hostStop', pending.clickedAt, pending.hostStoppedAt);
  span('toInstaller', pending.clickedAt, pending.installerAt);
  span('toQuit', pending.clickedAt, pending.quitAt);
  // 旧进程退出到新进程创建：Windows 是安装程序（检测进程、卸载旧版、解压新版），macOS 是 Squirrel 替换应用。
  span('install', pending.quitAt, marks.processAt);
  // 新版本冷启动。
  span('appReady', marks.processAt, marks.readyAt);
  span('window', marks.processAt, marks.windowAt);
  span('host', marks.processAt, marks.hostAt);
  span('total', pending.clickedAt, marks.windowAt);
  const timing: InstallTiming = {
    ts: new Date(options.now).toISOString(),
    from: pending.from,
    to: pending.to,
    current: options.currentVersion,
    platform: pending.platform,
    installed: options.currentVersion === pending.to,
    ms,
  };
  mkdirSync(dirname(options.logFile), { recursive: true });
  appendFileSync(options.logFile, `${JSON.stringify(timing)}\n`);
  return timing;
}

function read(file: string): PendingInstall | undefined {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as Partial<PendingInstall>;
    if (
      typeof value.from !== 'string' ||
      typeof value.to !== 'string' ||
      typeof value.platform !== 'string' ||
      typeof value.clickedAt !== 'number'
    ) {
      return undefined;
    }
    return value as PendingInstall;
  } catch {
    return undefined;
  }
}

function write(file: string, pending: PendingInstall): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(pending)}\n`);
}
