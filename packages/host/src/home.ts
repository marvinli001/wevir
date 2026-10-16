import { homedir } from 'node:os';
import { isAbsolute, join, posix, resolve, win32 } from 'node:path';

/** 数据目录里的固定位置。`wevir.db`、`secrets.json` 由 storage 包定义。 */
export const HOME_LAYOUT = {
  /** 运行时文件 `host.json` 所在目录（0700）。 */
  runDir: 'run',
  /** 结构化日志目录（0700）。 */
  logsDir: 'logs',
  /** `hostId`：每个数据目录一个，跨 Host 重启不变（host-api.md §2）。 */
  hostIdFile: 'host-id',
  /** Host 设置（R11，domain-model §3.7）：CLI 与桌面共用的偏好。 */
  settingsFile: 'settings.json',
  /** 订阅来源的引擎用的可执行文件（0.19.0，`account.setPath`）。 */
  enginesFile: 'engines.json',
  /** 读历史的工具读的会话历史（0.25.0，接力），每个接力过的会话一个 `<会话 ID>.json`（0700）。 */
  historyDir: 'history',
  /** Host 写给引擎挂的本机 MCP 服务的脚本（0.25.0 的读历史工具、0.34.0 的联网工具，0700）。 */
  mcpDir: 'mcp',
  /** 消息里的图片（0.28.0，images.ts）；没发出去的在 `staged/` 里，过一天删掉。 */
  imagesDir: 'images',
  /** 联网工具的设置（0.34.0，web/service.ts）：开关与所选的搜索服务；Key 在 `secrets.json`。 */
  webFile: 'web.json',
  /** 不在项目里的会话（0.39.0，chats.ts）：“对话”工作区，每个会话一个 `<会话 ID>/` 文件夹（0700）。 */
  chatsDir: 'chats',
} as const;

export interface ResolveHomeOptions {
  /** `--home` 参数。 */
  home?: string;
  /** 默认 `process.env`。 */
  env?: NodeJS.ProcessEnv;
  /** 默认 `process.platform`。 */
  platform?: NodeJS.Platform;
  /** 默认 `os.homedir()`。 */
  homedir?: string;
  /** 相对路径的基准，默认 `process.cwd()`。 */
  cwd?: string;
}

/**
 * 解析数据目录（SKELETON_PLAN §6 T2.5）：`WEVIR_HOME` > `--home` > 平台默认。相对路径按 `cwd`
 * 解析成绝对路径。
 *
 * 平台默认：macOS `~/Library/Application Support/Wevir`，Windows `%APPDATA%\Wevir`（没有
 * `APPDATA` 时退回 `~\AppData\Roaming\Wevir`），其他平台 `$XDG_DATA_HOME/wevir`（未设或不是
 * 绝对路径时按 XDG 规范退回 `~/.local/share/wevir`）。
 */
export function resolveHome(options: ResolveHomeOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const path = platform === 'win32' ? win32 : posix;
  const cwd = options.cwd ?? process.cwd();
  const explicit = nonEmpty(env.WEVIR_HOME) ?? nonEmpty(options.home);
  if (explicit !== undefined) return path.resolve(cwd, explicit);

  const home = options.homedir ?? homedir();
  switch (platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Wevir');
    case 'win32':
      return path.join(nonEmpty(env.APPDATA) ?? path.join(home, 'AppData', 'Roaming'), 'Wevir');
    default: {
      const xdg = nonEmpty(env.XDG_DATA_HOME);
      const base =
        xdg !== undefined && path.isAbsolute(xdg) ? xdg : path.join(home, '.local', 'share');
      return path.join(base, 'wevir');
    }
  }
}

/** 数据目录里某个固定位置的绝对路径。 */
export function homePath(home: string, entry: keyof typeof HOME_LAYOUT): string {
  if (!isAbsolute(home)) throw new Error(`数据目录必须是绝对路径：${home}`);
  return join(resolve(home), HOME_LAYOUT[entry]);
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}
