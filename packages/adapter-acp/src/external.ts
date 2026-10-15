import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

// 用户自己装的 ACP 引擎（Grok Build、Gemini CLI，ADR-0005 决策 4 第 ②、③ 行与补记 14）：不随安装包分发，也不在任何
// package.json 里声明（AGENTS.md 规则 2）。这里找它的可执行文件、核对版本；下载与组件目录由组件管理负责，它把装好的目录
// 传进来。Host 由桌面端拉起时继承的是 GUI 的 PATH（macOS 上只有 /usr/bin:/bin:/usr/sbin:/sbin），所以引擎可以再给一组
// 常见的安装目录（`extraDirs`），PATH 里找不到时接着找。

/** 一个外部引擎的可执行文件。 */
export interface ExternalExecutableSpec {
  /** 引擎的显示名，进错误信息（“找不到 Grok Build…”）。 */
  displayName: string;
  /** 可执行文件名，不含扩展名（`grok`、`gemini`）；在组件目录与 PATH 里按它找。 */
  command: string;
  /** 指定可执行文件的环境变量（`WEVIR_GROK_BIN`），开发与测试用，优先于设置里填的路径。 */
  envVar: string;
  /** 找不到时告诉用户怎样安装（官方的安装方式）。 */
  installHint: string;
}

export interface ResolveExecutableOptions {
  /** 设置里填的路径（`engine.setPath`）。 */
  configuredPath?: string;
  /** Wevir 装的组件目录（R9 的 `installedComponentDir`），其中的 `bin/<command>` 或 `<command>`。 */
  componentDir?: string;
  /** PATH 之后再找的目录（官方安装脚本、npm、Homebrew 的常见位置），不存在的跳过。 */
  extraDirs?: readonly string[];
  /** 展开 `~` 用的家目录，默认 `os.homedir()`。 */
  home?: string;
  /** 默认 `process.env`：读 `envVar` 与 `PATH`（Windows 另读 `PATHEXT`）。 */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export type ExecutableSource = 'env' | 'configured' | 'component' | 'path';

export interface ResolvedExecutable {
  path: string;
  source: ExecutableSource;
}

/**
 * 按顺序找：环境变量 → 设置里填的路径（这两个必须是存在的绝对路径，`~/` 开头的按家目录展开，否则报错，不悄悄换别处的）
 * → 组件目录 → PATH → `extraDirs`。找不到时抛错，错误里写明找过哪里与安装方式。不碰引擎自己的安装器，也不修改用户的
 * shell 配置。
 */
export function resolveExternalExecutable(
  spec: ExternalExecutableSpec,
  options: ResolveExecutableOptions = {},
): ResolvedExecutable {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const explicit: Array<[ExecutableSource, string | undefined, string]> = [
    ['env', env[spec.envVar], spec.envVar],
    ['configured', options.configuredPath, '设置里填的路径'],
  ];
  for (const [source, raw, label] of explicit) {
    const trimmed = raw?.trim();
    if (trimmed === undefined || trimmed === '') continue;
    const value =
      trimmed === '~' || trimmed.startsWith('~/')
        ? join(options.home ?? homedir(), trimmed.slice(1))
        : trimmed;
    if (!isAbsolute(value)) throw new Error(`${label}必须是绝对路径：${value}`);
    if (!isExecutableFile(value, platform)) {
      throw new Error(`${label}指向的文件不存在或不能执行：${value}`);
    }
    return { path: value, source };
  }
  const names = candidateNames(spec.command, platform, env);
  if (options.componentDir !== undefined) {
    for (const dir of [join(options.componentDir, 'bin'), options.componentDir]) {
      const found = findIn(dir, names, platform);
      if (found !== undefined) return { path: found, source: 'component' };
    }
  }
  const dirs = [
    ...(env.PATH ?? env.Path ?? '').split(delimiter).filter((dir) => dir !== ''),
    ...(options.extraDirs ?? []),
  ];
  for (const dir of dirs) {
    const found = findIn(dir, names, platform);
    if (found !== undefined) return { path: found, source: 'path' };
  }
  throw new Error(
    `找不到 ${spec.displayName}（${spec.command}）：没有设 ${spec.envVar}、设置里没填路径` +
      `${options.componentDir === undefined ? '' : '、组件目录里没有'}，PATH` +
      `${options.extraDirs === undefined || options.extraDirs.length === 0 ? '' : '与常见的安装目录'}里也没有。` +
      spec.installHint,
  );
}

/** Windows 上按 PATHEXT 补扩展名（npm 装的 CLI 是 `.cmd`）；其他平台只有原名。 */
function candidateNames(command: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv) {
  if (platform !== 'win32') return [command];
  const exts = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext !== '');
  return [...exts.map((ext) => `${command}${ext.toLowerCase()}`), command];
}

function findIn(dir: string, names: readonly string[], platform: NodeJS.Platform) {
  for (const name of names) {
    const candidate = join(dir, name);
    if (isExecutableFile(candidate, platform)) return candidate;
  }
  return undefined;
}

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== 'win32') accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 版本号的比较：只看数字的 `主.次.修订`，后缀（`-beta.1`）忽略。 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => (v.match(/\d+/g) ?? []).slice(0, 3).map(Number);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i += 1) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

export interface VersionPolicy {
  /** 低于它就不用（ACP 行为差太多，或缺 Wevir 依赖的能力）。 */
  minimum: string;
  /** 本适配器核实过的版本（codex-notes §9）。不同只记一次告警。 */
  tested: string;
}

export interface CheckedVersion {
  version: string;
  /** 与核实过的版本相同。 */
  tested: boolean;
}

/** `--version` 的时限：Node 写的 CLI 冷启动要加载整个 bundle（Gemini CLI 约 1 s），留足余量。 */
export const EXTERNAL_VERSION_TIMEOUT_MS = 20_000;

/**
 * 跑 `<path> [...args] --version`，用 `parse` 取出版本号，与 `policy` 比较：低于最低版本或看不懂输出时报错。`env` 是
 * 子进程环境（白名单构造，不带 Key）。
 */
export function checkExternalVersion(input: {
  displayName: string;
  path: string;
  args?: readonly string[];
  env: NodeJS.ProcessEnv;
  parse: (output: string) => string | undefined;
  policy: VersionPolicy;
  timeoutMs?: number;
}): Promise<CheckedVersion> {
  const { displayName, path, policy } = input;
  return new Promise((resolve, reject) => {
    execFile(
      path,
      [...(input.args ?? []), '--version'],
      {
        env: input.env,
        timeout: input.timeoutMs ?? EXTERNAL_VERSION_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`运行 ${path} --version 失败：${error.message}`, { cause: error }));
          return;
        }
        const output = `${String(stdout)}\n${String(stderr)}`.trim();
        const version = input.parse(output);
        if (version === undefined) {
          reject(new Error(`看不懂 ${path} --version 的输出：${output.slice(0, 200)}`));
        } else if (compareVersions(version, policy.minimum) < 0) {
          reject(
            new Error(
              `${displayName} 的版本是 ${version}，Wevir 要求至少 ${policy.minimum}（${path}）；请升级`,
            ),
          );
        } else {
          resolve({ version, tested: compareVersions(version, policy.tested) === 0 });
        }
      },
    );
  });
}
