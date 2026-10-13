import type { DshPaths } from './paths.js';

/**
 * 从 Host 进程继承给 dsh 的环境变量，白名单以外的一律不传（ADR-0001 §4）。dsh 解析凭据时继承的环境变量
 * 优先级最高（T0.3 §6.3），所以用户 shell 里的 `DEEPSEEK_API_KEY`、`ANTHROPIC_*`、`OPENAI_*`，
 * 用户自己 dsh 的 `DSH_*`，以及会改变 Node 行为的 `NODE_OPTIONS` 都不能漏进去。
 *
 * 留下的只有：找到可执行文件与用户目录、区域与时区、临时目录（`workspace-write` 允许写系统临时目录）、
 * 网络代理与额外 CA（大陆网络，SKELETON_PLAN §2.7），以及 Windows 运行进程必需的系统变量。
 */
export const INHERITED_ENV: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TZ',
  'TMPDIR',
  'TEMP',
  'TMP',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  // Windows
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'PATHEXT',
  'USERPROFILE',
  'USERNAME',
  'USERDOMAIN',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  'CommonProgramW6432',
  'PSModulePath',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
];

/** dsh 增量流式旁路使用的 fd（T3.2a），经 `WEVIR_STREAM_FD` 告知插件（ADR-0001 §3）。 */
export const STREAM_FD = 3;

export interface DshEnvOptions {
  paths: DshPaths;
  /** 继承来源，默认 `process.env`。 */
  parent?: NodeJS.ProcessEnv;
  /** 默认 `process.platform`。Windows 上环境变量名不分大小写。 */
  platform?: NodeJS.Platform;
  /** 打开 fd 3 时设 `WEVIR_STREAM_FD=3`（T3.2a）。 */
  streamFd?: boolean;
  /**
   * 额外注入的变量，例如 T3.4 的 `WEVIR_PROVIDER_<ID>_KEY`（模型 Key 只经这里传给 dsh）。
   * 不能覆盖下面固定注入的变量。
   */
  extra?: Readonly<Record<string, string>>;
}

/**
 * dsh 子进程的完整环境：白名单继承 + 固定注入 + `extra`。固定注入的值：
 * - `DSH_HOME`、`DSH_AGENTS_HOME`：Wevir 专属目录；
 * - `DSH_TELEMETRY_DISABLED=1`：关掉 dsh-base 的 OTel 遥测（任意非空值都算关闭）；
 * - `DSH_PERMISSION_MODE=workspace-write`：与 dsh 当前默认相同，显式写出不依赖默认值；
 * - `NO_COLOR=1`：stderr 只用于诊断，不要控制字符；
 * - `WEVIR_STREAM_FD=3`：仅在 `streamFd` 时。
 */
export function buildDshEnv(options: DshEnvOptions): NodeJS.ProcessEnv {
  const parent = options.parent ?? process.env;
  const caseInsensitive = (options.platform ?? process.platform) === 'win32';
  const norm = (name: string) => (caseInsensitive ? name.toUpperCase() : name);
  const allowed = new Set(INHERITED_ENV.map(norm));

  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && allowed.has(norm(name))) env[name] = value;
  }

  const fixed: Record<string, string> = {
    DSH_HOME: options.paths.dshHome,
    DSH_AGENTS_HOME: options.paths.agentsHome,
    DSH_TELEMETRY_DISABLED: '1',
    DSH_PERMISSION_MODE: 'workspace-write',
    NO_COLOR: '1',
  };
  if (options.streamFd === true) fixed.WEVIR_STREAM_FD = String(STREAM_FD);
  const reserved = new Set(['WEVIR_STREAM_FD', ...Object.keys(fixed)].map(norm));
  for (const [name, value] of Object.entries(options.extra ?? {})) {
    if (reserved.has(norm(name))) throw new TypeError(`不能覆盖 dsh 的固定环境变量 ${name}`);
    env[name] = value;
  }
  return Object.assign(env, fixed);
}
