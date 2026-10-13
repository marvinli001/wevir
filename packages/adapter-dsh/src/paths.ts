import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/** 本包锁定的 dsh 版本（package.json 的 `dependencies`，ADR-0001 §1）。 */
export const DSH_VERSION = '0.2.1-alpha.2';

const DSH_PACKAGE = '@deepseek-ai/dsh';

export interface DshEntry {
  /** dsh 可执行入口（`lib/bin.js`）的绝对路径，用 Node 运行。 */
  entry: string;
  /** 实际解析到的 dsh 版本。 */
  version: string;
}

/**
 * 从本包的依赖里解析 dsh 的可执行入口：读 `@deepseek-ai/dsh/package.json` 的 `bin.dsh`。
 * 不查 PATH，也不碰用户自己全局安装的 dsh。版本与 `DSH_VERSION` 不一致时报错（lockfile 被改过）。
 *
 * `from` 是解析的起点（默认本模块），测试用它模拟“依赖没装上”。
 */
export function resolveDshEntry(from: string | URL = import.meta.url): DshEntry {
  const require = createRequire(from);
  let manifestPath: string;
  try {
    manifestPath = require.resolve(`${DSH_PACKAGE}/package.json`);
  } catch (error) {
    throw new Error(
      `找不到 ${DSH_PACKAGE}：packages/adapter-dsh 的依赖没有装好，先运行 pnpm install`,
      { cause: error },
    );
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    version?: unknown;
    bin?: unknown;
  };
  if (manifest.version !== DSH_VERSION) {
    throw new Error(
      `${DSH_PACKAGE} 的版本是 ${String(manifest.version)}，适配器锁定的是 ${DSH_VERSION}（${manifestPath}）`,
    );
  }
  const bin =
    typeof manifest.bin === 'string'
      ? manifest.bin
      : (manifest.bin as Record<string, unknown> | undefined)?.dsh;
  if (typeof bin !== 'string') {
    throw new Error(`${DSH_PACKAGE} 的 package.json 没有 bin.dsh（${manifestPath}）`);
  }
  const entry = resolve(dirname(manifestPath), bin);
  if (!existsSync(entry)) throw new Error(`dsh 可执行入口不存在：${entry}`);
  return { entry, version: manifest.version };
}

/** Wevir 数据目录里 dsh 用到的两个目录（ADR-0001 §4）。 */
export interface DshPaths {
  /** `DSH_HOME`，也是 dsh 进程的 cwd：`<数据目录>/engines/dsh`。 */
  dshHome: string;
  /**
   * `DSH_AGENTS_HOME`：`<数据目录>/engines/dsh-agents`，Wevir 专属的空目录。dsh 会把其中的
   * `skills/` 与 `AGENTS.md` 放进每个会话（默认是用户的 `~/.agents`），骨架阶段隔离
   * （ADR-0001 未决事项 2）。不放在 `DSH_HOME` 里，`DSH_HOME` 只装 dsh 自己写的东西。
   */
  agentsHome: string;
}

/** 由 Wevir 数据目录得出 dsh 的目录。数据目录必须是绝对路径。 */
export function dshPaths(wevirHome: string): DshPaths {
  if (!isAbsolute(wevirHome)) throw new Error(`数据目录必须是绝对路径：${wevirHome}`);
  const engines = join(resolve(wevirHome), 'engines');
  return { dshHome: join(engines, 'dsh'), agentsHome: join(engines, 'dsh-agents') };
}

/**
 * 建好 dsh 需要的目录（0700，已存在则只收紧权限，不动内容）。dsh 进程的 cwd 是 `DSH_HOME`，
 * 目录不存在时 spawn 直接报 `ENOENT`（T0.3 §10）；其余内容（`profiles/acp`、`sessions/` 等）
 * 由 dsh 首次启动时自己生成。
 */
export function prepareDshHome(paths: DshPaths): DshPaths {
  for (const dir of [paths.dshHome, paths.agentsHome]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir 的 mode 受 umask 影响，且对已存在的目录不生效。Windows 上 chmod 只影响只读位，无害。
    chmodSync(dir, 0o700);
  }
  return paths;
}
