import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 本包锁定的 Codex 版本（ADR-0005 决策 1.2）：与 docs/upstream/upstream.lock 的 codex 行、scripts/fetch-codex.sh
 * 的 `version` 一致。启动前用 `codex-app-server --version` 核对（`checkCodexVersion`）。
 */
export const CODEX_VERSION = 'rust-v0.162.1';

/** 指定 codex-app-server 可执行文件的环境变量，优先于资源目录与开发缓存。 */
export const CODEX_BIN_ENV = 'WEVIR_CODEX_BIN';

/**
 * 应用资源目录的环境变量（ADR-0007 决策 5）：安装包随附的运行时所在的目录，桌面端拉起 Host 时设置（打包后是
 * Electron 的 `process.resourcesPath`）。codex-app-server 在它的 `engines/codex/` 下。
 */
export const RESOURCES_DIR_ENV = 'WEVIR_RESOURCES_DIR';

/** 资源目录里放 codex-app-server（以及 Linux 的 `codex-resources/bwrap`、LICENSE、NOTICE）的子目录。 */
export function resourcesCodexDir(resourcesDir: string): string {
  return join(resourcesDir, 'engines', 'codex');
}

/** 下载开发缓存里的二进制的命令（在仓库根目录运行）。 */
export const FETCH_CODEX_COMMAND = 'bash scripts/fetch-codex.sh';

/** codex-app-server 的文件名。 */
export function codexBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'codex-app-server.exe' : 'codex-app-server';
}

/**
 * 开发缓存目录：仓库根的 `.wevir-dev/bin/`（gitignore），`scripts/fetch-codex.sh` 下载到这里。`src/` 与 `dist/`
 * 都在包目录下一层，所以同一个相对路径对两者都成立。安装包里的位置是资源目录（`RESOURCES_DIR_ENV`）。
 */
export function devBinDir(): string {
  return fileURLToPath(new URL('../../../.wevir-dev/bin/', import.meta.url));
}

export interface ResolveCodexBinaryOptions {
  /** 默认 `process.env`。 */
  env?: NodeJS.ProcessEnv;
  /** 默认 `devBinDir()`。 */
  devDir?: string;
  platform?: NodeJS.Platform;
}

/**
 * 找 codex-app-server：`WEVIR_CODEX_BIN`（必须是存在的绝对路径）→ 应用资源目录（`WEVIR_RESOURCES_DIR` 的
 * `engines/codex/`，安装包随附的那份）→ 开发缓存。不查 PATH，也不碰用户自己装的 Codex。找不到时报错并给出下载命令。
 * 版本在启动前另行核对（`checkCodexVersion`）。
 */
export function resolveCodexBinary(options: ResolveCodexBinaryOptions = {}): string {
  const env = options.env ?? process.env;
  const fromEnv = env[CODEX_BIN_ENV];
  if (fromEnv !== undefined && fromEnv !== '') {
    if (!isAbsolute(fromEnv)) throw new Error(`${CODEX_BIN_ENV} 必须是绝对路径：${fromEnv}`);
    if (!existsSync(fromEnv)) throw new Error(`${CODEX_BIN_ENV} 指向的文件不存在：${fromEnv}`);
    return fromEnv;
  }
  const name = codexBinaryName(options.platform);
  const candidates: string[] = [];
  const resourcesDir = env[RESOURCES_DIR_ENV];
  if (resourcesDir !== undefined && resourcesDir !== '') {
    if (!isAbsolute(resourcesDir)) {
      throw new Error(`${RESOURCES_DIR_ENV} 必须是绝对路径：${resourcesDir}`);
    }
    candidates.push(join(resourcesCodexDir(resourcesDir), name));
  }
  candidates.push(join(options.devDir ?? devBinDir(), name));
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) {
    throw new Error(
      `找不到 codex-app-server（${CODEX_VERSION}）：先在仓库根目录运行 ${FETCH_CODEX_COMMAND}，` +
        `或用 ${CODEX_BIN_ENV} 指定可执行文件（查找了 ${candidates.join('、')}）`,
    );
  }
  return found;
}

/** `codex-app-server --version` 的输出（`codex-app-server 0.162.1`）里的版本号，带上 tag 的 `rust-v` 前缀。 */
export function parseCodexVersion(output: string): string | undefined {
  const match = /codex-app-server\s+v?(\d+\.\d+\.\d+\S*)/.exec(output);
  return match?.[1] === undefined ? undefined : `rust-v${match[1]}`;
}

/** `--version` 的时限。冷启动中位 49 ms（codex-notes §1），留足余量给杀毒软件扫描等。 */
export const VERSION_CHECK_TIMEOUT_MS = 15_000;

/**
 * 跑 `<binary> --version`，与 `CODEX_VERSION` 不一致时报错（换了二进制或忘了重新下载）。返回核对过的版本。
 * `env` 是子进程环境（白名单构造，不带网关令牌）。
 */
export function checkCodexVersion(
  binary: string,
  env: NodeJS.ProcessEnv,
  /** 放在 `--version` 之前的参数（测试用 node 跑假的 app-server 时是脚本路径）。 */
  binaryArgs: readonly string[] = [],
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      binary,
      [...binaryArgs, '--version'],
      { env, timeout: VERSION_CHECK_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(new Error(`运行 ${binary} --version 失败：${error.message}`, { cause: error }));
          return;
        }
        const version = parseCodexVersion(String(stdout));
        if (version === undefined) {
          reject(new Error(`看不懂 ${binary} --version 的输出：${String(stdout).trim()}`));
        } else if (version !== CODEX_VERSION) {
          reject(
            new Error(
              `codex-app-server 的版本是 ${version}，适配器锁定的是 ${CODEX_VERSION}（${binary}）；` +
                `重新运行 ${FETCH_CODEX_COMMAND}，或让 ${CODEX_BIN_ENV} 指向 ${CODEX_VERSION}`,
            ),
          );
        } else {
          resolvePromise(version);
        }
      },
    );
  });
}

/**
 * 一个 codex-app-server 进程的种类（ADR-0005 补记 10）：`gateway` 承载经网关的 Provider，`chatgpt` 承载 ChatGPT 登录
 * （Codex 内置的 openai Provider 与它自己的模型目录）。两者各有自己的 `CODEX_HOME`。
 */
export type CodexFlavor = 'gateway' | 'chatgpt';

/** Wevir 数据目录里 Codex 用到的目录（ADR-0005 决策 5）。 */
export interface CodexPaths {
  /**
   * `CODEX_HOME`，也是 codex-app-server 进程的 cwd：网关进程是 `<数据目录>/engines/codex`，ChatGPT 进程是
   * `<数据目录>/engines/codex-chatgpt`（登录凭据 `auth.json` 只在这里）。
   */
  codexHome: string;
  /** 生成的配置：`<CODEX_HOME>/config.toml`。 */
  configFile: string;
  /** 生成的模型目录：`<CODEX_HOME>/wevir-models.json`（`model_catalog_json`）。 */
  catalogFile: string;
}

/** 由 Wevir 数据目录得出 Codex 的目录。数据目录必须是绝对路径。 */
export function codexPaths(wevirHome: string, flavor: CodexFlavor = 'gateway'): CodexPaths {
  if (!isAbsolute(wevirHome)) throw new Error(`数据目录必须是绝对路径：${wevirHome}`);
  const codexHome = join(
    resolve(wevirHome),
    'engines',
    flavor === 'chatgpt' ? 'codex-chatgpt' : 'codex',
  );
  return {
    codexHome,
    configFile: join(codexHome, 'config.toml'),
    catalogFile: join(codexHome, 'wevir-models.json'),
  };
}

/**
 * 建好 `CODEX_HOME`（0700，已存在则只收紧权限）。Codex 要求这个目录事先存在
 * （upstream/codex/codex-rs/utils/home-dir/src/lib.rs），进程的 cwd 也是它，不存在时 spawn 报 `ENOENT`。
 */
export function prepareCodexHome(paths: CodexPaths): CodexPaths {
  mkdirSync(paths.codexHome, { recursive: true, mode: 0o700 });
  // mkdir 的 mode 受 umask 影响，且对已存在的目录不生效。Windows 上 chmod 只影响只读位，无害。
  chmodSync(paths.codexHome, 0o700);
  return paths;
}
