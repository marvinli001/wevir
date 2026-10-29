// 办公文档的高保真预览（0.138.0，Host 功能 `office_preview`）：`office.*` 管预览引擎的下载与删除，`workspace.officePdf` 把文件转成
// PDF。引擎是按需下载的 LibreOffice（engine.ts）；转换照上游的要求在私有目录里进行：先把源文件复制进 `work/<随机>/`（转换期间源文件
// 被改也不影响），转出的 PDF 改名进 `pdf/` 缓存。缓存按文件的 realpath、大小、修改时间与引擎版本命名，同一份文件只转一次；同时来的
// 同一份文件共用一次转换。缓存有总量上限，按最近使用的时间淘汰。引擎的转换器闲置一段时间后释放（每次转换本来就起新的引擎进程，
// 转换器留着的只是字体索引）。

import { createHash, randomBytes } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { type MethodResult, OFFICE_PDF_EXTENSIONS, type OfficeEngineStatus } from '@wevir/protocol';
import {
  type NpmClosureInstallation,
  NpmClosureInstaller,
} from '@wevir/runtime-adapter/npm-closure';
import { NpmInstallCancelled } from '@wevir/runtime-adapter/npm-package';
import { sizeOf } from '../dir-size.js';
import {
  OFFICE_ENGINE_NAME,
  OFFICE_ENGINE_REQUIRED_SPACE,
  OFFICE_KIT_PACKAGE,
  OFFICE_KIT_VERSION,
  type OfficeEngineBackend,
  officeEngineBackend,
  officeEngineDownloadBytes,
  officeEnginePackages,
} from './engine.js';

/** 引擎的 Node API 里用到的部分（`@deepseek-ai/libreoffice-kit` 的 createConverter）。 */
export interface OfficeKit {
  createConverter(options: {
    timeoutMs?: number;
    fontMetadataCacheDirectory?: string | false;
  }): Promise<OfficeConverter>;
}

export interface OfficeConverter {
  render(
    request: { inputPath: string; outputPath: string },
    options?: { signal?: AbortSignal },
  ): Promise<{ missingFonts: string[]; pageCount?: number }>;
  dispose(): Promise<void>;
}

/** 转不出来：`reason` 是 `workspace.officePdf` 的 `unavailable`。 */
export class OfficeConversionFailed extends Error {
  override readonly name = 'OfficeConversionFailed';
  constructor(
    readonly reason:
      | 'engine_missing'
      | 'unsupported'
      | 'too_large'
      | 'invalid_document'
      | 'timeout'
      | 'failed',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** 一次转换的结果：`file` 是缓存目录（`pdfDirectory`）里的文件名。 */
export interface OfficePdf {
  file: string;
  pageCount?: number;
  missingFonts: string[];
}

export interface OfficeServiceOptions {
  /** `<数据目录>/office`：下面是 `engine/`、`pdf/`、`work/` 与 `fonts/`。 */
  directory: string;
  platform?: NodeJS.Platform;
  arch?: string;
  /** 测试用：换掉安装器（默认从 npm registry 下载本平台的包）。 */
  installer?: NpmClosureInstaller;
  /** 测试用：换掉加载引擎 API 的方式（默认从装好的目录 import）。 */
  loadKit?: (installation: NpmClosureInstallation) => Promise<OfficeKit>;
  /** 转换器闲置多久释放（毫秒）。 */
  idleMs?: number;
  /** 一次转换的时限（毫秒）。 */
  timeoutMs?: number;
  /** 缓存的总字节上限。 */
  cacheMaxBytes?: number;
  /** 缓存的文件数上限。 */
  cacheMaxEntries?: number;
  onWarning?: (message: string, fields?: Record<string, unknown>) => void;
}

/** 源文件的字节上限（上游默认 64 MiB）。 */
export const OFFICE_INPUT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_IDLE_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_CACHE_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_CACHE_MAX_ENTRIES = 200;

export class OfficeService {
  readonly #options: OfficeServiceOptions;
  readonly #installer: NpmClosureInstaller;
  readonly #backend: OfficeEngineBackend | undefined;
  readonly #listeners = new Set<(status: OfficeEngineStatus) => void>();
  readonly #pending = new Map<string, Promise<OfficePdf>>();
  readonly #pdfDirectory: string;
  readonly #workDirectory: string;
  #installation: NpmClosureInstallation | undefined;
  #installedBytes: number | undefined;
  #checking: Promise<void> | undefined;
  #converter: Promise<OfficeConverter> | undefined;
  #active = 0;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #disposed = false;

  constructor(options: OfficeServiceOptions) {
    this.#options = options;
    this.#backend = officeEngineBackend(options.platform, options.arch);
    this.#pdfDirectory = path.join(options.directory, 'pdf');
    this.#workDirectory = path.join(options.directory, 'work');
    this.#installer =
      options.installer ??
      new NpmClosureInstaller({
        directory: path.join(options.directory, 'engine'),
        label: 'LibreOffice preview engine',
        main: { name: OFFICE_KIT_PACKAGE, version: OFFICE_KIT_VERSION },
        packages: officeEnginePackages(options.platform, options.arch),
        requiredSpace: OFFICE_ENGINE_REQUIRED_SPACE,
      });
    this.#installer.onChange((event) => {
      if (event.type === 'installed') {
        void this.#adopt(event.installation).then(() => this.#emit());
        return;
      }
      this.#emit();
    });
  }

  /** PDF 缓存目录（`workspace.officePdf` 在这里发流式地址）。 */
  get pdfDirectory(): string {
    return this.#pdfDirectory;
  }

  /** 启动时读一次磁盘：装好的引擎（读完经 `office.changed` 通知）；清掉上次没收尾的转换目录。 */
  init(): Promise<void> {
    const checking = (async () => {
      await fsp.rm(this.#workDirectory, { recursive: true, force: true }).catch(() => {});
      const installation = await this.#installer.active();
      if (installation !== undefined) {
        await this.#adopt(installation);
        this.#emit();
      }
      await this.#prune().catch(() => {});
    })();
    this.#checking = checking.then(
      () => {
        this.#checking = undefined;
      },
      () => {
        this.#checking = undefined;
      },
    );
    return checking;
  }

  watch(listener: (status: OfficeEngineStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  status(): OfficeEngineStatus {
    const status: OfficeEngineStatus = {
      state: 'missing',
      engineName: OFFICE_ENGINE_NAME,
      version: OFFICE_KIT_VERSION,
      downloadBytes: officeEngineDownloadBytes(this.#options.platform, this.#options.arch),
    };
    if (this.#backend === undefined || !this.#installer.supported) {
      status.state = 'unsupported';
      return status;
    }
    status.backend = this.#backend;
    const progress = this.#installer.installing;
    if (progress !== undefined) {
      status.state = 'installing';
      status.progress = progress;
    } else if (this.#installation !== undefined) {
      status.state = 'ready';
      if (this.#installedBytes !== undefined) status.installedBytes = this.#installedBytes;
    } else if (this.#installer.error !== undefined) {
      status.state = 'failed';
      status.error = this.#installer.error;
    }
    return status;
  }

  /** `office.install`：在后台下载引擎，立即返回（`installing`）；进度与结果经 `office.changed` 通知。 */
  install(): MethodResult<'office.install'> {
    if (this.status().state === 'unsupported') return { status: this.status() };
    if (this.#checking !== undefined) {
      void this.#checking.then(() => {
        if (!this.#disposed) this.install();
      });
      return { status: this.status() };
    }
    if (this.#installation === undefined && this.#installer.installing === undefined) {
      void this.#installer.install().catch((error: unknown) => {
        if (!(error instanceof NpmInstallCancelled)) {
          this.#options.onWarning?.('office preview engine install failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });
    }
    return { status: this.status() };
  }

  cancelInstall(): MethodResult<'office.cancelInstall'> {
    this.#installer.cancel();
    return { status: this.status() };
  }

  /** `office.uninstall`：释放转换器、删掉引擎、PDF 缓存与字体索引。 */
  async uninstall(): Promise<MethodResult<'office.uninstall'>> {
    await this.#releaseConverter();
    this.#installation = undefined;
    this.#installedBytes = undefined;
    await this.#installer.uninstall();
    await fsp.rm(this.#pdfDirectory, { recursive: true, force: true }).catch(() => {});
    await fsp
      .rm(path.join(this.#options.directory, 'fonts'), { recursive: true, force: true })
      .catch(() => {});
    this.#emit();
    return { status: this.status() };
  }

  /**
   * 把 `real`（已核对在目录里的普通文件的 realpath）转成 PDF。同一份文件（realpath、大小与修改时间不变）只转一次，进行中的同一份
   * 文件共用一次转换。失败抛 `OfficeConversionFailed`。
   */
  async convert(source: { real: string; size: number; mtimeMs: number }): Promise<OfficePdf> {
    const extension = path.extname(source.real).slice(1).toLowerCase();
    if (!isOfficePdfExtension(extension)) {
      throw new OfficeConversionFailed('unsupported', 'This file type cannot be converted to PDF.');
    }
    if (source.size > OFFICE_INPUT_MAX_BYTES) {
      throw new OfficeConversionFailed(
        'too_large',
        `Files larger than ${OFFICE_INPUT_MAX_BYTES / 1024 / 1024} MiB cannot be previewed.`,
      );
    }
    if (this.#checking !== undefined) await this.#checking;
    const installation = this.#installation;
    if (installation === undefined) {
      throw new OfficeConversionFailed(
        'engine_missing',
        'The LibreOffice preview engine is not installed.',
      );
    }
    const key = createHash('sha256')
      .update(JSON.stringify([OFFICE_KIT_VERSION, source.real, source.size, source.mtimeMs]))
      .digest('hex')
      .slice(0, 40);
    const cached = await this.#cached(key);
    if (cached !== undefined) return cached;
    let pending = this.#pending.get(key);
    if (pending === undefined) {
      pending = this.#render(installation, key, source.real, extension).finally(() =>
        this.#pending.delete(key),
      );
      this.#pending.set(key, pending);
    }
    return pending;
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#installer.cancel();
    await this.#releaseConverter();
  }

  async #adopt(installation: NpmClosureInstallation): Promise<void> {
    this.#installation = installation;
    this.#installedBytes = await sizeOf(installation.root).catch(() => undefined);
  }

  #emit(): void {
    const status = this.status();
    for (const listener of [...this.#listeners]) {
      try {
        listener(status);
      } catch {
        // 监听器里的错误不影响别的监听器。
      }
    }
  }

  async #cached(key: string): Promise<OfficePdf | undefined> {
    const file = `${key}.pdf`;
    try {
      const meta = JSON.parse(
        await fsp.readFile(path.join(this.#pdfDirectory, `${key}.json`), 'utf8'),
      ) as { pageCount?: unknown; missingFonts?: unknown };
      await fsp.access(path.join(this.#pdfDirectory, file));
      // 最近用过：按修改时间淘汰时排到后面。
      const now = new Date();
      await fsp.utimes(path.join(this.#pdfDirectory, file), now, now).catch(() => {});
      return {
        file,
        ...(typeof meta.pageCount === 'number' && { pageCount: meta.pageCount }),
        missingFonts: Array.isArray(meta.missingFonts)
          ? meta.missingFonts.filter((font): font is string => typeof font === 'string')
          : [],
      };
    } catch {
      return undefined;
    }
  }

  async #render(
    installation: NpmClosureInstallation,
    key: string,
    real: string,
    extension: string,
  ): Promise<OfficePdf> {
    this.#active += 1;
    clearTimeout(this.#idleTimer);
    const work = path.join(this.#workDirectory, randomBytes(8).toString('hex'));
    try {
      await fsp.mkdir(work, { recursive: true, mode: 0o700 });
      await fsp.mkdir(this.#pdfDirectory, { recursive: true, mode: 0o700 });
      const input = path.join(work, `input.${extension}`);
      const output = path.join(work, 'output.pdf');
      await fsp.copyFile(real, input);
      const converter = await this.#converterFor(installation);
      let result: { missingFonts: string[]; pageCount?: number };
      try {
        result = await converter.render({ inputPath: input, outputPath: output });
      } catch (error) {
        throw conversionFailure(error, this.#options.platform ?? process.platform);
      }
      const file = `${key}.pdf`;
      const missingFonts = [...new Set(result.missingFonts)].slice(0, 64);
      await fsp.rename(output, path.join(this.#pdfDirectory, file));
      await fsp.writeFile(
        path.join(this.#pdfDirectory, `${key}.json`),
        JSON.stringify({ pageCount: result.pageCount, missingFonts }),
        { mode: 0o600 },
      );
      void this.#prune().catch(() => {});
      return {
        file,
        ...(result.pageCount !== undefined && { pageCount: result.pageCount }),
        missingFonts,
      };
    } finally {
      await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
      this.#active -= 1;
      if (this.#active === 0) this.#armIdle();
    }
  }

  #converterFor(installation: NpmClosureInstallation): Promise<OfficeConverter> {
    if (this.#converter === undefined) {
      const load = this.#options.loadKit ?? loadInstalledKit;
      const creating = load(installation)
        .then((kit) =>
          kit.createConverter({
            timeoutMs: this.#options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            fontMetadataCacheDirectory: path.join(this.#options.directory, 'fonts'),
          }),
        )
        .catch((error: unknown) => {
          if (this.#converter === creating) this.#converter = undefined;
          throw conversionFailure(error, this.#options.platform ?? process.platform);
        });
      this.#converter = creating;
    }
    return this.#converter;
  }

  #armIdle(): void {
    clearTimeout(this.#idleTimer);
    if (this.#converter === undefined) return;
    this.#idleTimer = setTimeout(() => {
      if (this.#active === 0) void this.#releaseConverter();
    }, this.#options.idleMs ?? DEFAULT_IDLE_MS);
    this.#idleTimer.unref?.();
  }

  async #releaseConverter(): Promise<void> {
    clearTimeout(this.#idleTimer);
    const converter = this.#converter;
    this.#converter = undefined;
    if (converter === undefined) return;
    try {
      await (await converter).dispose();
    } catch {
      // 没建成或已经坏了的转换器不用再释放。
    }
  }

  /** 缓存超过上限时按修改时间（最近用过的会更新它）删掉最旧的。 */
  async #prune(): Promise<void> {
    const maxBytes = this.#options.cacheMaxBytes ?? DEFAULT_CACHE_MAX_BYTES;
    const maxEntries = this.#options.cacheMaxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
    const entries: { key: string; bytes: number; mtimeMs: number }[] = [];
    for (const name of await fsp.readdir(this.#pdfDirectory).catch(() => [])) {
      if (!name.endsWith('.pdf')) continue;
      const stats = await fsp.stat(path.join(this.#pdfDirectory, name)).catch(() => undefined);
      if (stats !== undefined) {
        entries.push({ key: name.slice(0, -4), bytes: stats.size, mtimeMs: stats.mtimeMs });
      }
    }
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let bytes = 0;
    for (const [index, entry] of entries.entries()) {
      bytes += entry.bytes;
      if (index < maxEntries && bytes <= maxBytes) continue;
      await fsp.rm(path.join(this.#pdfDirectory, `${entry.key}.pdf`), { force: true });
      await fsp.rm(path.join(this.#pdfDirectory, `${entry.key}.json`), { force: true });
    }
  }
}

/** 扩展名（小写、不带点）能不能转成 PDF。 */
export function isOfficePdfExtension(extension: string): boolean {
  return OFFICE_PDF_EXTENSION_SET.has(extension);
}

const OFFICE_PDF_EXTENSION_SET: ReadonlySet<string> = new Set(OFFICE_PDF_EXTENSIONS);

/** 从装好的目录加载引擎的 Node API；它按 Node 的解析规则在同一个 node_modules 里找本平台的引擎包。 */
async function loadInstalledKit(installation: NpmClosureInstallation): Promise<OfficeKit> {
  const entry = path.join(
    installation.root,
    'node_modules',
    ...OFFICE_KIT_PACKAGE.split('/'),
    'lib',
    'index.js',
  );
  return (await import(pathToFileURL(entry).href)) as OfficeKit;
}

/** 引擎的 `ConversionError.code` 归到 `workspace.officePdf` 的 `unavailable`。 */
function conversionFailure(error: unknown, platform: NodeJS.Platform): OfficeConversionFailed {
  if (error instanceof OfficeConversionFailed) return error;
  const code = (error as { code?: unknown } | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);
  switch (code) {
    case 'input-too-large':
    case 'output-too-large':
      return new OfficeConversionFailed('too_large', message, { cause: error });
    case 'invalid-document':
    case 'invalid-output':
      return new OfficeConversionFailed('invalid_document', message, { cause: error });
    case 'unsupported-format':
      return new OfficeConversionFailed('unsupported', message, { cause: error });
    case 'timeout':
      return new OfficeConversionFailed('timeout', message, { cause: error });
    case 'unavailable':
      // 装好的引擎起不来：Windows 上多半是缺 Visual C++ 运行库（上游不带它），Linux 上多半是没有可用的字体。
      return new OfficeConversionFailed(
        'failed',
        platform === 'win32'
          ? `${message} Install the Microsoft Visual C++ Redistributable (v14) and try again.`
          : message,
        { cause: error },
      );
    default:
      return new OfficeConversionFailed('failed', message, { cause: error });
  }
}
