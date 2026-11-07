// 设置 → 存储（shared/storage.ts）：把数据目录量一遍、按类加起来；清理日志与 Host 的文件缓存。Chromium 的缓存与内置浏览器的
// 数据由 index.ts 经 Electron 的 session 清（Chromium 还开着这些文件，不能直接删）。不依赖 Electron，对着临时目录测试。

import type { Dirent } from 'node:fs';
import { lstat, readdir, rm, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { HOME_LAYOUT, LOG_FILE } from '@wevir/host/runtime';
import { STORAGE_CATEGORIES, type StorageCategory, type StorageUsage } from '../shared/storage.js';

/** 桌面端的 userData（index.ts 的 app.setPath）：数据目录下的 desktop/。 */
export const DESKTOP_DIR = 'desktop';
/** Host 的引擎数据（runtime-adapter 的 `<数据目录>/engines/<引擎>/`）。 */
const ENGINES_DIR = 'engines';
/** 内置浏览器的 session 分区（browser-host.ts 的 BROWSER_PARTITION 去掉 `persist:`）在 userData 里的目录。 */
export const BROWSER_PARTITION_DIR = join('Partitions', 'wevir-browser');

/**
 * Chromium 在 userData（和每个分区目录）里能在运行中清掉的缓存：网页资源（HTTP）与脚本的编译缓存。GPU 着色器缓存
 * （GPUCache、GraphiteDawnCache 等）是预先分配好的块文件，大小固定（几 MB），运行中清不掉，算“其他”。
 */
export const CACHE_DIRS = new Set(['Cache', 'Code Cache', 'Shared Dictionary']);

/** Chromium HTTP 缓存的上限（`--disk-cache-size`，index.ts），每个 session 分区各自一份。 */
export const DISK_CACHE_MAX_BYTES = 100 * 1024 * 1024;

/** 数据目录顶层归到哪一类；desktop/ 另外细分，没列出的是“其他”。 */
const TOP_LEVEL: Record<string, StorageCategory> = {
  'wevir.db': 'sessions',
  'wevir.db-wal': 'sessions',
  'wevir.db-shm': 'sessions',
  'wevir.db-journal': 'sessions',
  [HOME_LAYOUT.historyDir]: 'sessions',
  [HOME_LAYOUT.chatsDir]: 'sessions',
  [HOME_LAYOUT.imagesDir]: 'sessions',
  [HOME_LAYOUT.generatedImagesDir]: 'sessions',
  // 大输出与后台进程的日志按会话存，删会话时一起删。
  [HOME_LAYOUT.toolOutputDir]: 'sessions',
  worktrees: 'worktrees',
  // 订阅账号的目录里是这个账号的引擎配置与会话（如 Codex 的 rollout），跟 engines/ 一样。
  [HOME_LAYOUT.accountsDir]: 'engines',
  [HOME_LAYOUT.speechDir]: 'components',
  [HOME_LAYOUT.logsDir]: 'logs',
  'node-compile-cache': 'cache',
};

/** engines/ 下按需下载的运行体：`engines/<引擎>/runtime/` 算下载的组件，其余是引擎数据。 */
const ENGINE_RUNTIME_DIR = 'runtime';
/** office/ 下：`engine/` 是下载的预览引擎，`pdf/` 是转出的 PDF 缓存（可以随时删，下次预览时重新转）。 */
const OFFICE_ENGINE_DIR = 'engine';
const OFFICE_PDF_DIR = 'pdf';

/** 同时进行的文件系统调用上限：worktree 里的 node_modules 动辄几十万个文件。 */
const CONCURRENCY = 32;

type Limit = <T>(task: () => Promise<T>) => Promise<T>;

function limiter(max: number): Limit {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (task) => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

/** 一个文件或整个文件夹的字节数（文件的大小之和，同访达）。不跟随符号链接；读不了的算 0。 */
async function sizeOf(path: string, limit: Limit): Promise<number> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await limit(() => lstat(path));
  } catch {
    return 0;
  }
  if (!info.isDirectory()) return Number(info.size);
  const names = await entries(path, limit);
  const sizes = await Promise.all(names.map((entry) => sizeOf(join(path, entry.name), limit)));
  return sizes.reduce((sum, size) => sum + size, 0);
}

async function entries(path: string, limit: Limit): Promise<Dirent[]> {
  try {
    return await limit(() => readdir(path, { withFileTypes: true }));
  } catch {
    return [];
  }
}

/** 某个目录下的每一项按 `classify` 归类后加到 `totals`。 */
async function addChildren(
  dir: string,
  totals: Map<StorageCategory, number>,
  limit: Limit,
  classify: (name: string) => StorageCategory | ((path: string) => Promise<void>),
  /** 要细分的名字不是目录（是文件或链接）时整个算进哪一类。 */
  fallback: StorageCategory = 'other',
): Promise<void> {
  await Promise.all(
    (await entries(dir, limit)).map(async (entry) => {
      const path = join(dir, entry.name);
      // 只有真的目录才往下细分；同名的文件或链接整个算进 `fallback`。
      const target = classify(entry.name);
      if (typeof target === 'function') {
        if (entry.isDirectory()) await target(path);
        else add(totals, fallback, await sizeOf(path, limit));
        return;
      }
      add(totals, target, await sizeOf(path, limit));
    }),
  );
}

function add(totals: Map<StorageCategory, number>, category: StorageCategory, bytes: number) {
  totals.set(category, (totals.get(category) ?? 0) + bytes);
}

/** 量数据目录 `home`：顶层按 TOP_LEVEL，desktop/ 里缓存目录算缓存，内置浏览器的分区（除去它的缓存）算浏览器数据。 */
export async function measureStorage(home: string): Promise<StorageUsage> {
  const limit = limiter(CONCURRENCY);
  const totals = new Map<StorageCategory, number>();
  const partition = async (path: string) =>
    addChildren(path, totals, limit, (name) => (CACHE_DIRS.has(name) ? 'cache' : 'browser'));
  const partitions = async (path: string) =>
    addChildren(path, totals, limit, (name) =>
      join('Partitions', name) === BROWSER_PARTITION_DIR ? partition : 'other',
    );
  // 办公文档预览（0.138.0）：office/engine/ 是下载的引擎，pdf/ 是缓存，其余（字体索引）算“其他”。
  const office = async (path: string) =>
    addChildren(path, totals, limit, (name) =>
      name === OFFICE_ENGINE_DIR ? 'components' : name === OFFICE_PDF_DIR ? 'cache' : 'other',
    );
  const engine = async (path: string) =>
    addChildren(path, totals, limit, (name) =>
      name === ENGINE_RUNTIME_DIR ? 'components' : 'engines',
    );
  const engines = async (path: string) => addChildren(path, totals, limit, () => engine, 'engines');
  const desktop = async (path: string) =>
    addChildren(path, totals, limit, (name) =>
      CACHE_DIRS.has(name) ? 'cache' : name === 'Partitions' ? partitions : 'other',
    );
  await addChildren(home, totals, limit, (name) =>
    name === DESKTOP_DIR
      ? desktop
      : name === HOME_LAYOUT.officeDir
        ? office
        : name === ENGINES_DIR
          ? engines
          : (TOP_LEVEL[name] ?? 'other'),
  );
  const categories = STORAGE_CATEGORIES.map((id) => ({ id, bytes: totals.get(id) ?? 0 }));
  return {
    root: home,
    total: categories.reduce((sum, category) => sum + category.bytes, 0),
    categories,
  };
}

/**
 * 清理日志：Host 正在写的 host.log 截成空的（Host 以追加方式打开，接着写不受影响），其余文件与文件夹删掉。
 */
export async function cleanLogs(home: string): Promise<void> {
  const dir = join(home, HOME_LAYOUT.logsDir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  await Promise.all(
    names.map((name) =>
      name === LOG_FILE
        ? truncate(join(dir, name), 0)
        : rm(join(dir, name), { recursive: true, force: true }),
    ),
  );
}

/** 清理 Host 的文件缓存：预览 PDF 与 Node 编译缓存（使用时重新生成）。 */
export async function cleanFileCaches(home: string): Promise<void> {
  await Promise.all([
    rm(join(home, HOME_LAYOUT.officeDir, OFFICE_PDF_DIR), { recursive: true, force: true }),
    rm(join(home, 'node-compile-cache'), { recursive: true, force: true }),
  ]);
}
