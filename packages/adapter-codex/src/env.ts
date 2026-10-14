/**
 * 从 Host 进程继承给 codex-app-server 的环境变量，白名单以外的一律不传（ADR-0005 决策 5，与 adapter-dsh 的
 * `env.ts` 同一套做法）。用户 shell 里的 `OPENAI_API_KEY`、`CODEX_API_KEY`、`CODEX_ACCESS_TOKEN`、
 * `CODEX_SQLITE_HOME`、`CODEX_APP_SERVER_MANAGED_CONFIG_PATH` 等都会改变 Codex 的认证与配置，不能漏进去。
 *
 * 模型跑的命令继承 app-server 的环境（`shell_environment_policy.inherit` 默认 all，再排除 `WEVIR_*`），
 * 用户 shell 配置里的其余变量由 Codex 的 shell 快照（登录 shell 读用户的 rc）补上，所以 `HOME` 必须是用户真实的
 * 家目录（docs/architecture/codex-event-mapping.md §1.3）。
 *
 * 留下的只有：找到可执行文件与用户目录、区域与时区、临时目录（`workspace-write` 允许写系统临时目录）、网络代理与
 * 额外 CA（大陆网络），以及 Windows 运行进程必需的系统变量。
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
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
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

/** Codex 给 Wevir Provider 带的令牌所在的环境变量（`[model_providers.*] env_key`）。 */
export const GATEWAY_TOKEN_ENV = 'WEVIR_GATEWAY_TOKEN';

export interface CodexEnvOptions {
  codexHome: string;
  /**
   * 网关令牌（ADR-0005 决策 2.2）。模型 Key 不进 Codex 的环境，只有它；`config.toml` 的
   * `[shell_environment_policy] exclude = ["WEVIR_*"]` 让模型跑的命令看不到它。
   */
  gatewayToken?: string;
  /** 继承来源，默认 `process.env`。 */
  parent?: NodeJS.ProcessEnv;
  /** 默认 `process.platform`。Windows 上环境变量名不分大小写。 */
  platform?: NodeJS.Platform;
  /** 子进程的 `RUST_LOG`，默认 `warn`（stderr 只用于诊断）。 */
  rustLog?: string;
}

/**
 * codex-app-server 子进程的完整环境：白名单继承 + 固定注入。固定注入的值：
 * - `CODEX_HOME`：Wevir 专属目录（决策 5）；
 * - `WEVIR_GATEWAY_TOKEN`：仅在给了令牌时；
 * - `RUST_LOG`：默认 `warn`；
 * - `NO_COLOR=1`：stderr 只用于诊断，不要控制字符。
 */
export function buildCodexEnv(options: CodexEnvOptions): NodeJS.ProcessEnv {
  const parent = options.parent ?? process.env;
  const caseInsensitive = (options.platform ?? process.platform) === 'win32';
  const norm = (name: string) => (caseInsensitive ? name.toUpperCase() : name);
  const allowed = new Set(INHERITED_ENV.map(norm));

  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && allowed.has(norm(name))) env[name] = value;
  }
  const fixed: Record<string, string> = {
    CODEX_HOME: options.codexHome,
    RUST_LOG: options.rustLog ?? 'warn',
    NO_COLOR: '1',
  };
  if (options.gatewayToken !== undefined) fixed[GATEWAY_TOKEN_ENV] = options.gatewayToken;
  return Object.assign(env, fixed);
}
