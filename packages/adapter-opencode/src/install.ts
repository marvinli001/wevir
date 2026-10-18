// SPDX-License-Identifier: MIT
// Wevir 替用户装 `opencode`（opencode-event-mapping.md §2.3，`account.install`）：从 npm registry 下载平台包
// `opencode-<系统>-<架构>[-baseline][-musl]`，tgz 里只有一个原生程序，下载与解出走 runtime-adapter 的 `NpmPackageInstaller`
// （别的订阅引擎的平台包同一套）。选哪个变体要先查 CPU 有没有 AVX2（异步，Windows 上要问 PowerShell），所以安装器在真正
// 下载时才建；`active()`（读指针）不依赖变体，随时可读。

import path from 'node:path';
import {
  type ManagedExecutable,
  NpmInstallCancelled,
  type NpmInstallProgress,
  NpmPackageInstaller,
  type NpmPackageInstallerOptions,
  type NpmPackageSpec,
} from '@wevir/runtime-adapter/npm-package';
import { detectAvx2, type OpenCodePackageTarget, openCodeNpmPackage } from './executable.js';

/** runtime 与账号用到的安装器接口（`NpmPackageInstaller` 满足它）。 */
export interface ManagedInstaller {
  readonly installing: boolean;
  /** 已装好的程序；没装时 undefined。 */
  active(): Promise<ManagedExecutable | undefined>;
  install(onProgress: (progress: NpmInstallProgress) => void): Promise<ManagedExecutable>;
  cancel(): void;
}

export interface OpenCodeInstallerOptions {
  /** 安装根目录（`<数据目录>/engines/opencode/runtime`）。 */
  directory: string;
  /** 启动下载来的程序并核对能用；抛错即校验失败。 */
  validate: NonNullable<NpmPackageInstallerOptions['validate']>;
  platform?: NodeJS.Platform;
  arch?: string;
  /** 测试用：替换 AVX2 与 musl 的探测。 */
  target?: () => Promise<OpenCodePackageTarget>;
  /** 测试用：registry、fetch 与超时等传给 `NpmPackageInstaller` 的选项。 */
  npm?: Partial<Omit<NpmPackageInstallerOptions, 'directory' | 'spec' | 'validate'>>;
}

/** 本平台有没有 Wevir 能下载的 opencode 构建。 */
export function openCodeInstallSupported(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): boolean {
  return openCodeNpmPackage({ platform, arch }) !== undefined;
}

export class OpenCodeInstaller implements ManagedInstaller {
  readonly #options: OpenCodeInstallerOptions;
  #running: Promise<ManagedExecutable> | undefined;
  #abort: AbortController | undefined;
  #current: NpmPackageInstaller | undefined;

  constructor(options: OpenCodeInstallerOptions) {
    this.#options = options;
  }

  get installing(): boolean {
    return this.#running !== undefined;
  }

  async active(): Promise<ManagedExecutable | undefined> {
    // 指针与程序文件名不随变体变，所以用哪个包名都读得到同一份。
    const spec = this.#spec({ musl: false, avx2: true });
    if (spec === undefined) return undefined;
    return new NpmPackageInstaller({ directory: this.#options.directory, spec }).active();
  }

  install(onProgress: (progress: NpmInstallProgress) => void): Promise<ManagedExecutable> {
    if (this.#running !== undefined) return this.#running;
    const run = this.#install(onProgress).finally(() => {
      if (this.#running === run) this.#running = undefined;
      this.#abort = undefined;
      this.#current = undefined;
    });
    this.#running = run;
    return run;
  }

  cancel(): void {
    this.#abort?.abort();
    this.#current?.cancel();
  }

  async #install(onProgress: (progress: NpmInstallProgress) => void): Promise<ManagedExecutable> {
    const abort = new AbortController();
    this.#abort = abort;
    onProgress({ phase: 'resolving', completedBytes: 0 });
    const options = this.#options;
    const platform = options.platform ?? process.platform;
    const arch = options.arch ?? process.arch;
    const target = options.target
      ? await options.target()
      : { avx2: await detectAvx2(platform, arch) };
    if (abort.signal.aborted) throw new NpmInstallCancelled('Installation cancelled.');
    const spec = this.#spec(target);
    if (spec === undefined) {
      throw new Error(`Wevir has no opencode build for ${platform}-${arch}`);
    }
    const installer = new NpmPackageInstaller({
      directory: options.directory,
      spec,
      validate: options.validate,
      ...options.npm,
    });
    this.#current = installer;
    return installer.install(onProgress);
  }

  #spec(target: OpenCodePackageTarget): NpmPackageSpec | undefined {
    return openCodeNpmPackage({
      platform: this.#options.platform ?? process.platform,
      arch: this.#options.arch ?? process.arch,
      ...target,
    });
  }
}

/** 默认的安装目录：引擎目录下的 `runtime`。 */
export function openCodeInstallDirectory(engineDir: string): string {
  return path.join(engineDir, 'runtime');
}
