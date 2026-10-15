// `wevir-host` 的帮助与 stderr 说明（2026-10-15）：中文与英文，选法与 `wevir` 命令行相同——WEVIR_LANG=zh|en
// 优先，否则取 LC_ALL、LC_MESSAGES、LANG 里第一个非空的，zh 开头用中文，其他（含 C / POSIX）用英文。
// Host 的日志、协议里的错误与引擎的原文不在这里，不翻译。

export type HostCliLocale = 'zh' | 'en';

export function hostCliLocale(env: NodeJS.ProcessEnv): HostCliLocale {
  const forced = env.WEVIR_LANG?.trim().toLowerCase();
  if (forced?.startsWith('zh')) return 'zh';
  if (forced?.startsWith('en')) return 'en';
  for (const name of ['LC_ALL', 'LC_MESSAGES', 'LANG'] as const) {
    const value = env[name]?.trim();
    if (value) return /^zh([_.@-]|$)/i.test(value) ? 'zh' : 'en';
  }
  return 'en';
}

export interface HostCliText {
  usage: string;
  seeHelp: string;
  badAdapter(kinds: string, value: string): string;
  badLogLevel(value: string): string;
  badPort(value: string | undefined): string;
  emptyHome: string;
  adapterFailed(adapter: string, error: string): string;
  alreadyRunning(info: { home: string; pid: number; startedAt: string; path: string }): string;
  startFailed(error: string): string;
}

const zh: HostCliText = {
  usage: `用法：wevir-host [选项]

  --home <目录>          数据目录。环境变量 WEVIR_HOME 优先于它；都没有时用平台默认
                         （macOS ~/Library/Application Support/Wevir，Windows %APPDATA%\\Wevir，
                         Linux $XDG_DATA_HOME/wevir）
  --adapter <codex|dsh|echo>
                         引擎适配器，默认 codex：codex-app-server（ADR-0005，二进制见 WEVIR_CODEX_BIN
                         或 bash scripts/fetch-codex.sh）；dsh 是 DeepSeek Harness（可选引擎）；echo 是开发用
                         的假引擎
  --port <端口>          仅调试用，默认 0（系统分配）；客户端一律以 run/host.json 里的 url 为准
  --log-level <级别>     debug | info | warn | error，默认 info；日志写到 <数据目录>/logs/host.log
  --exit-on-stdin-eof    由桌面拉起时使用：拉起方持有 stdin 管道，读到 EOF 即优雅退出
  -h, --help             显示本帮助
  -v, --version          显示版本

退出码：0 正常退出；1 运行失败或退出超时被强制结束；2 参数错误；3 该数据目录已有 Host 在运行。`,
  seeHelp: '运行 wevir-host --help 查看用法。',
  badAdapter: (kinds, value) => `--adapter 只能是 ${kinds}：${value}`,
  badLogLevel: (value) => `--log-level 只能是 debug | info | warn | error：${value}`,
  badPort: (value) => `--port 必须是 0–65535 的整数：${value}`,
  emptyHome: '--home 不能为空',
  adapterFailed: (adapter, error) => `无法创建 ${adapter} 适配器：${error}`,
  alreadyRunning: ({ home, pid, startedAt, path }) =>
    `数据目录 ${home} 已有 Host 在运行（pid ${pid}，启动于 ${startedAt}）。客户端请读取 ${path} 附着到它。`,
  startFailed: (error) => `启动失败：${error}`,
};

const en: HostCliText = {
  usage: `Usage: wevir-host [options]

  --home <dir>           Data directory. WEVIR_HOME takes precedence; without either, the platform default
                         (macOS ~/Library/Application Support/Wevir, Windows %APPDATA%\\Wevir,
                         Linux $XDG_DATA_HOME/wevir)
  --adapter <codex|dsh|echo>
                         Engine adapter, default codex: codex-app-server (ADR-0005; binary from WEVIR_CODEX_BIN
                         or bash scripts/fetch-codex.sh); dsh is the DeepSeek Harness (optional engine); echo is
                         a fake engine for development
  --port <port>          Debugging only, default 0 (system-assigned); clients always use the url in run/host.json
  --log-level <level>    debug | info | warn | error, default info; logs go to <data dir>/logs/host.log
  --exit-on-stdin-eof    Used when launched by the desktop app: the launcher holds the stdin pipe, and EOF
                         triggers a graceful shutdown
  -h, --help             Show this help
  -v, --version          Show the version

Exit codes: 0 normal exit; 1 failure, or forced exit after the shutdown timeout; 2 invalid arguments;
3 a Host is already running for this data directory.`,
  seeHelp: 'Run wevir-host --help for usage.',
  badAdapter: (kinds, value) => `--adapter must be ${kinds}: ${value}`,
  badLogLevel: (value) => `--log-level must be debug | info | warn | error: ${value}`,
  badPort: (value) => `--port must be an integer from 0 to 65535: ${value}`,
  emptyHome: '--home cannot be empty',
  adapterFailed: (adapter, error) => `cannot create the ${adapter} adapter: ${error}`,
  alreadyRunning: ({ home, pid, startedAt, path }) =>
    `a Host is already running for data directory ${home} (pid ${pid}, started ${startedAt}). Clients should read ${path} to attach to it.`,
  startFailed: (error) => `failed to start: ${error}`,
};

export const HOST_CLI_TEXT: Readonly<Record<HostCliLocale, HostCliText>> = { zh, en };
