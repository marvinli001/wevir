// 插件页“添加”的来源判断与 SKILL.md 预览的读取（0.42.0，docs/architecture/desktop-layout.md §23）。只读：不复制、不解压，真正的
// 校验与安装由 Host 的 `plugin.install` / `skill.install` 做。判断规则与 Host（packages/host/src/plugin-install.ts 的
// stagePlugin / packageRoot / readSkills）一致：
// - 文件夹：根上有 wevir-plugin.json、.codex-plugin/plugin.json 或 .claude-plugin/plugin.json（或只有那两个目录）的是插件包，
//   其余是 Skills；
// - ZIP：根是解压目录，只有一个不以 . 开头的顶层文件夹时根下移一层（导出工具常见的外层文件夹），规则同上；
// - 名为 SKILL.md 的文件是 Skills；其他文件、符号链接都不是来源。

import { lstat, readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { INSTALL_SOURCE_LIMITS, type InstallSourceInspection } from '../shared/desktop-api.js';

/** Wevir 插件包的清单文件名（packages/protocol 的 WEVIR_PLUGIN_MANIFEST；主进程不为一个常量引入整个协议包）。 */
const WEVIR_MANIFEST = 'wevir-plugin.json';
/** Host 的 readManifest 先看 .codex-plugin 再看 .claude-plugin，这里同一个顺序。 */
const IMPORTED_MANIFESTS = [
  { dir: '.codex-plugin', format: 'codex' },
  { dir: '.claude-plugin', format: 'claude' },
] as const;
/** ZIP 目录的条目上限，同 Host 的 MAX_ENTRIES；超过的 Host 也会拒绝，这里当不是插件包。 */
const ZIP_ENTRIES_MAX = 2000;

export async function inspectInstallSource(path: string): Promise<InstallSourceInspection> {
  if (!isAbsolute(path)) throw new Error('an absolute path is required');
  const info = await lstat(path);
  if (info.isDirectory()) return inspectFolder(path);
  if (info.isFile()) {
    if (basename(path) === 'SKILL.md') return { kind: 'skill' };
    if (path.toLowerCase().endsWith('.zip')) return inspectZip(path);
  }
  return { kind: 'unsupported' };
}

async function inspectFolder(root: string): Promise<InstallSourceInspection> {
  if (await isFile(join(root, WEVIR_MANIFEST))) {
    const manifest = await readJson(join(root, WEVIR_MANIFEST));
    return manifest === undefined
      ? { kind: 'plugin', format: 'wevir' }
      : { kind: 'plugin', format: 'wevir', manifest };
  }
  for (const { dir, format } of IMPORTED_MANIFESTS) {
    if (await isFile(join(root, dir, 'plugin.json'))) return { kind: 'plugin', format };
  }
  // 只有标记目录、没有清单：Host 的 skill.install 把它当插件包拒绝，这里同样不当 Skills。
  for (const { dir, format } of IMPORTED_MANIFESTS) {
    if (await exists(join(root, dir))) return { kind: 'plugin', format };
  }
  return { kind: 'skill' };
}

async function inspectZip(path: string): Promise<InstallSourceInspection> {
  const zip = await yauzl.openPromise(path, {
    autoClose: false,
    validateEntrySizes: true,
    strictFileNames: true,
  });
  try {
    if (zip.entryCount > ZIP_ENTRIES_MAX) return { kind: 'skill' };
    const names = new Set<string>();
    const files = new Map<string, Entry>();
    const top = new Map<string, boolean>();
    for await (const entry of zip.eachEntry()) {
      const name = entry.fileName;
      const first = name.split('/')[0] ?? '';
      if (first === '') continue;
      names.add(name);
      // 顶层名字：有下一层或以 / 结尾的是文件夹。
      top.set(first, (top.get(first) ?? false) || name.includes('/'));
      if (!name.endsWith('/')) files.set(name, entry);
    }
    const prefix = zipRoot(top);
    const entryOf = (name: string) => files.get(`${prefix}${name}`);
    const wevir = entryOf(WEVIR_MANIFEST);
    if (wevir) {
      const text = await readEntry(zip, wevir, INSTALL_SOURCE_LIMITS.manifestBytes);
      const manifest = text === undefined ? undefined : parseJson(text);
      return manifest === undefined
        ? { kind: 'plugin', format: 'wevir' }
        : { kind: 'plugin', format: 'wevir', manifest };
    }
    for (const { dir, format } of IMPORTED_MANIFESTS) {
      if (entryOf(`${dir}/plugin.json`)) return { kind: 'plugin', format };
    }
    // 只有标记目录、没有清单（同文件夹的判断）。
    for (const { dir, format } of IMPORTED_MANIFESTS) {
      const marker = `${prefix}${dir}/`;
      for (const name of names) {
        if (name.startsWith(marker)) return { kind: 'plugin', format };
      }
    }
    return { kind: 'skill' };
  } finally {
    zip.close();
  }
}

/** ZIP 的根前缀：只有一个不以 . 开头的顶层文件夹时是 `名字/`，否则是空（Host 的 packageRoot）。 */
function zipRoot(top: ReadonlyMap<string, boolean>): string {
  const only = top.size === 1 ? [...top][0] : undefined;
  return only?.[1] && !only[0].startsWith('.') ? `${only[0]}/` : '';
}

async function readEntry(zip: ZipFile, entry: Entry, limit: number): Promise<string | undefined> {
  if (entry.uncompressedSize > limit) return undefined;
  const stream = await zip.openReadStreamPromise(entry);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) {
      stream.destroy();
      return undefined;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** `wevir-plugin.json` 的内容；太大、读不出来或不是 JSON 时没有，由 Host 装的时候报原因。 */
async function readJson(path: string): Promise<unknown> {
  try {
    if ((await stat(path)).size > INSTALL_SOURCE_LIMITS.manifestBytes) return undefined;
    return parseJson(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return undefined;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFile();
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Skills 预览读到的 `SKILL.md`：只认名为 SKILL.md 的普通文件（可经符号链接），不超过 512 KiB。 */
export async function readSkillFile(path: string): Promise<string> {
  if (!isAbsolute(path) || basename(path) !== 'SKILL.md') {
    throw new Error('an absolute path to a SKILL.md is required');
  }
  const info = await stat(path);
  if (!info.isFile()) throw new Error('not a file');
  if (info.size > INSTALL_SOURCE_LIMITS.skillBytes) throw new Error('SKILL.md is too large');
  return readFile(path, 'utf8');
}
