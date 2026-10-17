// SPDX-License-Identifier: MIT
// 改写自 sst/opencode packages/opencode/src/lsp/server.ts（Typescript、Pyright、Gopls、RustAnalyzer、Clangd、SourceKit 与
// NearestRoot）、packages/opencode/src/lsp/language.ts（扩展名 → languageId）
// 来源提交 e3c4eb242585dcd77be1a867391b7c25fd47ce52（v1.19.3）
// Copyright (c) 2025 opencode，MIT License
// 修改：不用 Effect；只留六种语言；不自动下载、不 `npm install`、不 `go install`，找不到时给出缺什么与怎么装；TypeScript 优先用
// 项目里 TypeScript 7 自带的原生语言服务器（`tsc --lsp --stdio`，或 `@typescript/native-preview` 的 `tsgo`），TypeScript 5/6
// 才用 typescript-language-server；在 PATH 之外再找常见的安装位置（Host 由桌面端拉起时只有 GUI 的 PATH，同 adapter-claude 的
// executable.ts）；项目根往上找到会话目录为止。
//
// 代码智能（LSP 工具，domain-model §3.15）：每种语言用哪个语言服务器、从哪里找、项目根怎么定。

import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** 怎么启动一个语言服务器。 */
export interface ServerLaunch {
  command: string;
  args: string[];
  /** 结果里给模型看的名字，例如 `tsc --lsp (TypeScript 7.0.2)`。 */
  label: string;
  /** `initialize` 的 `initializationOptions`。 */
  initializationOptions?: Record<string, unknown>;
  /** 回 `workspace/configuration` 用的设置（按 section 取）。 */
  settings?: Record<string, unknown>;
}

/** 找不到语言服务器：缺什么、怎么装。 */
export interface ServerMissing {
  missing: string;
}

export interface ServerSpec {
  /** `typescript`、`python`、`go`、`rust`、`c`、`swift`。 */
  id: string;
  /** 语言名，写进结果与错误。 */
  language: string;
  extensions: readonly string[];
  /** 装服务器的说明（找不到或起不来时附上）。 */
  install?: string;
  /**
   * 项目根：从文件所在目录往上找到会话目录为止，第一个有标记文件的目录；都没有时是会话目录。TypeScript 只认锁文件，不认
   * tsconfig.json：monorepo 一个服务器，跨包的引用才找得全（opencode 同样只认锁文件）。
   */
  root(file: string, stop: string): Promise<string>;
  resolve(root: string, env: NodeJS.ProcessEnv): Promise<ServerLaunch | ServerMissing>;
}

/** 扩展名 → `textDocument/didOpen` 的 languageId（opencode language.ts 里这六种语言的部分）。 */
export const LANGUAGE_IDS: Readonly<Record<string, string>> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascriptreact',
  '.py': 'python',
  '.pyi': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.c++': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.hxx': 'cpp',
  '.h++': 'cpp',
  '.m': 'objective-c',
  '.mm': 'objective-cpp',
  '.swift': 'swift',
};

export function languageId(file: string): string {
  return LANGUAGE_IDS[path.extname(file).toLowerCase()] ?? 'plaintext';
}

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

const isFile = (file: string) =>
  stat(file).then(
    (info) => info.isFile(),
    () => false,
  );

/** 从 `start` 往上到 `stop`（含）找第一个有 `markers` 之一的目录。 */
export async function nearestRoot(
  start: string,
  stop: string,
  markers: readonly string[],
): Promise<string | undefined> {
  let dir = start;
  for (;;) {
    for (const marker of markers) {
      if (await exists(path.join(dir, marker))) return dir;
    }
    if (dir === stop) return undefined;
    const parent = path.dirname(dir);
    const rel = path.relative(stop, parent);
    if (parent === dir || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    dir = parent;
  }
}

const markerRoot =
  (markers: readonly string[]) =>
  async (file: string, stop: string): Promise<string> =>
    (await nearestRoot(path.dirname(file), stop, markers)) ?? stop;

/** 不在 PATH 里时也找的位置（同 adapter-claude 的 commonClaudeDirs，加上 Go、Rust 与 Python 的用户目录）。 */
export function commonBinDirs(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  const goBin =
    env.GOBIN ??
    (env.GOPATH === undefined
      ? path.join(home, 'go', 'bin')
      : path.join(env.GOPATH.split(path.delimiter)[0] ?? '', 'bin'));
  if (platform === 'win32') {
    return [
      ...(env.APPDATA === undefined ? [] : [path.win32.join(env.APPDATA, 'npm')]),
      path.win32.join(home, '.cargo', 'bin'),
      goBin,
      path.win32.join(home, '.local', 'bin'),
      path.win32.join(home, 'scoop', 'shims'),
    ];
  }
  return [
    path.posix.join(home, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.posix.join(home, '.cargo', 'bin'),
    goBin,
    path.posix.join(home, '.npm-global', 'bin'),
    path.posix.join(home, '.bun', 'bin'),
    path.posix.join(home, '.volta', 'bin'),
    path.posix.join(home, 'Library', 'pnpm'),
    path.posix.join(home, '.local', 'share', 'pnpm'),
    '/opt/homebrew/opt/llvm/bin',
  ];
}

/** 在 `dirs`、PATH 与常见位置里找可执行文件（Windows 也认 .exe / .cmd）。 */
export async function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv,
  dirs: readonly string[] = [],
): Promise<string | undefined> {
  const names =
    process.platform === 'win32' ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name] : [name];
  const searched = [
    ...dirs,
    ...(env.PATH ?? env.Path ?? '').split(path.delimiter).filter((dir) => dir !== ''),
    ...commonBinDirs(env),
  ];
  for (const dir of new Set(searched)) {
    for (const candidate of names) {
      const file = path.join(dir, candidate);
      if (await isFile(file)) return file;
    }
  }
  return undefined;
}

/** 按 Node 的查找规则从 `dir` 往上找 `node_modules/<name>`，返回包目录（真实路径）。 */
async function findPackage(dir: string, name: string): Promise<string | undefined> {
  let current = dir;
  for (;;) {
    const candidate = path.join(current, 'node_modules', name);
    if (await isFile(path.join(candidate, 'package.json'))) {
      return realpath(candidate).catch(() => candidate);
    }
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function packageVersion(dir: string): Promise<string | undefined> {
  try {
    const value = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as {
      version?: unknown;
    };
    return typeof value.version === 'string' ? value.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * TypeScript 7 与 native-preview 的原生可执行文件：`@typescript/<包名>-<平台>-<架构>/lib/<bin>`，按 Node 规则从包目录往上找
 * （同 typescript 包的 lib/getExePath.js；不执行项目里的那个脚本）。
 */
async function nativeTypeScript(packageDir: string, base: string, bin: string) {
  const platformPackage = `@typescript/${base}-${process.platform}-${process.arch}`;
  const dir = await findPackage(packageDir, platformPackage);
  if (dir === undefined) return undefined;
  const exe = path.join(dir, 'lib', process.platform === 'win32' ? `${bin}.exe` : bin);
  return (await isFile(exe)) ? exe : undefined;
}

const TS_INSTALL =
  'Install TypeScript in the project (npm i -D typescript; TypeScript 7 includes a language server), ' +
  'or for TypeScript 5/6 also install typescript-language-server (npm i -g typescript-language-server).';

export const TYPESCRIPT: ServerSpec = {
  id: 'typescript',
  language: 'TypeScript/JavaScript',
  extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
  root: markerRoot(['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'bun.lock', 'bun.lockb']),
  async resolve(root, env) {
    const typescript = await findPackage(root, 'typescript');
    const version = typescript === undefined ? undefined : await packageVersion(typescript);
    const major = Number.parseInt(version ?? '', 10);
    if (typescript !== undefined && major >= 7) {
      const exe = await nativeTypeScript(typescript, 'typescript', 'tsc');
      if (exe !== undefined) {
        return {
          command: exe,
          args: ['--lsp', '--stdio'],
          label: `tsc --lsp (TypeScript ${version})`,
        };
      }
    }
    const preview = await findPackage(root, '@typescript/native-preview');
    if (preview !== undefined) {
      const exe = await nativeTypeScript(preview, 'native-preview', 'tsgo');
      if (exe !== undefined) {
        const previewVersion = await packageVersion(preview);
        return {
          command: exe,
          args: ['--lsp', '--stdio'],
          label: `tsgo --lsp (native-preview ${previewVersion ?? '?'})`,
        };
      }
    }
    const tsserver =
      typescript === undefined ? undefined : path.join(typescript, 'lib', 'tsserver.js');
    if (tsserver === undefined || !(await isFile(tsserver))) {
      return {
        missing: `No TypeScript found for ${root}${version === undefined ? '' : ` (typescript ${version} has no language server binary for this platform)`}. ${TS_INSTALL}`,
      };
    }
    const server = await findExecutable('typescript-language-server', env, [
      path.join(root, 'node_modules', '.bin'),
    ]);
    if (server === undefined) {
      return {
        missing: `typescript-language-server not found (the project uses TypeScript ${version}). Install it: npm i -g typescript-language-server`,
      };
    }
    return {
      command: server,
      args: ['--stdio'],
      label: `typescript-language-server (TypeScript ${version})`,
      initializationOptions: { tsserver: { path: tsserver } },
    };
  },
};

/** 项目的虚拟环境（`$VIRTUAL_ENV`、`.venv`、`venv`）的 bin 目录。 */
async function venvBins(root: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const bin = process.platform === 'win32' ? 'Scripts' : 'bin';
  const candidates = [
    ...(env.VIRTUAL_ENV === undefined ? [] : [env.VIRTUAL_ENV]),
    path.join(root, '.venv'),
    path.join(root, 'venv'),
  ];
  const result: string[] = [];
  for (const venv of candidates) {
    if (await exists(path.join(venv, bin))) result.push(path.join(venv, bin));
  }
  return result;
}

export const PYTHON: ServerSpec = {
  id: 'python',
  language: 'Python',
  extensions: ['.py', '.pyi'],
  root: markerRoot([
    'pyproject.toml',
    'pyrightconfig.json',
    'setup.py',
    'setup.cfg',
    'requirements.txt',
    'Pipfile',
  ]),
  async resolve(root, env) {
    const bins = await venvBins(root, env);
    const server =
      (await findExecutable('basedpyright-langserver', env, bins)) ??
      (await findExecutable('pyright-langserver', env, bins));
    if (server === undefined) {
      return {
        missing:
          'No Python language server found. Install basedpyright (pip install basedpyright) or pyright (npm i -g pyright).',
      };
    }
    // 用项目虚拟环境的解释器解析依赖（opencode 的 pythonPath；pyright 经 workspace/configuration 读 `python.pythonPath`）。
    const python = process.platform === 'win32' ? 'python.exe' : 'python';
    let pythonPath: string | undefined;
    for (const dir of bins) {
      if (await isFile(path.join(dir, python))) {
        pythonPath = path.join(dir, python);
        break;
      }
    }
    return {
      command: server,
      args: ['--stdio'],
      label: path.basename(server).replace(/\.(exe|cmd|bat)$/i, ''),
      ...(pythonPath !== undefined && { settings: { python: { pythonPath } } }),
    };
  },
};

const GO_INSTALL = 'Install it: go install golang.org/x/tools/gopls@latest';

export const GO: ServerSpec = {
  id: 'go',
  language: 'Go',
  extensions: ['.go'],
  install: GO_INSTALL,
  async root(file, stop) {
    return (
      (await nearestRoot(path.dirname(file), stop, ['go.work'])) ??
      (await markerRoot(['go.mod', 'go.sum'])(file, stop))
    );
  },
  async resolve(_root, env) {
    const server = await findExecutable('gopls', env);
    if (server === undefined) {
      return { missing: `gopls not found. ${GO_INSTALL}` };
    }
    return { command: server, args: [], label: 'gopls' };
  },
};

const RUST_INSTALL = 'Install it: rustup component add rust-analyzer';

export const RUST: ServerSpec = {
  id: 'rust',
  language: 'Rust',
  extensions: ['.rs'],
  install: RUST_INSTALL,
  // 离文件最近的 crate，往上有 `[workspace]` 的 Cargo.toml 时用工作区（opencode 的 RustAnalyzer.root）。
  async root(file, stop) {
    const crate = await nearestRoot(path.dirname(file), stop, ['Cargo.toml', 'Cargo.lock']);
    if (crate === undefined) return stop;
    let dir = crate;
    for (;;) {
      const manifest = await readFile(path.join(dir, 'Cargo.toml'), 'utf8').catch(() => '');
      if (manifest.includes('[workspace]')) return dir;
      if (dir === stop) return crate;
      const parent = path.dirname(dir);
      if (parent === dir) return crate;
      dir = parent;
    }
  },
  async resolve(_root, env) {
    const server = await findExecutable('rust-analyzer', env);
    if (server === undefined) {
      return { missing: `rust-analyzer not found. ${RUST_INSTALL}` };
    }
    return { command: server, args: [], label: 'rust-analyzer' };
  },
};

export const C: ServerSpec = {
  id: 'c',
  language: 'C/C++/Objective-C',
  extensions: [
    '.c',
    '.h',
    '.cpp',
    '.cc',
    '.cxx',
    '.c++',
    '.hpp',
    '.hh',
    '.hxx',
    '.h++',
    '.m',
    '.mm',
  ],
  root: markerRoot(['compile_commands.json', 'compile_flags.txt', '.clangd', 'CMakeLists.txt']),
  async resolve(_root, env) {
    const server = await findExecutable('clangd', env);
    if (server === undefined) {
      return {
        missing:
          'clangd not found. Install it (macOS: xcode-select --install or brew install llvm; Linux: apt install clangd).',
      };
    }
    return { command: server, args: ['--background-index'], label: 'clangd' };
  },
};

export const SWIFT: ServerSpec = {
  id: 'swift',
  language: 'Swift',
  extensions: ['.swift'],
  root: markerRoot(['Package.swift']),
  async resolve(_root, env) {
    // 随 Swift 工具链装；macOS 上在 Xcode 里，`xcrun --find sourcekit-lsp` 也能找到，/usr/bin 下的是转发到 Xcode 的那个。
    const server = await findExecutable('sourcekit-lsp', env, ['/usr/bin']);
    if (server === undefined) {
      return {
        missing: 'sourcekit-lsp not found. Install Xcode or a Swift toolchain (swift.org).',
      };
    }
    return { command: server, args: [], label: 'sourcekit-lsp' };
  },
};

export const BUILTIN_SERVERS: readonly ServerSpec[] = [TYPESCRIPT, PYTHON, GO, RUST, C, SWIFT];

export function serverFor(servers: readonly ServerSpec[], file: string): ServerSpec | undefined {
  const extension = path.extname(file).toLowerCase();
  return servers.find((spec) => spec.extensions.includes(extension));
}

export function isMissing(value: ServerLaunch | ServerMissing): value is ServerMissing {
  return 'missing' in value;
}
