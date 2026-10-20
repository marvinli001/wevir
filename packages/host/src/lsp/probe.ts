// 代码智能（LSP 工具，domain-model §3.15）：找到的语言服务器能不能用（0.71.0）——读版本（运行一次 `--version` 之类，按路径与修改时间
// 缓存）、对照最低版本、判断装在哪儿（项目内 / 用户级 / 系统）。可执行文件在但跑不起来（rustup 的代理没有组件、坏掉的链接）
// 算没装好。

import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { compareVersions, type ServerLaunch } from './servers.js';

/** 读版本的时限。 */
const PROBE_TIMEOUT_MS = 10_000;

export type ServerSource = 'project' | 'user' | 'system';

export interface ProbeResult {
  version?: string;
  /** 运行它读版本时失败：起不来、超时或退出码非 0。 */
  error?: string;
}

const cache = new Map<string, { key: string; result: ProbeResult }>();

/** 版本号：输出里第一个 `数字.数字`（可带更多段与 `-xxx` 后缀）。 */
export function parseVersion(output: string): string | undefined {
  return output.match(/\bv?(\d+\.\d+(?:\.\d+)*(?:-[0-9A-Za-z.]+)?)/)?.[1];
}

/** 服务器的版本：`launch.version` 已知时直接用，否则按 `versionArgs` 运行一次。 */
export async function probeServer(
  launch: ServerLaunch,
  env: NodeJS.ProcessEnv,
): Promise<ProbeResult> {
  if (launch.version !== undefined) return { version: launch.version };
  if (launch.versionArgs === undefined) return {};
  const info = await stat(launch.command).catch(() => undefined);
  const key = `${info?.mtimeMs ?? 0}:${info?.size ?? 0}`;
  const id = `${launch.command}\0${launch.versionArgs.join(' ')}`;
  const hit = cache.get(id);
  if (hit !== undefined && hit.key === key) return hit.result;
  const result = await run(launch.command, launch.versionArgs, env);
  cache.set(id, { key, result });
  return result;
}

/** 测试用：清掉版本缓存。 */
export function clearProbeCache(): void {
  cache.clear();
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<ProbeResult> {
  // Windows 上 npm 装的是 .cmd 启动脚本（参数是固定的）。
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
  return new Promise((done) => {
    execFile(
      shell ? `"${command}"` : command,
      args,
      { env, timeout: PROBE_TIMEOUT_MS, maxBuffer: 256 * 1024, windowsHide: true, shell },
      (error, stdout, stderr) => {
        const output = `${stdout}\n${stderr}`.trim();
        if (error) {
          const detail = lastLines(output) || error.message;
          done({ error: `${path.basename(command)} ${args.join(' ')} failed: ${detail}` });
          return;
        }
        const version = parseVersion(output);
        done(version === undefined ? {} : { version });
      },
    );
  });
}

function lastLines(text: string): string {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-3)
    .join('\n');
}

/** 版本低于最低要求时的说明。 */
export function outdatedReason(
  launch: ServerLaunch,
  version: string | undefined,
): string | undefined {
  if (launch.minVersion === undefined || version === undefined) return undefined;
  if (compareVersions(version, launch.minVersion) >= 0) return undefined;
  return `${path.basename(launch.command)} ${version} at ${launch.command} is older than ${launch.minVersion}, the oldest version Wevir works with.`;
}

/**
 * 装在哪儿：真实路径在项目根（或扫描的目录）里是项目内，在用户主目录里是用户级，其余（Homebrew、/usr）是系统。
 */
export async function serverSource(
  command: string,
  roots: readonly string[],
  home: string = homedir(),
): Promise<ServerSource> {
  const candidates = [command, await realpath(command).catch(() => command)];
  const inside = (dir: string, file: string) => {
    const rel = path.relative(dir, file);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  if (candidates.some((file) => roots.some((root) => inside(root, file)))) return 'project';
  if (inside(home, command)) return 'user';
  return 'system';
}
