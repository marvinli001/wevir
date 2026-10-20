// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 OpenAI
// 改写自 openai/codex codex-rs/core-plugins/src/manifest.rs，提交 092d3acd6bec3e3a14bdc7e7a2810ab628ab759d。
// 修改：只读本地 Codex / Claude 包的清单与 MCP 配置（0.42.0 起由 plugin-packages.ts 转成 Wevir 插件）；不执行 hooks / 安装脚本。
import { constants, createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  type McpServerConfig,
  McpServerConfigSchema,
  WEVIR_PLUGIN_MANIFEST,
} from '@wevir/protocol';
import yauzl from 'yauzl';
import { record, scanSkills } from './plugin-skills.js';

const MAX_ENTRIES = 2000;
const MAX_BYTES = 64 * 1024 * 1024;

export function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

export function member(root: string, name: string): string {
  if (
    !name ||
    name.includes('\\') ||
    name.includes('\0') ||
    /^[a-z]:/i.test(name) ||
    isAbsolute(name) ||
    name.split('/').includes('..')
  )
    throw new Error('Unsafe plugin member path');
  const path = resolve(root, name);
  if (!contained(root, path)) throw new Error('Plugin member escapes its folder');
  return path;
}

/** 新建的私有目录，逐项复制且拒绝链接 / 特殊文件，包内脚本保持可执行位。 */
export async function copyPlugin(source: string, target: string): Promise<void> {
  let entries = 0;
  let bytes = 0;
  const copy = async (from: string, to: string, depth: number): Promise<void> => {
    if (++entries > MAX_ENTRIES || depth > 32)
      throw new Error('Plugin has too many files or nested folders');
    const info = await lstat(from);
    if (info.isSymbolicLink()) throw new Error('Plugin symbolic links are not supported');
    if (info.isDirectory()) {
      await mkdir(to, { recursive: true, mode: 0o700 });
      for (const entry of await readdir(from))
        await copy(join(from, entry), member(to, entry), depth + 1);
    } else if (info.isFile()) {
      bytes += info.size;
      if (bytes > MAX_BYTES) throw new Error('Plugin exceeds the installation size limit');
      await copyFile(from, to, constants.COPYFILE_EXCL);
    } else throw new Error('Plugin special files are not supported');
  };
  await copy(source, target, 0);
}

export async function unpackPlugin(path: string, root: string): Promise<void> {
  const zip = await yauzl.openPromise(path, {
    autoClose: false,
    validateEntrySizes: true,
    strictFileNames: true,
  });
  let bytes = 0;
  const names = new Set<string>();
  try {
    if (zip.entryCount > MAX_ENTRIES) throw new Error('Plugin archive has too many entries');
    for await (const entry of zip.eachEntry()) {
      const to = member(root, entry.fileName);
      const kind = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (![0, 0o100000, 0o040000].includes(kind))
        throw new Error('Plugin archive contains a symbolic link or special file');
      if (names.has(to)) throw new Error('Plugin archive contains duplicate paths');
      names.add(to);
      bytes += entry.uncompressedSize;
      if (bytes > MAX_BYTES) throw new Error('Plugin archive exceeds the size limit');
      if (entry.fileName.endsWith('/')) {
        await mkdir(to, { recursive: true, mode: 0o700 });
        continue;
      }
      await mkdir(dirname(to), { recursive: true, mode: 0o700 });
      const stream = await zip.openReadStreamPromise(entry);
      await pipeline(
        stream,
        createWriteStream(to, {
          flags: 'wx',
          mode: (entry.externalFileAttributes >>> 16) & 0o111 ? 0o700 : 0o600,
        }),
      );
    }
  } finally {
    zip.close();
  }
}

/** 对 ZIP 允许一层常见的导出根文件夹。 */
export async function packageRoot(root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true });
  return entries.length === 1 && entries[0]?.isDirectory() && !entries[0].name.startsWith('.')
    ? join(root, entries[0].name)
    : root;
}

/** Codex / Claude 插件包的清单；没有时返回 undefined。 */
export async function readManifest(
  root: string,
): Promise<{ format: 'codex' | 'claude'; manifest: Record<string, unknown> } | undefined> {
  for (const [dir, format] of [
    ['.codex-plugin', 'codex'],
    ['.claude-plugin', 'claude'],
  ] as const) {
    let manifest: Record<string, unknown>;
    try {
      manifest = record(JSON.parse(await readFile(join(root, dir, 'plugin.json'), 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error('Invalid plugin manifest');
    }
    if (typeof manifest.name !== 'string' || !manifest.name.trim())
      throw new Error('Plugin manifest requires a name');
    for (const field of ['version', 'description']) {
      if (manifest[field] !== undefined && typeof manifest[field] !== 'string')
        throw new Error('Invalid plugin manifest metadata');
    }
    if (
      manifest.interface !== undefined &&
      (manifest.interface === null ||
        typeof manifest.interface !== 'object' ||
        Array.isArray(manifest.interface))
    )
      throw new Error('Invalid plugin interface');
    return { format, manifest };
  }
  return undefined;
}

/** 清单的 mcpServers（默认 ./.mcp.json，或行内服务表），转成 McpServerConfig。 */
export async function readMcpServers(
  root: string,
  manifest: Record<string, unknown>,
  names: { safeParse(value: unknown): { success: boolean } },
): Promise<Array<{ name: string; config: McpServerConfig }>> {
  const connectors: Array<{ name: string; config: McpServerConfig }> = [];
  let mcp = manifest.mcpServers ?? './.mcp.json';
  if (typeof mcp === 'string') {
    if (!mcp.startsWith('./')) throw new Error('Plugin paths must start with ./');
    const file = member(root, mcp);
    try {
      mcp = JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      if (manifest.mcpServers === undefined && (error as NodeJS.ErrnoException).code === 'ENOENT')
        mcp = {};
      else throw new Error('Invalid plugin MCP JSON');
    }
  }
  const data = record(mcp);
  // Codex 的行内 mcpServers 是服务表，.mcp.json / Claude 常用 mcpServers 包装。
  const servers = 'mcpServers' in data ? record(data.mcpServers) : data;
  for (const [name, value] of Object.entries(servers)) {
    if (!names.safeParse(name).success) throw new Error(`Invalid MCP server name "${name}"`);
    const entry = record(value);
    const allowed = new Set([
      'type',
      'transport',
      'command',
      'args',
      'env',
      'cwd',
      'url',
      'headers',
      'http_headers',
      'enabled',
      'toolTimeoutSec',
      'tool_timeout_sec',
    ]);
    if (
      Object.keys(entry).some((key) => !allowed.has(key)) ||
      (entry.type !== undefined &&
        !['stdio', 'http', 'streamable-http'].includes(String(entry.type))) ||
      (entry.transport !== undefined &&
        !['stdio', 'http', 'streamable-http'].includes(String(entry.transport)))
    )
      throw new Error(`Unsupported plugin MCP configuration "${name}"`);
    const parsed = McpServerConfigSchema.safeParse({
      ...entry,
      transport: entry.url === undefined ? 'stdio' : 'http',
      headers: entry.headers ?? entry.http_headers,
      toolTimeoutSec: entry.toolTimeoutSec ?? entry.tool_timeout_sec,
    });
    if (!parsed.success) throw new Error(`Invalid plugin MCP configuration "${name}"`);
    connectors.push({ name, config: parsed.data });
  }
  return connectors;
}

/** skill.install 的来源：skill 文件夹（可含多个）、SKILL.md 或 ZIP；插件包改走 plugin.install（0.42.0）。 */
export async function readSkills(root: string) {
  let isPackage = false;
  for (const marker of [WEVIR_PLUGIN_MANIFEST, '.codex-plugin', '.claude-plugin']) {
    try {
      await lstat(join(root, marker));
      isPackage = true;
    } catch {}
  }
  if (isPackage) throw new Error('This is a plugin package; install it with plugin.install');
  return scanSkills(root, 'wevir', true);
}

export async function stagePlugin(path: string, target: string): Promise<string> {
  path = resolve(path);
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error('Plugin symbolic links are not supported');
  if (info.isDirectory()) {
    const folder = member(target, basename(path));
    await copyPlugin(path, folder);
    return folder;
  }
  await mkdir(target, { recursive: true, mode: 0o700 });
  if (info.isFile() && basename(path) === 'SKILL.md') {
    const name = basename(dirname(path));
    // 单文件仍保留原父文件夹名，供 Codex 的 name 缺省规则使用。
    const folder = member(target, name);
    await mkdir(folder, { mode: 0o700 });
    await copyPlugin(path, join(folder, 'SKILL.md'));
    return folder;
  }
  if (info.isFile() && path.toLowerCase().endsWith('.zip')) {
    await unpackPlugin(path, target);
    return packageRoot(target);
  }
  throw new Error('Install a folder, SKILL.md or ZIP');
}
