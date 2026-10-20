// 探测工具（项目环境就绪，0.70.0）：在用户的登录 shell 里找工具、跑它的 `--version`，与检查和 Agent 的命令看到同一个 PATH。
//
// 不执行项目代码：在一个空目录里跑（不读项目的 `packageManager`、`.npmrc`、`rust-toolchain.toml`），关掉 corepack、pnpm、Go 与 rustup
// 的自动下载，stdin 是空的。macOS 上 `/usr/bin` 里的 cc、make、python3 等在没装命令行工具时只是弹出安装框的空壳：先看
// `xcode-select -p`，没装时不跑它们，记成没安装。POSIX 上所有工具在一个 shell 里跑完（登录 shell 起一次就要读一遍 rc）；Windows 上
// 每个工具一个 `cmd /c`。

import { spawn } from 'node:child_process';
import { childEnv, shellCommand } from '../processes.js';

/** 探测一个工具：`args` 默认 `--version`，`null` 只找路径、不跑（检查命令里的任意命令）。 */
export interface ToolSpec {
  name: string;
  args?: string | null;
  /** macOS 上 `/usr/bin` 里的命令行工具空壳（没装命令行工具时不跑）。 */
  clt?: boolean;
}

export interface ProbeResult {
  name: string;
  /** 找到的可执行文件；找不到时 undefined。 */
  path?: string;
  /** 跑的命令（`node --version`）。 */
  command: string;
  exitCode: number | null;
  output: string;
  /** `not_found` 不在 PATH、`clt_missing` 没装 Xcode 命令行工具、`timeout` 探测超时、`failed` shell 起不来。 */
  problem?: 'not_found' | 'clt_missing' | 'timeout' | 'failed';
}

export const TOOL_SPECS: Readonly<Record<string, ToolSpec>> = {
  node: { name: 'node' },
  npm: { name: 'npm' },
  pnpm: { name: 'pnpm' },
  yarn: { name: 'yarn' },
  bun: { name: 'bun' },
  corepack: { name: 'corepack' },
  python3: { name: 'python3', clt: true },
  python: { name: 'python' },
  uv: { name: 'uv' },
  poetry: { name: 'poetry' },
  pipenv: { name: 'pipenv' },
  go: { name: 'go', args: 'version' },
  cargo: { name: 'cargo' },
  rustc: { name: 'rustc' },
  cc: { name: 'cc', clt: true },
  clang: { name: 'clang', clt: true },
  gcc: { name: 'gcc', clt: true },
  'c++': { name: 'c++', clt: true },
  make: { name: 'make', clt: true },
  cmake: { name: 'cmake' },
  meson: { name: 'meson' },
  ninja: { name: 'ninja' },
  swift: { name: 'swift', clt: true },
};

/** 探测时的环境：不让包管理器、Go、rustup 为了回答版本号去下载东西。 */
export function probeEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  return {
    ...childEnv(env, platform),
    COREPACK_ENABLE_NETWORK: '0',
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    COREPACK_ENABLE_AUTO_PIN: '0',
    npm_config_manage_package_manager_versions: 'false',
    npm_config_update_notifier: 'false',
    NO_UPDATE_NOTIFIER: '1',
    GOTOOLCHAIN: 'local',
    RUSTUP_AUTO_INSTALL: '0',
    POETRY_NO_INTERACTION: '1',
    PIPENV_VERBOSITY: '-1',
  };
}

const RECORD = '\u001e';
const FIELD = '\u001f';
const OUTPUT_MAX = 2000;

/** POSIX：一个脚本找全部工具。每个工具输出 `RS 名字 US 路径 US 输出 US 退出码`。 */
export function posixProbeScript(tools: readonly ToolSpec[], platform: NodeJS.Platform): string {
  const lines = [
    `__r() { printf '${RECORD}%s${FIELD}%s${FIELD}%s${FIELD}%s' "$1" "$2" "$3" "$4"; }`,
    platform === 'darwin' ? '__clt=0; xcode-select -p >/dev/null 2>&1 && __clt=1' : '__clt=1',
  ];
  for (const tool of tools) {
    const name = shellQuote(tool.name);
    if (tool.args === null) {
      lines.push(
        `__p=$(command -v ${name} 2>/dev/null); if [ -z "$__p" ]; then __r ${name} "" "" 127; else __r ${name} "$__p" "" 0; fi`,
      );
      continue;
    }
    const args = tool.args ?? '--version';
    const guard =
      tool.clt === true && platform === 'darwin'
        ? `if [ "$__p" = "/usr/bin/${tool.name}" ] && [ "$__clt" != 1 ]; then __r ${name} "$__p" "" clt; else `
        : '';
    lines.push(
      `__p=$(command -v ${name} 2>/dev/null); if [ -z "$__p" ]; then __r ${name} "" "" 127; else ${guard}__o=$(${name} ${args} 2>&1 </dev/null); __c=$?; __r ${name} "$__p" "$(printf '%s' "$__o" | head -c ${OUTPUT_MAX})" "$__c"; ${guard === '' ? '' : 'fi; '}fi`,
    );
  }
  return lines.join('\n');
}

/** 解析脚本的输出。退出码 127 且没有路径是找不到。 */
export function parsePosixProbe(
  stdout: string,
  tools: readonly ToolSpec[],
): Map<string, ProbeResult> {
  const results = new Map<string, ProbeResult>();
  for (const record of stdout.split(RECORD).slice(1)) {
    const [name = '', path = '', output = '', code = ''] = record.split(FIELD);
    const spec = tools.find((tool) => tool.name === name);
    if (!spec) continue;
    const command = commandOf(spec);
    if (code === '127' && path === '') {
      results.set(name, { name, command, exitCode: 127, output: '', problem: 'not_found' });
    } else if (code === 'clt') {
      results.set(name, {
        name,
        path,
        command,
        exitCode: null,
        output: '',
        problem: 'clt_missing',
      });
    } else {
      const exitCode = Number.parseInt(code, 10);
      results.set(name, {
        name,
        path,
        command,
        exitCode: Number.isNaN(exitCode) ? null : exitCode,
        output: output.trim(),
      });
    }
  }
  return results;
}

function commandOf(spec: ToolSpec): string {
  return spec.args === null
    ? `command -v ${spec.name}`
    : `${spec.name} ${spec.args ?? '--version'}`;
}

/** 能放进探测脚本的命令名。 */
export function probeableName(name: string): boolean {
  return /^[A-Za-z0-9_+.-]{1,64}$/.test(name);
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_+.-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface ProbeOptions {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** 空目录。 */
  cwd: string;
  timeoutMs: number;
}

/** 探测这些工具；超时时没轮到的记 `timeout`。 */
export async function probeTools(
  names: readonly string[],
  options: ProbeOptions,
): Promise<Map<string, ProbeResult>> {
  const tools = [...new Set(names)]
    .map((name) => TOOL_SPECS[name] ?? (probeableName(name) ? { name, args: null } : undefined))
    .filter((spec): spec is ToolSpec => spec !== undefined);
  if (tools.length === 0) return new Map();
  const results =
    options.platform === 'win32'
      ? await probeWindows(tools, options)
      : await probePosix(tools, options);
  for (const tool of tools) {
    if (!results.has(tool.name)) {
      results.set(tool.name, {
        name: tool.name,
        command: commandOf(tool),
        exitCode: null,
        output: '',
        problem: 'timeout',
      });
    }
  }
  return results;
}

async function probePosix(
  tools: readonly ToolSpec[],
  options: ProbeOptions,
): Promise<Map<string, ProbeResult>> {
  const env = probeEnv(options.env, options.platform);
  const { file, args } = shellCommand(
    posixProbeScript(tools, options.platform),
    options.platform,
    env,
  );
  const { stdout, failed } = await run(file, args, options.cwd, env, options.timeoutMs, false);
  const results = parsePosixProbe(stdout, tools);
  if (failed && results.size === 0) {
    for (const tool of tools) {
      results.set(tool.name, {
        name: tool.name,
        command: commandOf(tool),
        exitCode: null,
        output: '',
        problem: 'failed',
      });
    }
  }
  return results;
}

async function probeWindows(
  tools: readonly ToolSpec[],
  options: ProbeOptions,
): Promise<Map<string, ProbeResult>> {
  const env = probeEnv(options.env, options.platform);
  const results = new Map<string, ProbeResult>();
  await Promise.all(
    tools.map(async (tool) => {
      const command = commandOf(tool);
      const where = await run('where.exe', [tool.name], options.cwd, env, options.timeoutMs, true);
      const path = where.stdout.split(/\r?\n/)[0]?.trim();
      if (where.code !== 0 || !path) {
        results.set(tool.name, {
          name: tool.name,
          command,
          exitCode: 127,
          output: '',
          problem: 'not_found',
        });
        return;
      }
      if (tool.args === null) {
        results.set(tool.name, { name: tool.name, path, command, exitCode: 0, output: '' });
        return;
      }
      const shell = shellCommand(command, options.platform, env);
      const out = await run(shell.file, shell.args, options.cwd, env, options.timeoutMs, true);
      results.set(tool.name, {
        name: tool.name,
        path,
        command,
        exitCode: out.code,
        output: out.stdout.slice(0, OUTPUT_MAX).trim(),
        ...(out.timedOut && { problem: 'timeout' as const }),
      });
    }),
  );
  return results;
}

function run(
  file: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  verbatim: boolean,
): Promise<{ stdout: string; code: number | null; timedOut: boolean; failed: boolean }> {
  return new Promise((resolve) => {
    let stdout = '';
    let timedOut = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        windowsVerbatimArguments: verbatim,
        detached: process.platform !== 'win32',
      });
    } catch {
      resolve({ stdout: '', code: null, timedOut: false, failed: true });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== 'win32' && child.pid !== undefined)
          process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {}
    }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (stdout.length < 200_000) stdout += chunk;
    });
    child.stderr?.resume();
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ stdout, code: null, timedOut, failed: true });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, code, timedOut, failed: code !== 0 });
    });
  });
}
