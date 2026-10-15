// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/contracts/src/editor.ts、apps/server/src/process/externalLauncher.ts
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：改写，编辑器表取常见的十二个，macOS 找应用包。
//
// 用外部编辑器打开文件（U32，文件窗格的“打开方式”）：照 T3 Code 的 editor.ts 与 externalLauncher.ts（MIT，ec1313c）列一张
// 常见编辑器的表，找本机装了哪些。macOS 先找 /Applications 与 ~/Applications 里的应用包，有它自带的命令行就用它（能跳到
// 行），没有就 `open -a`；其他平台在 PATH 里找命令。启动时不经 shell，去掉 Electron 自己的环境变量，不等它退出。

import { spawn } from 'node:child_process';
import { access, constants, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';

export interface EditorInfo {
  id: string;
  name: string;
}

type LineArgs = (path: string, line: number | undefined) => string[];

/** VS Code 一系：`--goto 路径:行`。 */
const goto: LineArgs = (path, line) => (line ? ['--goto', `${path}:${line}`] : [path]);
/** Zed、Sublime：`路径:行`。 */
const colon: LineArgs = (path, line) => [line ? `${path}:${line}` : path];
/** JetBrains：`--line 行 路径`。 */
const jetbrains: LineArgs = (path, line) => (line ? ['--line', String(line), path] : [path]);

interface EditorSpec extends EditorInfo {
  /** macOS 的应用包名（按顺序找第一个）。 */
  apps?: string[];
  /** 应用包里的命令行，相对 `.app`。 */
  bundledCli?: string;
  /** 其他平台（以及 macOS 上找不到应用包时）在 PATH 里找的命令。 */
  command?: string;
  args: LineArgs;
}

const EDITORS: readonly EditorSpec[] = [
  {
    id: 'vscode',
    name: 'VS Code',
    apps: ['Visual Studio Code.app'],
    bundledCli: 'Contents/Resources/app/bin/code',
    command: 'code',
    args: goto,
  },
  {
    id: 'cursor',
    name: 'Cursor',
    apps: ['Cursor.app'],
    bundledCli: 'Contents/Resources/app/bin/cursor',
    command: 'cursor',
    args: goto,
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    apps: ['Windsurf.app'],
    bundledCli: 'Contents/Resources/app/bin/windsurf',
    command: 'windsurf',
    args: goto,
  },
  {
    id: 'trae',
    name: 'Trae',
    apps: ['Trae.app', 'Trae CN.app'],
    bundledCli: 'Contents/Resources/app/bin/trae',
    command: 'trae',
    args: goto,
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    apps: ['Antigravity.app'],
    command: 'antigravity-ide',
    args: goto,
  },
  {
    id: 'kiro',
    name: 'Kiro',
    apps: ['Kiro.app'],
    command: 'kiro',
    args: goto,
  },
  {
    id: 'zed',
    name: 'Zed',
    apps: ['Zed.app'],
    bundledCli: 'Contents/MacOS/cli',
    command: 'zed',
    args: colon,
  },
  {
    id: 'sublime',
    name: 'Sublime Text',
    apps: ['Sublime Text.app'],
    bundledCli: 'Contents/SharedSupport/bin/subl',
    command: 'subl',
    args: colon,
  },
  {
    id: 'webstorm',
    name: 'WebStorm',
    apps: ['WebStorm.app'],
    command: 'webstorm',
    args: jetbrains,
  },
  {
    id: 'idea',
    name: 'IntelliJ IDEA',
    apps: ['IntelliJ IDEA.app', 'IntelliJ IDEA Ultimate.app', 'IntelliJ IDEA CE.app'],
    command: 'idea',
    args: jetbrains,
  },
  {
    id: 'pycharm',
    name: 'PyCharm',
    apps: ['PyCharm.app', 'PyCharm CE.app', 'PyCharm Professional Edition.app'],
    command: 'pycharm',
    args: jetbrains,
  },
  { id: 'xcode', name: 'Xcode', apps: ['Xcode.app'], args: (path) => [path] },
];

/** 一个编辑器在本机怎么启动。 */
type Launcher =
  | { kind: 'cli'; command: string }
  | { kind: 'app'; app: string }
  | { kind: 'path'; command: string };

async function exists(path: string, mode = constants.F_OK): Promise<boolean> {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
}

async function findInPath(command: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const dirs = (env.PATH ?? '').split(delimiter).filter((dir) => dir !== '');
  // 从访达启动时 PATH 很短：补上常见的命令行目录。
  if (process.platform === 'darwin') dirs.push('/usr/local/bin', '/opt/homebrew/bin');
  // Windows 只认 .exe：.cmd 要经 cmd.exe，路径里的特殊字符会被它当成命令。
  const names = process.platform === 'win32' ? [`${command}.exe`] : [command];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (await exists(candidate, constants.X_OK)) return candidate;
    }
  }
  return undefined;
}

async function resolveLauncher(
  spec: EditorSpec,
  env: NodeJS.ProcessEnv,
): Promise<Launcher | undefined> {
  if (process.platform === 'darwin' && spec.apps) {
    for (const root of ['/Applications', join(homedir(), 'Applications')]) {
      for (const name of spec.apps) {
        const app = join(root, name);
        if (!(await exists(app))) continue;
        const cli = spec.bundledCli && join(app, spec.bundledCli);
        if (cli && (await exists(cli, constants.X_OK))) return { kind: 'cli', command: cli };
        return { kind: 'app', app };
      }
    }
  }
  if (spec.command) {
    const command = await findInPath(spec.command, env);
    if (command) return { kind: 'path', command };
  }
  return undefined;
}

/** 本机装了的编辑器；查一次后缓存（装新的编辑器要重启应用才看得到）。 */
export class Editors {
  #found: Promise<Map<string, Launcher>> | undefined;
  readonly #env: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.#env = env;
  }

  #resolve(): Promise<Map<string, Launcher>> {
    this.#found ??= (async () => {
      const found = new Map<string, Launcher>();
      for (const spec of EDITORS) {
        const launcher = await resolveLauncher(spec, this.#env);
        if (launcher) found.set(spec.id, launcher);
      }
      return found;
    })();
    return this.#found;
  }

  async list(): Promise<EditorInfo[]> {
    const found = await this.#resolve();
    return EDITORS.filter((spec) => found.has(spec.id)).map(({ id, name }) => ({ id, name }));
  }

  /** 用 `id` 打开 `path`（绝对路径，要存在），可带行号。 */
  async open(id: string, path: string, line?: number): Promise<void> {
    const spec = EDITORS.find((editor) => editor.id === id);
    const launcher = spec && (await this.#resolve()).get(id);
    if (!spec || !launcher) throw new Error(`editor ${id} is not available`);
    if (!isAbsolute(path)) throw new Error('path must be absolute');
    await stat(path);
    const args = spec.args(path, line);
    if (launcher.kind === 'app') {
      detach('open', ['-a', launcher.app, path], this.#env);
    } else {
      detach(launcher.command, args, this.#env);
    }
  }
}

/** 编辑器的命令行（VS Code 的是脚本，经 ELECTRON_RUN_AS_NODE 跑）不能继承 Electron 自己的环境变量。 */
function cleanEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('ELECTRON_') || key === 'NODE_OPTIONS') continue;
    next[key] = value;
  }
  return next;
}

function detach(command: string, args: string[], env: NodeJS.ProcessEnv): void {
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    env: cleanEnv(env),
    windowsHide: true,
  });
  child.on('error', () => {});
  child.unref();
}

/** 行号：正整数。 */
export function isLineNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value < 10_000_000;
}
