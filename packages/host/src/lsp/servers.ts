// SPDX-License-Identifier: MIT
// 改写自 sst/opencode packages/opencode/src/lsp/server.ts（Typescript、Pyright、Gopls、RustAnalyzer、Clangd、SourceKit 与
// NearestRoot）、packages/opencode/src/lsp/language.ts（扩展名 → languageId）
// 来源提交 e3c4eb242585dcd77be1a867391b7c25fd47ce52（v1.19.3）
// Copyright (c) 2025 opencode，MIT License
// 修改：不用 Effect；只留六种语言；不自动下载、不 `npm install`、不 `go install`，找不到时给出缺什么与怎么装；TypeScript 优先用
// 项目里 TypeScript 7 自带的原生语言服务器（`tsc --lsp --stdio`，或 `@typescript/native-preview` 的 `tsgo`），TypeScript 5/6
// 才用 typescript-language-server；在 PATH 之外再找常见的安装位置（Host 由桌面端拉起时只有 GUI 的 PATH，同 adapter-claude 的
// executable.ts）；项目根往上找到会话目录为止；读版本与最低版本，给出安装方案（opencode 自己装，Wevir 只在用户发起时运行，
// 见 service.ts）；项目里没有 TypeScript 时也用全局装的 TypeScript 7。
//
// 代码智能（LSP 工具，domain-model §3.15）：每种语言用哪个语言服务器、从哪里找、项目根怎么定；0.71.0 起还有版本从哪儿读、最低版本，
// 与找不到或版本过旧时的安装方案（项目级优先用项目已有的依赖与包管理器；Host 只在用户发起 `lsp.install` 时运行它们）。

import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/** 怎么启动一个语言服务器。 */
export interface ServerLaunch {
  command: string;
  args: string[];
  /** 结果里给模型看的名字，例如 `tsc --lsp (TypeScript 7.0.2)`。 */
  label: string;
  /** 已知的版本（从 package.json 读到的）；没有时按 `versionArgs` 运行一次可执行文件读。 */
  version?: string;
  /** 读版本的参数（`--version`、`version`）；起不来或退出码非 0 时这个服务器算没装好。 */
  versionArgs?: string[];
  /** 低于它时不用（`outdated`）。 */
  minVersion?: string;
  /** `initialize` 的 `initializationOptions`。 */
  initializationOptions?: Record<string, unknown>;
  /** 回 `workspace/configuration` 用的设置（按 section 取）。 */
  settings?: Record<string, unknown>;
}

/** 找不到语言服务器：缺什么、怎么装。 */
export interface ServerMissing {
  missing: string;
}

/** 安装方案（protocol 的 `LspInstallPlan` 加上 Host 要的参数）：`argv[0]` 是程序名，运行时按同样的 PATH 找到它。 */
export interface InstallPlan {
  id: string;
  scope: 'project' | 'user' | 'system';
  argv: string[];
  /** 在哪儿运行；用户级与系统的方案省略（用户主目录）。 */
  cwd?: string;
  runnable: boolean;
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
  /** 找不到、跑不起来或版本过旧时的安装方案，项目级在前。 */
  plans?(root: string, env: NodeJS.ProcessEnv): Promise<InstallPlan[]>;
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

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(file, 'utf8'));
    return value !== null && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function packageVersion(dir: string): Promise<string | undefined> {
  const value = await readJson(path.join(dir, 'package.json'));
  return typeof value?.version === 'string' ? value.version : undefined;
}

/**
 * npm 装的可执行文件属于哪个包：按真实路径往上找名字是 `name` 的 package.json（`.bin` 里的链接、全局 bin 目录的链接都指向包里），
 * 返回包目录。
 */
export async function packageOfExecutable(exe: string, name: string): Promise<string | undefined> {
  let dir = path.dirname(await realpath(exe).catch(() => exe));
  for (let depth = 0; depth < 5; depth += 1) {
    const value = await readJson(path.join(dir, 'package.json'));
    if (value?.name === name) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** 比较两个点分版本号（只看数字部分）：`a` 小于 `b` 时为负。 */
export function compareVersions(a: string, b: string): number {
  const parts = (value: string) =>
    (value.match(/\d+(?:\.\d+)*/)?.[0] ?? '0').split('.').map((part) => Number(part));
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** 项目用哪个包管理器：锁文件，其次 package.json 的 `packageManager`，都没有时 npm。 */
export async function projectPackageManager(
  root: string,
): Promise<'npm' | 'pnpm' | 'yarn' | 'bun'> {
  if (await exists(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (await exists(path.join(root, 'yarn.lock'))) return 'yarn';
  if ((await exists(path.join(root, 'bun.lock'))) || (await exists(path.join(root, 'bun.lockb')))) {
    return 'bun';
  }
  if (await exists(path.join(root, 'package-lock.json'))) return 'npm';
  const declared = (await readJson(path.join(root, 'package.json')))?.packageManager;
  if (typeof declared === 'string') {
    const name = declared.split('@')[0];
    if (name === 'pnpm' || name === 'yarn' || name === 'bun' || name === 'npm') return name;
  }
  return 'npm';
}

/** 往项目加一个开发依赖的命令（pnpm 工作区的根要 `-w`）。 */
async function addDevDependency(root: string, pm: string, name: string): Promise<string[]> {
  if (pm === 'pnpm') {
    const workspace = await exists(path.join(root, 'pnpm-workspace.yaml'));
    return ['pnpm', 'add', '-D', ...(workspace ? ['-w'] : []), name];
  }
  if (pm === 'yarn') return ['yarn', 'add', '-D', name];
  if (pm === 'bun') return ['bun', 'add', '-d', name];
  return ['npm', 'install', '-D', name];
}

/** 一个方案：程序找得到才能运行。 */
async function plan(
  env: NodeJS.ProcessEnv,
  id: string,
  scope: InstallPlan['scope'],
  argv: string[],
  cwd?: string,
): Promise<InstallPlan> {
  const program = argv[0] ?? '';
  const runnable = path.isAbsolute(program)
    ? await isFile(program)
    : (await findExecutable(program, env)) !== undefined;
  return { id, scope, argv, ...(cwd !== undefined && { cwd }), runnable };
}

/** 只能手动做的方案（要图形安装器或管理员权限）。 */
const manual = (id: string, scope: InstallPlan['scope'], argv: string[]): InstallPlan => ({
  id,
  scope,
  argv,
  runnable: false,
});

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

/** Wevir 用 `initializationOptions.tsserver.path` 指定项目的 TypeScript，typescript-language-server 2.1.0 起才认。 */
export const TS_LANGUAGE_SERVER_MIN = '2.1.0';

/** PATH 上的 `tsc` 是 TypeScript 7（全局装的）时它的原生语言服务器。 */
async function globalNativeTypeScript(env: NodeJS.ProcessEnv) {
  const tsc = await findExecutable('tsc', env);
  if (tsc === undefined) return undefined;
  const dir = await packageOfExecutable(tsc, 'typescript');
  const version = dir === undefined ? undefined : await packageVersion(dir);
  if (dir === undefined || version === undefined || Number.parseInt(version, 10) < 7) {
    return undefined;
  }
  const exe = await nativeTypeScript(dir, 'typescript', 'tsc');
  return exe === undefined ? undefined : { exe, version };
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
          ...(version !== undefined && { version }),
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
          ...(previewVersion !== undefined && { version: previewVersion }),
        };
      }
    }
    const tsserver =
      typescript === undefined ? undefined : path.join(typescript, 'lib', 'tsserver.js');
    if (tsserver === undefined || !(await isFile(tsserver))) {
      // 项目里没有 TypeScript：用全局装的 TypeScript 7（`npm install -g typescript`）。
      const global = typescript === undefined ? await globalNativeTypeScript(env) : undefined;
      if (global !== undefined) {
        return {
          command: global.exe,
          args: ['--lsp', '--stdio'],
          label: `tsc --lsp (TypeScript ${global.version})`,
          version: global.version,
        };
      }
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
    const serverPackage = await packageOfExecutable(server, 'typescript-language-server');
    const serverVersion =
      serverPackage === undefined ? undefined : await packageVersion(serverPackage);
    return {
      command: server,
      args: ['--stdio'],
      label: `typescript-language-server (TypeScript ${version})`,
      ...(serverVersion === undefined
        ? { versionArgs: ['--version'] }
        : { version: serverVersion }),
      minVersion: TS_LANGUAGE_SERVER_MIN,
      initializationOptions: { tsserver: { path: tsserver } },
    };
  },
  async plans(root, env) {
    const manifest = await readJson(path.join(root, 'package.json'));
    const pm = await projectPackageManager(root);
    const declared = (name: string) =>
      [manifest?.dependencies, manifest?.devDependencies].some(
        (deps) => deps !== null && typeof deps === 'object' && name in deps,
      );
    const typescript = await findPackage(root, 'typescript');
    const version = typescript === undefined ? undefined : await packageVersion(typescript);
    const native = version !== undefined && Number.parseInt(version, 10) >= 7;
    const plans: InstallPlan[] = [];
    if (manifest !== undefined) {
      const missingTypeScript =
        declared('typescript') &&
        (typescript === undefined ||
          (native && (await nativeTypeScript(typescript, 'typescript', 'tsc')) === undefined));
      const missingServer =
        declared('typescript-language-server') &&
        (await findPackage(root, 'typescript-language-server')) === undefined;
      if (missingTypeScript || missingServer) {
        // 项目已经声明了依赖、只是没装（或少了平台包）：按项目的锁文件装。
        plans.push(await plan(env, 'project-install', 'project', [pm, 'install'], root));
      } else if (typescript !== undefined && !native) {
        plans.push(
          await plan(
            env,
            'project-add-server',
            'project',
            await addDevDependency(root, pm, 'typescript-language-server'),
            root,
          ),
        );
      } else if (typescript === undefined) {
        plans.push(
          await plan(
            env,
            'project-add-typescript',
            'project',
            await addDevDependency(root, pm, 'typescript'),
            root,
          ),
        );
      }
    }
    plans.push(
      typescript !== undefined && !native
        ? await plan(env, 'user-server', 'user', [
            'npm',
            'install',
            '-g',
            'typescript-language-server@latest',
          ])
        : await plan(env, 'user-typescript', 'user', ['npm', 'install', '-g', 'typescript@latest']),
    );
    return plans;
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
    const label = path.basename(server).replace(/\.(exe|cmd|bat)$/i, '');
    // npm 装的 pyright 从 package.json 读版本；pip 装的 basedpyright 旁边有 `basedpyright --version`，langserver 本身没有。
    const npmPackage = await packageOfExecutable(server, 'pyright');
    const version = npmPackage === undefined ? undefined : await packageVersion(npmPackage);
    return {
      command: server,
      args: ['--stdio'],
      label,
      ...(version !== undefined && { version }),
      ...(pythonPath !== undefined && { settings: { python: { pythonPath } } }),
    };
  },
  async plans(root, env) {
    const plans: InstallPlan[] = [];
    const venvs = await venvBins(root, env);
    const python = process.platform === 'win32' ? 'python.exe' : 'python';
    if (await exists(path.join(root, 'uv.lock'))) {
      plans.push(
        await plan(env, 'project-uv', 'project', ['uv', 'add', '--dev', 'basedpyright'], root),
      );
    } else if (await exists(path.join(root, 'poetry.lock'))) {
      plans.push(
        await plan(
          env,
          'project-poetry',
          'project',
          ['poetry', 'add', '--group', 'dev', 'basedpyright'],
          root,
        ),
      );
    } else {
      for (const bin of venvs) {
        if (await isFile(path.join(bin, python))) {
          plans.push(
            await plan(
              env,
              'project-venv',
              'project',
              [path.join(bin, python), '-m', 'pip', 'install', 'basedpyright'],
              root,
            ),
          );
          break;
        }
      }
    }
    if ((await findExecutable('pipx', env)) !== undefined) {
      plans.push(await plan(env, 'user-pipx', 'user', ['pipx', 'install', 'basedpyright']));
    } else if ((await findExecutable('uv', env)) !== undefined) {
      plans.push(await plan(env, 'user-uv', 'user', ['uv', 'tool', 'install', 'basedpyright']));
    } else {
      plans.push(await plan(env, 'user-npm', 'user', ['npm', 'install', '-g', 'pyright']));
    }
    return plans;
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
    return { command: server, args: [], label: 'gopls', versionArgs: ['version'] };
  },
  async plans(_root, env) {
    return [
      await plan(env, 'user-go', 'user', ['go', 'install', 'golang.org/x/tools/gopls@latest']),
    ];
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
    // ~/.cargo/bin 里的 rust-analyzer 是 rustup 的代理：没装组件时它在，但一运行就报错，读版本时就能发现。
    return { command: server, args: [], label: 'rust-analyzer', versionArgs: ['--version'] };
  },
  async plans(root, env) {
    // 在项目根运行：rust-toolchain.toml 指定的工具链装上组件。
    return [
      await plan(env, 'user-rustup', 'user', ['rustup', 'component', 'add', 'rust-analyzer'], root),
    ];
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
    return {
      command: server,
      args: ['--background-index'],
      label: 'clangd',
      versionArgs: ['--version'],
    };
  },
  async plans(_root, env) {
    if (process.platform === 'darwin') {
      return [
        manual('system-xcode', 'system', ['xcode-select', '--install']),
        await plan(env, 'system-brew', 'system', ['brew', 'install', 'llvm']),
      ];
    }
    if (process.platform === 'win32') {
      return [await plan(env, 'system-winget', 'system', ['winget', 'install', 'LLVM.LLVM'])];
    }
    return [manual('system-apt', 'system', ['sudo', 'apt', 'install', 'clangd'])];
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
  async plans() {
    return process.platform === 'darwin'
      ? [manual('system-xcode', 'system', ['xcode-select', '--install'])]
      : [];
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
