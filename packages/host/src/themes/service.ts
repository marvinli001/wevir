// SPDX-License-Identifier: MIT
// 改写自 pingdotgg/t3code apps/server/src/environmentTheme.ts（有界文件句柄读取与写后发布）
// 来源提交 6b7027b1f43eebc4c7edf5304236a0775b2d8928
// Copyright (c) 2026 T3 Tools Inc.
// 修改：普通 TypeScript；主题文件夹、素材校验、有效版本快照、原子文件替换与 node:fs 监听。

import { createHash, randomBytes } from 'node:crypto';
import { constants, type FSWatcher, watch } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, readdir, rename, rm } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RESERVED_THEME_IDS,
  THEME_EXAMPLE_IDS,
  THEME_MAX_BYTES,
  THEME_MAX_COUNT,
  ThemeAssetNameSchema,
  type ThemeBackdropStatus,
  type ThemeCreate,
  type ThemeFile,
  ThemeFileSchema,
  ThemeIdSchema,
  type ThemeProblem,
  type ThemeResult,
  type ThemeSave,
  type ThemeSelection,
  type ThemesUpdated,
  themeCssLoadsRemoteFiles,
} from '@wevir/protocol';
import { HostError } from '../errors.js';
import type { FileUrls } from '../file-urls.js';
import { assetLimit, themeProblems, validateAsset } from './validation.js';

interface Entry {
  id: string;
  directory: string;
  readOnly: boolean;
  theme?: ThemeFile;
  revision: string;
  fingerprint: string;
  problems: ThemeProblem[];
  snapshot?: string;
  backdropFailures?: Set<'file' | 'poster'>;
}

function rejected(path: string, message: string): HostError<'INVALID_PARAMS'> {
  return new HostError('INVALID_PARAMS', `${path}: ${message}`, {
    issues: [{ path: path.split('.'), message }],
  });
}
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
const digest = (text: string | Buffer) =>
  createHash('sha256').update(text).digest('hex').slice(0, 24);

async function directory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(`${path}: directory must not be a symbolic link`);
  await chmod(path, 0o700);
}

/** 有界地读同一个普通文件句柄；不跟最后一段链接，也不阻塞在 FIFO 上。 */
export async function readThemeFile(path: string, limit: number): Promise<Buffer> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error(`${path}: regular file required; symbolic links are forbidden`);
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const info = await file.stat();
    if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino)
      throw new Error(`${path}: file changed while opening`);
    if (info.size > limit) throw new Error(`${path}: exceeds ${limit} bytes`);
    const buffer = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await file.stat();
    if (
      offset > limit ||
      offset !== info.size ||
      after.size !== info.size ||
      after.mtimeMs !== info.mtimeMs
    )
      throw new Error(`${path}: file changed while reading`);
    return buffer.subarray(0, offset);
  } finally {
    await file.close();
  }
}

async function atomicWrite(path: string, contents: string | Buffer): Promise<void> {
  const temp = `${path}.tmp-${randomBytes(8).toString('hex')}`;
  try {
    const file = await open(temp, 'wx', 0o600);
    try {
      await file.writeFile(contents);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

export class ThemeService {
  readonly directory: string;
  readonly #hostId: string;
  readonly #urls: FileUrls;
  readonly #onError: (error: unknown) => void;
  readonly #entries = new Map<string, Entry>();
  readonly #listeners = new Set<(change: ThemesUpdated) => void>();
  readonly #watchers = new Map<string, { watcher: FSWatcher; identity?: string }>();
  readonly #directories = new Map<string, string>();
  #activeId: string | null = null;
  #cache = '';
  #timer: ReturnType<typeof setTimeout> | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(options: {
    hostId: string;
    directory: string;
    fileUrls: FileUrls;
    onError: (error: unknown) => void;
  }) {
    this.directory = options.directory;
    this.#hostId = options.hostId;
    this.#urls = options.fileUrls;
    this.#onError = options.onError;
  }

  async load(): Promise<void> {
    await directory(this.directory);
    const cacheRoot = join(this.directory, '.cache');
    await directory(cacheRoot);
    // 只有一个 Host 持有数据目录锁；上次异常退出留下的快照不再有客户端。
    await rm(cacheRoot, { recursive: true });
    await directory(cacheRoot);
    this.#cache = await mkdtemp(join(cacheRoot, 'host-'));
    await this.#refresh();
    try {
      const raw: unknown = JSON.parse(
        (await readThemeFile(join(this.directory, '.active.json'), THEME_MAX_BYTES)).toString(
          'utf8',
        ),
      );
      const id = raw !== null && typeof raw === 'object' && 'id' in raw ? raw.id : null;
      if (typeof id === 'string' && this.#entries.get(id)?.theme) this.#activeId = id;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.#onError(error);
    }
    this.#watchDirectory(
      this.directory,
      process.platform === 'darwin' || process.platform === 'win32',
    );
    this.#syncWatchers();
  }

  #exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(fn);
    this.#queue = result.catch(() => {});
    return result;
  }

  #id(id: string, writable = false): void {
    if (!ThemeIdSchema.safeParse(id).success) throw rejected('id', 'invalid theme ID');
    if (writable && (RESERVED_THEME_IDS as readonly string[]).includes(id))
      throw rejected('id', 'reserved theme ID');
  }

  list() {
    return {
      activeId: this.#activeId,
      directory: this.directory,
      themes: [...this.#entries.values()].map((entry) => ({
        id: entry.id,
        name: entry.theme?.name ?? entry.id,
        revision: entry.revision,
        readOnly: entry.readOnly,
        hasBackdrop: entry.theme?.backdrop !== undefined,
        ...(entry.theme?.colorScheme && { colorScheme: entry.theme.colorScheme }),
        swatches: [
          entry.theme?.light?.background,
          entry.theme?.dark?.background,
          entry.theme?.light?.foreground,
          entry.theme?.dark?.foreground,
        ].filter((color): color is string => color !== undefined),
        problems: this.#problems(entry),
      })),
    };
  }

  #problems(entry: Entry): ThemeProblem[] {
    return [
      ...entry.problems,
      ...[...(entry.backdropFailures ?? [])].map((asset) => ({
        path: `backdrop.${asset}`,
        message: 'Background asset could not be loaded or decoded by a desktop client',
        severity: 'error' as const,
      })),
    ];
  }

  get(id: string, status?: ThemeBackdropStatus): ThemeResult {
    this.#id(id);
    const entry = this.#entries.get(id);
    if (!entry) throw rejected('id', `unknown theme ${id}`);
    if (status && status.revision === entry.revision) {
      const backdrop = entry.theme?.backdrop;
      if (!entry.snapshot || !backdrop?.[status.asset])
        throw rejected('backdropStatus.asset', 'asset does not exist');
      entry.backdropFailures ??= new Set();
      if (status.status === 'failed') entry.backdropFailures.add(status.asset);
      else entry.backdropFailures.delete(status.asset);
    }
    const assets: ThemeResult['assets'] = {};
    const backdrop = entry.theme?.backdrop;
    if (backdrop && entry.snapshot) {
      assets.file = `${this.#urls.issue(entry.snapshot, backdrop.file, { theme: true }).url}?v=${entry.revision}`;
      if (backdrop.kind === 'scene') assets.file += '&theme-scene=1';
      if (backdrop.poster)
        assets.poster = `${this.#urls.issue(entry.snapshot, backdrop.poster, { theme: true }).url}?v=${entry.revision}`;
    }
    return {
      id,
      ...(entry.theme && { theme: structuredClone(entry.theme) }),
      problems: structuredClone(this.#problems(entry)),
      assets,
      revision: entry.revision,
      readOnly: entry.readOnly,
      directory: entry.directory,
    };
  }

  save(input: ThemeSave): Promise<ThemeResult> {
    return this.#exclusive(() => this.#save(input));
  }

  create(input: ThemeCreate): Promise<ThemeResult> {
    return this.#exclusive(async () => {
      this.#id(input.id, true);
      await this.#refresh();
      try {
        await lstat(join(this.directory, input.id));
        throw rejected('id', `theme ${input.id} already exists`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      let theme: ThemeFile;
      let root: string | undefined;
      const source = input.source;
      if ('theme' in source) theme = source.theme;
      else if ('themeId' in source) {
        this.#id(source.themeId);
        const entry = this.#entries.get(source.themeId);
        if (!entry?.theme || entry.problems.some((problem) => problem.severity === 'error'))
          throw rejected('source.themeId', 'theme is missing or invalid');
        theme = structuredClone(entry.theme);
        root = entry.snapshot;
      } else {
        if (!isAbsolute(source.path)) throw rejected('source.path', 'absolute path required');
        try {
          const info = await lstat(source.path);
          if (info.isSymbolicLink()) throw new Error('symbolic links are forbidden');
          if (!info.isDirectory() && extname(source.path).toLowerCase() !== '.json')
            throw new Error('a theme directory or .json file is required');
          root = info.isDirectory() ? source.path : dirname(source.path);
          const parent = await lstat(root);
          if (!parent.isDirectory() || parent.isSymbolicLink())
            throw new Error('theme directory must not be a symbolic link');
          const data = await readThemeFile(
            info.isDirectory() ? join(root, 'theme.json') : source.path,
            THEME_MAX_BYTES,
          );
          theme = ThemeFileSchema.parse(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)),
          );
        } catch (error) {
          throw rejected('source.path', messageOf(error));
        }
      }
      const assets = new Map<string, Buffer>();
      if (theme.backdrop && root) {
        for (const name of [theme.backdrop.file, theme.backdrop.poster]) {
          if (!name || assets.has(name)) continue;
          try {
            assets.set(name, await this.#asset(root, name));
          } catch (error) {
            throw rejected(
              name === theme.backdrop.file ? 'backdrop.file' : 'backdrop.poster',
              messageOf(error),
            );
          }
        }
      }
      return this.#save({ id: input.id, theme }, true, assets);
    });
  }

  async #save(
    input: ThemeSave,
    create = false,
    copiedAssets = new Map<string, Buffer>(),
  ): Promise<ThemeResult> {
    this.#id(input.id, true);
    const parsed = ThemeFileSchema.safeParse(input.theme);
    if (!parsed.success) throw rejected('theme', parsed.error.message);
    const theme = parsed.data;
    if (theme.css && themeCssLoadsRemoteFiles(theme.css))
      throw rejected('css', 'CSS cannot load files; only data: and #id URLs are allowed');
    const problems = themeProblems(theme);
    const refused = problems.find((problem) => problem.severity === 'error');
    if (refused) throw rejected(refused.path, refused.message);
    const text = `${JSON.stringify(theme, null, 2)}\n`;
    if (Buffer.byteLength(text) > THEME_MAX_BYTES)
      throw rejected('theme', `exceeds ${THEME_MAX_BYTES} bytes`);
    await this.#refresh();
    if (
      !this.#entries.has(input.id) &&
      [...this.#entries.values()].filter((entry) => !entry.readOnly).length >= THEME_MAX_COUNT
    )
      throw rejected('id', `maximum ${THEME_MAX_COUNT} themes`);
    const target = join(this.directory, input.id);
    const assets = copiedAssets;
    for (const asset of input.assets ?? []) {
      if (!ThemeAssetNameSchema.safeParse(asset.name).success)
        throw rejected('assets.name', 'invalid filename');
      if (assets.has(asset.name)) throw rejected('assets.name', `duplicate ${asset.name}`);
      if (!isAbsolute(asset.sourcePath))
        throw rejected('assets.sourcePath', 'absolute path required');
      try {
        const data = await readThemeFile(asset.sourcePath, assetLimit(asset.name));
        validateAsset(asset.name, data);
        assets.set(asset.name, data);
      } catch (error) {
        throw rejected('assets', messageOf(error));
      }
    }
    if (theme.backdrop) {
      for (const [name, kind] of [
        [theme.backdrop.file, theme.backdrop.kind],
        [theme.backdrop.poster, 'image'],
      ] as const) {
        if (!name) continue;
        try {
          const data = assets.get(name) ?? (await this.#asset(target, name));
          validateAsset(name, data, kind);
        } catch (error) {
          throw rejected(
            name === theme.backdrop.file ? 'backdrop.file' : 'backdrop.poster',
            messageOf(error),
          );
        }
      }
    }
    if (create) {
      try {
        await mkdir(target, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST')
          throw rejected('id', `theme ${input.id} already exists`);
        throw error;
      }
    } else await directory(target);
    try {
      for (const name of ['theme.json', ...assets.keys()]) {
        try {
          const info = await lstat(join(target, name));
          if (!info.isFile() || info.isSymbolicLink())
            throw rejected(
              name === 'theme.json' ? 'theme' : 'assets',
              `${name}: regular file required; symbolic links are forbidden`,
            );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      // JSON 最后替换，读者不会看到尚未复制完的素材；运行中的界面使用上一份校验好的快照。
      for (const [name, data] of assets) await atomicWrite(join(target, name), data);
      await atomicWrite(join(target, 'theme.json'), text);
    } catch (error) {
      if (create) await rm(target, { recursive: true, force: true });
      throw error;
    }
    await this.#refresh();
    return this.get(input.id);
  }

  delete(id: string): Promise<{ deleted: boolean }> {
    return this.#exclusive(async () => {
      this.#id(id, true);
      const target = join(this.directory, id);
      try {
        const info = await lstat(target);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw rejected('id', 'theme directory must not be a symbolic link');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { deleted: false };
        throw error;
      }
      await rm(target, { recursive: true });
      if (this.#activeId === id) await this.#select(null);
      await this.#refresh();
      return { deleted: true };
    });
  }

  setActive(id: string | null, expected?: ThemeSelection): Promise<{ activeId: string | null }> {
    return this.#exclusive(async () => {
      await this.#refresh();
      if (expected && (expected.hostId !== this.#hostId || expected.activeId !== this.#activeId))
        return { activeId: this.#activeId };
      if (id !== null) {
        this.#id(id);
        const entry = this.#entries.get(id);
        if (!entry?.theme || entry.problems.some((problem) => problem.severity === 'error'))
          throw rejected('id', `theme ${id} is missing or invalid`);
      }
      await this.#select(id);
      return { activeId: this.#activeId };
    });
  }

  async #select(id: string | null): Promise<void> {
    await atomicWrite(join(this.directory, '.active.json'), `${JSON.stringify({ id })}\n`);
    if (this.#activeId === id) return;
    this.#activeId = id;
    this.#emit();
  }

  watch(listener: (change: ThemesUpdated) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(): void {
    const update = {
      activeId: this.#activeId,
      revisions: Object.fromEntries([...this.#entries].map(([id, entry]) => [id, entry.revision])),
    };
    for (const listener of this.#listeners) listener(update);
  }

  async #asset(root: string, name: string): Promise<Buffer> {
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(`${root}: symbolic links are forbidden`);
    return readThemeFile(join(root, name), assetLimit(name));
  }

  async #refresh(): Promise<void> {
    if (this.#closed) return;
    const names = (await readdir(this.directory))
      .filter(
        (name) =>
          ThemeIdSchema.safeParse(name).success &&
          !(RESERVED_THEME_IDS as readonly string[]).includes(name),
      )
      .sort()
      .slice(0, THEME_MAX_COUNT);
    this.#directories.clear();
    let changed = false;
    const sources = [
      ...THEME_EXAMPLE_IDS.map((id) => ({
        id,
        root: fileURLToPath(new URL(`./theme-examples/${id}/`, import.meta.url)),
        readOnly: true,
      })),
      ...names.map((id) => ({ id, root: join(this.directory, id), readOnly: false })),
    ];
    for (const { id, root, readOnly } of sources) {
      const previous = this.#entries.get(id);
      let fingerprint = '';
      let snapshot: string | undefined;
      try {
        const info = await lstat(root);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new Error('theme directory must not be a symbolic link');
        if (!readOnly) this.#directories.set(root, `${info.dev}:${info.ino}`);
        const files = (await readdir(root))
          .filter((name) => !/\.tmp-[0-9a-f]{16}$/.test(name))
          .sort();
        const signature: string[] = [];
        for (const name of files) {
          const stat = await lstat(join(root, name));
          signature.push(
            `${name}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
          );
          if (stat.isSymbolicLink()) throw new Error(`${name}: symbolic links are forbidden`);
        }
        fingerprint = digest(signature.join('\n'));
        if (previous?.fingerprint === fingerprint) continue;
        const data = await readThemeFile(join(root, 'theme.json'), THEME_MAX_BYTES);
        const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
        const parsed = ThemeFileSchema.safeParse(raw);
        if (!parsed.success)
          throw new Error(
            parsed.error.issues
              .map((issue) => `${issue.path.join('.') || 'theme'}: ${issue.message}`)
              .join('\n'),
          );
        const theme = parsed.data;
        const problems = themeProblems(theme);
        const errors = problems.filter((problem) => problem.severity === 'error');
        if (errors.length) throw new Error(errors.map((p) => `${p.path}: ${p.message}`).join('\n'));
        const assets = new Map<string, Buffer>();
        if (theme.backdrop) {
          for (const [name, kind] of [
            [theme.backdrop.file, theme.backdrop.kind],
            [theme.backdrop.poster, 'image'],
          ] as const) {
            if (!name) continue;
            const asset = await this.#asset(root, name);
            validateAsset(name, asset, kind);
            assets.set(name, asset);
          }
        }
        const hash = createHash('sha256').update(data);
        for (const [name, data] of assets) hash.update(name).update(data);
        const revision = hash.digest('hex').slice(0, 24);
        if (assets.size) {
          snapshot = await mkdtemp(join(this.#cache, `${id}-`));
          for (const [name, data] of assets) await atomicWrite(join(snapshot, name), data);
        }
        this.#entries.set(id, {
          id,
          directory: root,
          readOnly,
          theme,
          problems,
          fingerprint,
          revision,
          ...(snapshot && { snapshot }),
        });
        if (previous?.snapshot) await rm(previous.snapshot, { recursive: true, force: true });
        changed = true;
      } catch (error) {
        if (snapshot) await rm(snapshot, { recursive: true, force: true });
        const problems: ThemeProblem[] = [
          { path: 'theme.json', message: messageOf(error), severity: 'error' },
        ];
        const revision = digest(`${fingerprint}:${JSON.stringify(problems)}`);
        this.#entries.set(id, {
          ...previous,
          id,
          directory: root,
          readOnly,
          problems,
          revision,
          fingerprint,
          backdropFailures: previous?.revision === revision ? previous.backdropFailures : undefined,
        });
        if (previous?.revision !== revision) changed = true;
      }
    }
    for (const [id, entry] of this.#entries) {
      if (entry.readOnly || names.includes(id)) continue;
      if (entry.snapshot) await rm(entry.snapshot, { recursive: true, force: true });
      this.#entries.delete(id);
      changed = true;
    }
    if (this.#activeId !== null && !this.#entries.has(this.#activeId)) await this.#select(null);
    this.#syncWatchers();
    if (changed) this.#emit();
  }

  #watchDirectory(path: string, recursive = false, identity?: string): void {
    if (this.#closed) return;
    const previous = this.#watchers.get(path);
    if (previous && previous.identity === identity) return;
    previous?.watcher.close();
    const watcher = watch(path, { recursive }, (_event, filename) => {
      const parts = filename?.toString().split(/[/\\]/) ?? [];
      if (
        parts[0] === '.cache' ||
        parts[0] === '.active.json' ||
        parts.some((name) => /\.tmp-[0-9a-f]{16}$/.test(name))
      )
        return;
      clearTimeout(this.#timer);
      this.#timer = setTimeout(() => {
        void this.#exclusive(() => this.#refresh()).catch(this.#onError);
      }, 150);
      this.#timer.unref();
    });
    watcher.on('error', this.#onError);
    this.#watchers.set(path, { watcher, ...(identity !== undefined && { identity }) });
  }

  #syncWatchers(): void {
    if (process.platform !== 'linux' || this.#closed) return;
    for (const [path, { watcher }] of this.#watchers) {
      if (path === this.directory || this.#directories.has(path)) continue;
      watcher.close();
      this.#watchers.delete(path);
    }
    for (const [path, identity] of this.#directories) this.#watchDirectory(path, false, identity);
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#timer);
    for (const { watcher } of this.#watchers.values()) watcher.close();
    this.#watchers.clear();
    this.#listeners.clear();
    await this.#queue;
    if (this.#cache) await rm(this.#cache, { recursive: true, force: true });
  }
}
