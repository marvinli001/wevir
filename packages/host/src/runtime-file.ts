import { randomBytes } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { uptime } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { HOME_LAYOUT } from './home.js';

/** 运行时文件名，位于 `<数据目录>/run/`（ADR-0002 §6）。 */
export const RUNTIME_FILE = 'host.json';

/**
 * `run/host.json` 的内容（ADR-0002 §6）。启动时先写不含 `url`、`token` 的占位，监听就绪后整体替换
 * 成完整内容；客户端读到没有 `url` 的文件，说明 Host 正在启动。
 */
export interface HostRuntimeInfo {
  pid: number;
  /** ISO 时间。与 `pid` 一起认定“是不是同一个 Host”。 */
  startedAt: string;
  protocolVersion: string;
  hostVersion: string;
  /** 完整的 WebSocket 端点，客户端照用、不自己拼。 */
  url?: string;
  /** 本次启动的令牌（32 字节随机数，base64url）。 */
  token?: string;
}

/** 已有一个活着的 Host 占着这个数据目录。 */
export class HostAlreadyRunningError extends Error {
  override readonly name = 'HostAlreadyRunningError';
  constructor(
    readonly path: string,
    readonly existing: HostRuntimeInfo,
  ) {
    super(
      `another Wevir Host is already running for this data directory ` +
        `(pid ${existing.pid}, started ${existing.startedAt}); see ${path}`,
    );
  }
}

/** 时钟换算出的开机时刻有秒级误差，在此之前写下的文件才算“上一次开机留下的”。 */
const BOOT_TOLERANCE_MS = 5000;

/** 刚被排他创建、还没写完的文件读到空内容时，重读的次数与间隔。 */
const READ_RETRY_ATTEMPTS = 10;
const READ_RETRY_DELAY_MS = 50;

/** 占位被并发的启动者抢走或刚好回收时，重试排他创建的次数。 */
const ACQUIRE_ATTEMPTS = 3;

export interface StaleCheckOptions {
  /** 默认 `kill(pid, 0)`：进程存在（含 EPERM，即属于别的用户）为活着。 */
  isAlive?: (pid: number) => boolean;
  /** 本次开机的时刻（毫秒），默认 `Date.now() - os.uptime()`。 */
  bootTime?: number;
  /** 默认 `process.pid`。 */
  selfPid?: number;
}

/**
 * 判断已有的 `host.json` 是否陈旧（ADR-0002 §6，做法同 Paseo A13）：
 * - `startedAt` 早于本次开机：写它的进程不可能还活着，PID 即使存在也已被系统复用；
 * - PID 就是自己：写它的 Host 已经不在，PID 复用到了当前进程上；
 * - 否则看 `kill(pid, 0)`。
 */
export function isRuntimeInfoStale(
  info: HostRuntimeInfo,
  options: StaleCheckOptions = {},
): boolean {
  const isAlive = options.isAlive ?? isProcessAlive;
  const bootTime = options.bootTime ?? Date.now() - uptime() * 1000;
  if (info.pid === (options.selfPid ?? process.pid)) return true;
  const started = Date.parse(info.startedAt);
  if (!Number.isNaN(started) && started < bootTime - BOOT_TOLERANCE_MS) return true;
  return !isAlive(info.pid);
}

/** `kill(pid, 0)`：ESRCH 为不存在；EPERM 说明进程存在、只是不属于当前用户。 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 解析 `host.json` 的内容；形状不对返回 undefined。多出的字段忽略。 */
export function parseRuntimeInfo(text: string): HostRuntimeInfo | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (!Number.isSafeInteger(v.pid) || (v.pid as number) <= 0) return undefined;
  for (const key of ['startedAt', 'protocolVersion', 'hostVersion'] as const) {
    if (typeof v[key] !== 'string') return undefined;
  }
  for (const key of ['url', 'token'] as const) {
    if (v[key] !== undefined && typeof v[key] !== 'string') return undefined;
  }
  const info: HostRuntimeInfo = {
    pid: v.pid as number,
    startedAt: v.startedAt as string,
    protocolVersion: v.protocolVersion as string,
    hostVersion: v.hostVersion as string,
  };
  if (v.url !== undefined) info.url = v.url as string;
  if (v.token !== undefined) info.token = v.token as string;
  return info;
}

export interface AcquireRuntimeFileOptions extends StaleCheckOptions {
  home: string;
  protocolVersion: string;
  hostVersion: string;
  /** 默认 `process.pid`。 */
  pid?: number;
  /** 默认当前时间。 */
  startedAt?: string;
}

/**
 * 本进程持有的 `run/host.json`（ADR-0002 §6、Paseo A13）：
 *
 * - `acquire`：`run/` 目录 0700；以排他创建（`wx`，0600）写入占位。已有文件时判断是否陈旧（见
 *   `isRuntimeInfoStale`）：活着就抛 `HostAlreadyRunningError`；陈旧就再读一遍确认还是同一个文件，
 *   删除后重试。
 * - `publish`：监听就绪后，先以 0600 写同目录的临时文件再 rename 覆盖，补上 `url` 与 `token`。
 * - `releaseSync`：只删除 `{pid, startedAt}` 仍是自己的文件；同步执行，强制退出时也能调用。
 *
 * Windows 上 0600 / 0700 不生效，依赖 `%APPDATA%` 的按用户 ACL（ADR-0002“后果”）。
 */
export class RuntimeFile {
  readonly path: string;
  readonly info: Readonly<HostRuntimeInfo>;
  /** 启动时回收的陈旧文件内容，供日志使用。 */
  readonly reclaimed: Readonly<HostRuntimeInfo> | undefined;

  private constructor(path: string, info: HostRuntimeInfo, reclaimed: HostRuntimeInfo | undefined) {
    this.path = path;
    this.info = info;
    this.reclaimed = reclaimed;
  }

  static async acquire(options: AcquireRuntimeFileOptions): Promise<RuntimeFile> {
    const dir = join(options.home, HOME_LAYOUT.runDir);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // 目录早已存在时 mkdir 的 mode 不生效。
    if (process.platform !== 'win32') await chmod(dir, 0o700);
    const path = join(dir, RUNTIME_FILE);
    const info: HostRuntimeInfo = {
      pid: options.pid ?? process.pid,
      startedAt: options.startedAt ?? new Date().toISOString(),
      protocolVersion: options.protocolVersion,
      hostVersion: options.hostVersion,
    };
    const staleOptions: StaleCheckOptions = { ...options, selfPid: options.selfPid ?? info.pid };

    let reclaimed: HostRuntimeInfo | undefined;
    for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
      if (await createExclusive(path, info)) return new RuntimeFile(path, info, reclaimed);
      const existing = await readSettled(path);
      if (existing === 'missing') continue;
      if (existing === 'empty') {
        // 创建者在写入前就退出了，文件不指向任何 Host。
        await removeIf(path, (text) => text === '');
        continue;
      }
      if (!isRuntimeInfoStale(existing, staleOptions)) {
        throw new HostAlreadyRunningError(path, existing);
      }
      await removeIf(path, (text) => {
        const again = parseRuntimeInfo(text);
        return again !== undefined && sameOwner(again, existing);
      });
      reclaimed = existing;
    }
    throw new Error(`could not create ${path}: another Host may be starting at the same time`);
  }

  /** 补上 `url` 与 `token`，原子替换。文件已不属于本进程时抛错，不覆盖别人的文件。 */
  async publish(url: string, token: string): Promise<void> {
    const current = parseRuntimeInfo(await readFile(this.path, 'utf8').catch(() => ''));
    if (!current || !sameOwner(current, this.info)) {
      throw new Error(`${this.path} is no longer owned by this Host`);
    }
    const content: HostRuntimeInfo = { ...this.info, url, token };
    const temp = `${this.path}.${this.info.pid}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeNew(temp, content);
      await rename(temp, this.path);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  /** 文件仍属于本进程（`pid` 与 `startedAt` 都相同）时删除，返回是否删除。不抛错。 */
  releaseSync(): boolean {
    try {
      const current = parseRuntimeInfo(readFileSync(this.path, 'utf8'));
      if (!current || !sameOwner(current, this.info)) return false;
      unlinkSync(this.path);
      return true;
    } catch {
      return false;
    }
  }
}

function sameOwner(a: Pick<HostRuntimeInfo, 'pid' | 'startedAt'>, b: typeof a): boolean {
  return a.pid === b.pid && a.startedAt === b.startedAt;
}

/** 排他创建并写入；文件已存在返回 false。 */
async function createExclusive(path: string, info: HostRuntimeInfo): Promise<boolean> {
  try {
    await writeNew(path, info);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/** 以 `wx`、0600 新建文件，写完 fsync；写入失败时删掉自己建的文件。 */
async function writeNew(path: string, info: HostRuntimeInfo): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(info)}\n`);
    await file.sync();
  } catch (error) {
    await file.close();
    await rm(path, { force: true });
    throw error;
  }
  await file.close();
}

/**
 * 读已有的文件。创建者排他创建后才写入，读到空内容时稍等重读；重读后仍为空返回 `empty`。内容不是
 * 合法的 `host.json` 时抛错：无法确认没有 Host 在运行，不擅自删除。
 */
async function readSettled(path: string): Promise<HostRuntimeInfo | 'missing' | 'empty'> {
  let text = '';
  for (let attempt = 0; attempt < READ_RETRY_ATTEMPTS; attempt += 1) {
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw error;
    }
    if (text !== '') break;
    await sleep(READ_RETRY_DELAY_MS);
  }
  if (text === '') return 'empty';
  const info = parseRuntimeInfo(text);
  if (!info) {
    throw new Error(
      `${path} is not a valid runtime file; remove it after making sure no Wevir Host is running`,
    );
  }
  return info;
}

/** 再读一遍，内容仍满足 `check` 才删除（缩小与并发启动者之间的竞争窗口）。 */
async function removeIf(path: string, check: (text: string) => boolean): Promise<void> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (check(text)) await rm(path, { force: true });
}
