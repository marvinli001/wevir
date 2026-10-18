// `wevir-host` 的帮助与 stderr 说明（2026-10-15）：中文与英文，选法与 `wevir` 命令行相同——WEVIR_LANG=zh|en
// 优先，否则取 LC_ALL、LC_MESSAGES、LANG 里第一个非空的，zh 开头用中文，其他（含 C / POSIX）用英文。
// Host 的日志、协议里的错误与引擎的原文不在这里，不翻译。
// 文案规则与 apps/cli/src/i18n/zh.ts 开头相同（维护者 2026-10-15 定）：专业、简洁的书面语，不写解释原理的说明行，
// 状态与原因用名词短语，单句末尾不加句号；保留选项取值与默认值、退出码，以及错误本身。

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

选项：
  --home <目录>          数据目录；默认 macOS ~/Library/Application Support/Wevir、
                         Windows %APPDATA%\\Wevir、Linux $XDG_DATA_HOME/wevir
  --adapter <codex|echo>
                         引擎适配器，默认 codex（需先在仓库根目录运行 bash scripts/fetch-codex.sh，
                         或设置 WEVIR_CODEX_BIN）；echo 为开发用假引擎
  --port <端口>          监听端口，默认 0（系统分配）
  --log-level <级别>     debug | info | warn | error，默认 info；日志：<数据目录>/logs/host.log
  --exit-on-stdin-eof    stdin 读到 EOF 时退出
  -h, --help             显示帮助
  -v, --version          显示版本

环境变量：
  WEVIR_HOME             数据目录，优先于 --home
  WEVIR_LANG             zh | en；未设置时按 LC_ALL、LC_MESSAGES、LANG，zh* 为中文，其余为英文

退出码：
  0                      正常退出
  1                      运行失败，或退出超时被强制结束
  2                      参数错误
  3                      该数据目录已有 Host 运行`,
  seeHelp: '运行 wevir-host --help',
  badAdapter: (kinds, value) => `--adapter 只能是 ${kinds}：${value}`,
  badLogLevel: (value) => `--log-level 只能是 debug | info | warn | error：${value}`,
  badPort: (value) => `--port 必须是 0–65535 的整数：${value}`,
  emptyHome: '--home 不能为空',
  adapterFailed: (adapter, error) => `无法创建 ${adapter} 适配器：${error}`,
  alreadyRunning: ({ home, pid, startedAt, path }) =>
    `数据目录 ${home} 已有 Host 运行：pid ${pid}，启动于 ${startedAt}，运行时文件 ${path}`,
  startFailed: (error) => `启动失败：${error}`,
};

const en: HostCliText = {
  usage: `Usage: wevir-host [options]

Options:
  --home <dir>           Data directory. Default: macOS ~/Library/Application Support/Wevir,
                         Windows %APPDATA%\\Wevir, Linux $XDG_DATA_HOME/wevir
  --adapter <codex|echo>
                         Engine adapter, default codex (first run bash scripts/fetch-codex.sh at the
                         repository root, or set WEVIR_CODEX_BIN); echo is a fake engine for development
  --port <port>          Listening port, default 0 (system-assigned)
  --log-level <level>    debug | info | warn | error, default info; log: <data dir>/logs/host.log
  --exit-on-stdin-eof    Exit on stdin EOF
  -h, --help             Show help
  -v, --version          Show the version

Environment:
  WEVIR_HOME             Data directory; overrides --home
  WEVIR_LANG             zh | en; otherwise LC_ALL, LC_MESSAGES, LANG (zh* is Chinese, anything else English)

Exit codes:
  0                      Normal exit
  1                      Failure, or forced exit after the shutdown timeout
  2                      Invalid arguments
  3                      A Host is already running for this data directory`,
  seeHelp: 'Run wevir-host --help',
  badAdapter: (kinds, value) => `--adapter must be ${kinds}: ${value}`,
  badLogLevel: (value) => `--log-level must be debug | info | warn | error: ${value}`,
  badPort: (value) => `--port must be an integer from 0 to 65535: ${value}`,
  emptyHome: '--home cannot be empty',
  adapterFailed: (adapter, error) => `cannot create the ${adapter} adapter: ${error}`,
  alreadyRunning: ({ home, pid, startedAt, path }) =>
    `a Host is already running for data directory ${home}: pid ${pid}, started ${startedAt}, runtime file ${path}`,
  startFailed: (error) => `failed to start: ${error}`,
};

export const HOST_CLI_TEXT: Readonly<Record<HostCliLocale, HostCliText>> = { zh, en };
