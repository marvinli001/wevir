import type { Stats } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import {
  FILES_READ_FILE_MAX_BYTES,
  isExcludedSyncMaterialPath,
  SyncRelativePathSchema,
} from '@wevir/protocol';
import { jcs } from '@wevir/protocol/sync';
import { ZuvRequestError } from '../zuv/transport.js';
import { sha256 } from './crypto.js';

export const excludedBundlePath = isExcludedSyncMaterialPath;
export interface BundleFile {
  path: string;
  bytes: Buffer;
  sha256: string;
  executable: boolean;
}
export interface BundleRoot {
  path: string;
  metadata?: unknown;
  paths?: readonly string[];
  exclusions?: readonly string[];
  guard?: () => void;
  executables?: ReadonlyMap<string, boolean>;
}
export class BundleReadCache {
  readonly #files = new Map<string, { stamp: string; file: BundleFile }>();
  #bytes = 0;
  get(path: string, info: Stats) {
    const value = this.#files.get(path);
    return value?.stamp === `${info.ino}:${info.mtimeMs}:${info.size}:${info.mode}`
      ? value.file
      : undefined;
  }
  put(path: string, info: Stats, file: BundleFile) {
    this.#bytes -= this.#files.get(path)?.file.bytes.length ?? 0;
    this.#files.delete(path);
    this.#files.set(path, { stamp: `${info.ino}:${info.mtimeMs}:${info.size}:${info.mode}`, file });
    this.#bytes += file.bytes.length;
    while (this.#bytes > 64 * 1024 * 1024) {
      const [key, value] = this.#files.entries().next().value as [string, { file: BundleFile }];
      this.#bytes -= value.file.bytes.length;
      this.#files.delete(key);
    }
  }
}
export function bundleFingerprint(input: {
  files: ReadonlyArray<{ path: string; sha256: string; executable?: boolean }>;
  exclusions: readonly string[];
  metadata?: unknown;
  deleted?: boolean;
}): string {
  return sha256(
    jcs({
      files: input.files
        .map((file) => ({
          path: file.path.normalize('NFC'),
          sha256: file.sha256,
          executable: process.platform === 'win32' ? false : file.executable === true,
        }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      exclusions: [...new Set(input.exclusions.map((path) => path.normalize('NFC')))].sort(),
      metadata: input.metadata ?? null,
      ...(input.deleted && { deleted: true }),
    }),
  );
}
export async function snapshotBundle(
  root: BundleRoot,
  allowMissing = false,
  cache?: BundleReadCache,
) {
  root.guard?.();
  const files: BundleFile[] = [];
  const omitted = new Set((root.exclusions ?? []).map((path) => path.normalize('NFC')));
  for (const path of omitted)
    if (!SyncRelativePathSchema.safeParse(path).success)
      throw new ZuvRequestError('INTEGRITY_FAILED');
  const exclusions = [...omitted];
  const exclude = (path: string) => {
    if (!omitted.has(path)) {
      omitted.add(path);
      exclusions.push(path);
    }
  };
  const omittedFolded = new Set([...omitted].map((path) => path.normalize('NFC').toLowerCase()));
  const excluded = (path: string) => {
    if (excludedBundlePath(path)) return true;
    const parts = path.normalize('NFC').toLowerCase().split('/');
    let prefix = '';
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      if (omittedFolded.has(prefix)) return true;
    }
    return false;
  };
  const paths = new Set<string>();
  let totalBytes = 0,
    dirs = 0;
  const top = await lstat(root.path).catch((error) => {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  });
  if (!top)
    return {
      files,
      exclusions,
      deleted: true,
      fingerprint: bundleFingerprint({ ...root, files, exclusions, deleted: true }),
    };
  if (top.isSymbolicLink()) throw new ZuvRequestError('INTEGRITY_FAILED');
  const base = top.isDirectory() ? root.path : dirname(root.path);
  const visit = async (path: string): Promise<void> => {
    root.guard?.();
    const info = await lstat(path);
    const name = (relative(base, path).split(sep).join('/') || basename(path)).normalize('NFC');
    if (!SyncRelativePathSchema.safeParse(name).success || info.isSymbolicLink())
      throw new ZuvRequestError('INTEGRITY_FAILED');
    if (name.split('/').some((part) => part.startsWith('.wevir-sync-'))) return;
    if (excluded(name)) {
      exclude(name);
      return;
    }
    if (info.isDirectory()) {
      if (++dirs > 10000) throw new ZuvRequestError('QUOTA_EXCEEDED');
      for (const entry of (await readdir(path)).sort()) await visit(join(path, entry));
      return;
    }
    const folded = name.normalize('NFC').toLowerCase();
    if (paths.has(folded)) throw new ZuvRequestError('INTEGRITY_FAILED');
    paths.add(folded);
    if (!info.isFile() || files.length >= 10000) throw new ZuvRequestError('QUOTA_EXCEEDED');
    if (root.paths && info.size > FILES_READ_FILE_MAX_BYTES)
      throw new ZuvRequestError('QUOTA_EXCEEDED');
    totalBytes += info.size;
    if (totalBytes > 64 * 1024 * 1024) throw new ZuvRequestError('QUOTA_EXCEEDED');
    const cached = cache?.get(path, info);
    let bytes: Buffer;
    if (cached) bytes = cached.bytes;
    else {
      const handle = await open(path, 'r');
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.ino !== info.ino || opened.size !== info.size)
          throw new ZuvRequestError('REVISION_CONFLICT');
        bytes = Buffer.alloc(info.size + 1);
        let offset = 0;
        while (offset < bytes.length) {
          root.guard?.();
          const { bytesRead } = await handle.read(
            bytes,
            offset,
            Math.min(64 * 1024, bytes.length - offset),
            offset,
          );
          if (!bytesRead) break;
          offset += bytesRead;
        }
        bytes = bytes.subarray(0, offset);
      } finally {
        await handle.close();
      }
    }
    const after = await lstat(path);
    if (
      info.ino !== after.ino ||
      info.mtimeMs !== after.mtimeMs ||
      info.size !== after.size ||
      bytes.length !== info.size
    )
      throw new ZuvRequestError('REVISION_CONFLICT');
    const file: BundleFile = {
      path: name,
      bytes,
      sha256: cached?.sha256 ?? sha256(bytes),
      executable:
        process.platform === 'win32'
          ? (root.executables?.get(name) ?? false)
          : Boolean(info.mode & 0o111),
    };
    files.push(file);
    cache?.put(path, info, file);
  };
  if (root.paths) {
    for (const path of root.paths) {
      if (!SyncRelativePathSchema.safeParse(path).success)
        throw new ZuvRequestError('INTEGRITY_FAILED');
      if (excluded(path)) {
        exclude(path);
        continue;
      }
      let current = root.path;
      try {
        for (const part of path.split('/')) {
          current = join(current, part);
          if ((await lstat(current)).isSymbolicLink())
            throw new ZuvRequestError('INTEGRITY_FAILED');
        }
        if (!(await lstat(current)).isFile()) throw new ZuvRequestError('INTEGRITY_FAILED');
        await visit(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        exclude(path);
      }
    }
  } else if (top.isDirectory()) {
    for (const name of (await readdir(root.path)).sort()) await visit(join(root.path, name));
  } else await visit(root.path);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  root.guard?.();
  return {
    files,
    exclusions,
    deleted: false,
    fingerprint: bundleFingerprint({ ...root, files, exclusions }),
  };
}
