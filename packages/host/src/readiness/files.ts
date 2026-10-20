// 预检读文件用的小工具（项目环境就绪，0.70.0）：只读、相对检查的根目录、读不到就是 undefined；依据里记下读了哪个文件。

import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReadinessEvidence } from '@wevir/protocol';

/** 一个文件最多读这么多字节（锁文件可能很大；超出的部分不看）。 */
export const READ_MAX_BYTES = 16 * 1024 * 1024;

/** 扫描项目时跳过的目录。 */
const SKIP_DIRS = new Set([
  'node_modules',
  'vendor',
  'target',
  'dist',
  'build',
  'out',
  'venv',
  '__pycache__',
  'bower_components',
]);

export class ProjectFiles {
  readonly root: string;
  readonly #text = new Map<string, Promise<string | undefined>>();

  constructor(root: string) {
    this.root = root;
  }

  abs(rel: string): string {
    return rel === '' ? this.root : join(this.root, ...rel.split('/'));
  }

  /** 读文本（同一次预检里缓存）。 */
  text(rel: string): Promise<string | undefined> {
    let cached = this.#text.get(rel);
    if (!cached) {
      cached = readText(this.abs(rel));
      this.#text.set(rel, cached);
    }
    return cached;
  }

  async json(rel: string): Promise<Record<string, unknown> | undefined> {
    const text = await this.text(rel);
    if (text === undefined) return undefined;
    try {
      const value = JSON.parse(text) as unknown;
      return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }

  async mtime(rel: string): Promise<number | undefined> {
    return (await stat(this.abs(rel)).catch(() => undefined))?.mtimeMs;
  }

  async isDir(rel: string): Promise<boolean> {
    return (await stat(this.abs(rel)).catch(() => undefined))?.isDirectory() === true;
  }

  async isFile(rel: string): Promise<boolean> {
    return (await stat(this.abs(rel)).catch(() => undefined))?.isFile() === true;
  }

  async exists(rel: string): Promise<boolean> {
    return (await stat(this.abs(rel)).catch(() => undefined)) !== undefined;
  }

  /** 可执行文件（POSIX 看执行位）。 */
  async isExecutable(rel: string): Promise<boolean> {
    const info = await stat(this.abs(rel)).catch(() => undefined);
    if (!info?.isFile()) return false;
    return process.platform === 'win32' || (info.mode & 0o111) !== 0;
  }

  async list(rel: string): Promise<string[]> {
    return (await readdir(this.abs(rel), { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  }

  /**
   * 根目录与它下面最多 `depth` 层的目录（相对路径，根是 `''`），跳过隐藏目录与依赖/构建目录，最多 `max` 个。
   */
  async directories(depth: number, max: number): Promise<string[]> {
    const ignored = gitignoredDirs((await this.text('.gitignore')) ?? '');
    const found: string[] = [''];
    let frontier = [''];
    for (let level = 0; level < depth && found.length < max; level++) {
      const next: string[] = [];
      for (const dir of frontier) {
        for (const name of (await this.list(dir)).sort()) {
          if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
          const rel = dir === '' ? name : `${dir}/${name}`;
          if (ignored.has(rel) || ignored.has(`*/${name}`)) continue;
          next.push(rel);
          found.push(rel);
          if (found.length >= max) return found;
        }
      }
      frontier = next;
    }
    return found;
  }
}

/**
 * 根目录 `.gitignore` 里写明的目录（不带通配符的行，`upstream/`、`/out`）：参考克隆、生成物之类的嵌套项目不算进来。只认最简单的写法，
 * 不认否定与通配；不带 `/` 的名字在任何一层都算（`*\/名字`）。
 */
export function gitignoredDirs(text: string): Set<string> {
  const dirs = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#') || line.startsWith('!') || /[*?[\]]/.test(line))
      continue;
    const anchored = line.startsWith('/');
    const clean = line.replace(/^\/+|\/+$/g, '');
    if (clean === '') continue;
    dirs.add(anchored || clean.includes('/') ? clean : `*/${clean}`);
    if (!anchored && !clean.includes('/')) dirs.add(clean);
  }
  return dirs;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return undefined;
    if (info.size > READ_MAX_BYTES) {
      const handle = await open(path, 'r');
      try {
        const buffer = Buffer.alloc(READ_MAX_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, READ_MAX_BYTES, 0);
        return buffer.subarray(0, bytesRead).toString('utf8');
      } finally {
        await handle.close();
      }
    }
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** `dir` 下的相对路径。 */
export function joinRel(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

/** `rel` 是不是 `dir` 本身或在它里面。 */
export function within(rel: string, dir: string): boolean {
  return dir === '' || rel === dir || rel.startsWith(`${dir}/`);
}

export function fileEvidence(path: string, detail?: string): ReadinessEvidence {
  return { kind: 'file', path, ...(detail !== undefined && { detail: detail.slice(0, 500) }) };
}

/** 对象里的字符串值（`dependencies` 这类）。 */
export function stringRecord(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') result[key] = item;
  }
  return result;
}
