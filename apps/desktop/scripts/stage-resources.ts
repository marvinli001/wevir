/**
 * 准备随安装包分发的运行时（ADR-0007 决策 4、5）：`pnpm --filter @wevir/desktop resources [--target <三元组>]`。
 * 要先在仓库根目录 `pnpm build`（Host 与它依赖的工作区包的 dist/）。
 *
 * 产物在 `apps/desktop/resources/`（gitignore），打包时原样进入安装包的资源目录（electron-builder 的 `extraResources`，
 * 运行时是 `process.resourcesPath`）；桌面端拉起 Host 时把这个目录交给它（`WEVIR_RESOURCES_DIR`），adapter-codex 先在
 * 这里找 codex-app-server 与提示词。
 *
 *   resources/engines/codex/codex-app-server[.exe]   锁定版本，scripts/fetch-codex.sh 按 sha256 校验
 *   resources/engines/codex/codex-code-mode-host[.exe]  同上；code mode 的 exec 在它里面跑，codex-app-server 在旁边找它
 *   resources/engines/codex/codex-resources/bwrap    只有 Linux（LGPL-2.0-or-later）
 *   resources/engines/codex/LICENSE、NOTICE          Codex 的 Apache-2.0 全文与署名（licenses/codex/，取自锁定提交）
 *   resources/prompts/                               仓库的 prompts/（不含 README.md）
 *   resources/computer-use/wevir-computer-use        只有 macOS：电脑操作的 Swift helper（native/computer-use，按目标架构
 *                                                    swift build），随应用一起签名与公证
 *   resources/host/dist/                             wevir-host 打成的 bundle（main.js 与按需加载的几个文件，bundleHost），
 *                                                    桌面端以 Electron 的 utilityProcess 运行它
 *   resources/host/migrations/                       @wevir/storage 的 SQL 迁移（bundle 按 `../migrations/` 找）
 *   resources/host/node_modules/                     只有 ON_DISK_PACKAGES 与它们的依赖：pnpm deploy 的 hoisted 布局（没有
 *                                                    符号链接），不含运行时用不到的文件（pruneUnusedFiles）
 *
 * `--target` 默认是本机平台；打别的平台的安装包时给出那个平台的三元组（fetch-codex.sh 的列表），Host 的平台可选依赖
 * 也按它装。`WEVIR_GITHUB_MIRROR` 同 fetch-codex.sh。
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { builtinModules } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { type OutputChunk, rolldown } from 'rolldown';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const repo = join(desktop, '..', '..');

/** 本机平台的三元组，与 fetch-codex.sh 的默认值相同（Linux 用 musl 的静态二进制）。 */
export function hostTarget(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const cpu = arch === 'arm64' ? 'aarch64' : arch === 'x64' ? 'x86_64' : undefined;
  const os =
    platform === 'darwin'
      ? 'apple-darwin'
      : platform === 'linux'
        ? 'unknown-linux-musl'
        : platform === 'win32'
          ? 'pc-windows-msvc'
          : undefined;
  if (cpu === undefined || os === undefined) throw new Error(`不支持的平台：${platform}-${arch}`);
  return `${cpu}-${os}`;
}

/** 三元组对应的 Node 平台与架构（pnpm 的 `--os` / `--cpu`）。 */
export function nodePlatform(target: string): { os: NodeJS.Platform; cpu: string } {
  const [arch = '', ...rest] = target.split('-');
  const system = rest.join('-');
  const cpu = arch === 'aarch64' ? 'arm64' : arch === 'x86_64' ? 'x64' : undefined;
  const os =
    system === 'apple-darwin'
      ? 'darwin'
      : system.startsWith('unknown-linux-')
        ? 'linux'
        : system === 'pc-windows-msvc'
          ? 'win32'
          : undefined;
  if (cpu === undefined || os === undefined) throw new Error(`不认识的三元组：${target}`);
  return { os, cpu };
}

/**
 * 不进安装包的依赖。它们与只被它们用到的依赖由 `pruneDependencies` 删掉：
 * - `vitest`：`@wevir/runtime-adapter` 的可选 peer（只有 `./contract` 的契约测试用），pnpm 从工作区根的开发依赖解析到它，
 *   deploy 便带上了它和 Vite 那一串；
 * - `@cursor/sdk`：许可证是“All rights reserved”，维护者定不随应用再分发（ADR-0007 补记 3）。用户选用 Cursor 时由 Host 从
 *   npm registry 下载到数据目录（adapter-cursor 的 sdk-install.ts）。Claude Agent SDK 2026-10-17 起随安装包（补记 6），只带它的
 *   JS，不带原生的 `claude`；
 * - `@anthropic-ai/sdk`：Claude Agent SDK 0.3.286 的 peer，只在它的 `.d.ts` 里用到类型，运行时不加载（14 MB）；
 * - `node-addon-api`：node-pty（用户终端）的依赖，只有编译原生模块用的 C++ 头文件，运行时不加载。
 */
export const EXCLUDED_PACKAGES: readonly string[] = [
  'vitest',
  '@cursor/sdk',
  '@anthropic-ai/sdk',
  'node-addon-api',
];

/**
 * 不打进 bundle、原样放在 `host/node_modules/` 的包（连同它们的依赖）。别的依赖都打进 bundle，新依赖要按路径找自己的文件、是原生
 * 模块，或者要被别的进程加载时加到这里：
 * - `node-pty`：原生模块（用户终端，Host 的可选依赖）；
 * - `@anthropic-ai/claude-agent-sdk`：adapter-claude 先 `import.meta.resolve` 它判断装没装，SDK 自己也按 `import.meta.url` 找包里的文件；
 * - `zod`：OpenCode 的应用工具插件在 OpenCode 的进程里按 `file:` 地址 import 它（adapter-opencode 的 `zodModuleUrl`），它也是
 *   Claude Agent SDK 的 peer；
 * - `sherpa-onnx-node`：原生模块（听写的本机识别，Host 的可选依赖）。它的 `addon.js` 按 `../sherpa-onnx-<平台>-<架构>/` 找原生包，
 *   deploy 按 `--os` / `--cpu` 只装目标平台的那一个（约 33 MB，含 onnxruntime）；没有这个平台的原生包时 Host 只有 Provider 的转写。
 * - `@jitl/quickjs-wasmfile-release-sync`：browser_run 的 QuickJS 沙箱，按 `import.meta.url` 找包里的 `emscripten-module.wasm`
 *   （约 0.5 MB）；Host 用 `import()` 加载它，`quickjs-emscripten-core` 打进 bundle。
 */
export const ON_DISK_PACKAGES: readonly string[] = [
  'node-pty',
  '@anthropic-ai/claude-agent-sdk',
  'zod',
  'sherpa-onnx-node',
  '@jitl/quickjs-wasmfile-release-sync',
];

/** ws 在 try 里 require 的可选原生加速包，Host 不装，打包时留成外部依赖（运行时找不到，ws 照常用 JS 的实现）。 */
const WS_OPTIONAL_NATIVE: readonly string[] = ['bufferutil', 'utf-8-validate'];

/**
 * 审查过、可以带着安装脚本进安装包的包（deploy 用 `--ignore-scripts`，脚本不会跑，要的东西由 `trimNodePty` 准备好）：
 * - `node-pty`（用户终端，Host 的可选依赖）：install 只核对 prebuilds/<平台> 在不在、不在就 node-gyp 现编；postinstall 清 build/Release，
 *   Windows 上把 third_party 的 conpty.dll 复制过去（只有 `useConptyDll` 时才用，Wevir 不用）。pnpm-workspace.yaml 的 allowBuilds 同样拒绝。
 */
export const REVIEWED_INSTALL_SCRIPTS: readonly string[] = ['node-pty'];

/**
 * 只留 node-pty 在目标平台要的文件：`lib/`、`package.json`、`LICENSE` 与 `prebuilds/<平台>-<架构>/`（去掉调试符号 `.pdb` 与只有
 * `useConptyDll` 才用的 `conpty/`）。Windows 10 1903（内部版本 18309）之前没有系统的 ConPTY，node-pty 改用 winpty，所以 winpty 的文件留着。
 * macOS 的 `spawn-helper` 在 npm 包里没有执行位，这里补上（之后由签名一并签名）。没有这个平台的预编译（Linux）时整个去掉：Host 不声明
 * `user_terminal`。返回留下的目录，去掉时返回 undefined。
 */
export function trimNodePty(root: string, os: NodeJS.Platform, cpu: string): string | undefined {
  const dir = join(root, 'node_modules', 'node-pty');
  if (!existsSync(dir)) return undefined;
  const platform = `${os}-${cpu}`;
  if (!existsSync(join(dir, 'prebuilds', platform))) {
    rmSync(dir, { recursive: true, force: true });
    return undefined;
  }
  const keep = new Set(['lib', 'package.json', 'LICENSE', 'prebuilds']);
  for (const entry of readdirSync(dir)) {
    if (!keep.has(entry)) rmSync(join(dir, entry), { recursive: true, force: true });
  }
  for (const entry of readdirSync(join(dir, 'prebuilds'))) {
    if (entry !== platform) rmSync(join(dir, 'prebuilds', entry), { recursive: true, force: true });
  }
  const prebuilds = join(dir, 'prebuilds', platform);
  rmSync(join(prebuilds, 'conpty'), { recursive: true, force: true });
  for (const entry of readdirSync(prebuilds)) {
    if (entry.endsWith('.pdb')) rmSync(join(prebuilds, entry));
  }
  const helper = join(prebuilds, 'spawn-helper');
  if (existsSync(helper)) chmodSync(helper, 0o755);
  return prebuilds;
}

interface Manifest {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function readManifest(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest;
}

/** 按 Node 的查找规则从 `from` 逐级向上找 `node_modules/<name>`，到 `root` 为止。 */
function findPackage(root: string, from: string, name: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dir === root || dirname(dir) === dir) return undefined;
  }
}

/** 一个目录下的包（作用域包展开成 `@scope/name`）。 */
function packagesIn(nodeModules: string): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(nodeModules)) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) {
      for (const name of readdirSync(join(nodeModules, entry))) names.push(`${entry}/${name}`);
    } else {
      names.push(entry);
    }
  }
  return names;
}

/**
 * 只留运行时用得到的包：从 `root/package.json` 出发，按 Node 的查找规则走 dependencies、optionalDependencies 与
 * peerDependencies（可选依赖与 peer 可能没装，没装就跳过；dependencies 找不到时报错），`excluded` 里的包不走。
 * 顶层 `node_modules/` 里没走到的包删掉，连同 `.bin`、`.pnpm`、`.modules.yaml` 这些 pnpm 自己的文件。返回删掉的包名。
 */
export function pruneDependencies(root: string, excluded: readonly string[]): string[] {
  const kept = new Set<string>();
  const visit = (dir: string) => {
    const manifest = readManifest(dir);
    const groups: Array<[Record<string, string> | undefined, boolean]> = [
      [manifest.dependencies, true],
      [manifest.optionalDependencies, false],
      [manifest.peerDependencies, false],
    ];
    for (const [deps, required] of groups) {
      for (const name of Object.keys(deps ?? {})) {
        if (excluded.includes(name)) continue;
        const found = findPackage(root, dir, name);
        if (found === undefined) {
          if (required) throw new Error(`${manifest.name ?? dir} 的依赖 ${name} 没有装上`);
          continue;
        }
        if (kept.has(found)) continue;
        kept.add(found);
        visit(found);
      }
    }
  };
  visit(root);

  const top = join(root, 'node_modules');
  const removed: string[] = [];
  for (const entry of readdirSync(top)) {
    if (entry.startsWith('.')) rmSync(join(top, entry), { recursive: true, force: true });
  }
  for (const name of packagesIn(top)) {
    if (kept.has(join(top, name))) continue;
    rmSync(join(top, name), { recursive: true, force: true });
    removed.push(name);
  }
  for (const entry of readdirSync(top)) {
    if (entry.startsWith('@') && readdirSync(join(top, entry)).length === 0) {
      rmSync(join(top, entry), { recursive: true });
    }
  }
  return removed;
}

/** 运行时不会读的文件：Node 不加载 node_modules 里的 TypeScript（含 `.d.ts`），Host 也不开 source map。 */
const UNUSED_FILE = /\.(?:[cm]?ts|map)$/;
/** 包根目录下运行时不会读的目录（例如 domino 随 npm 包发布了约 960 个测试文件）。 */
const UNUSED_DIRS: readonly string[] = ['test', 'tests', '__tests__', '.github', '.yarn'];

/**
 * 删掉 Host 依赖里运行时用不到的文件（`UNUSED_FILE`、包根目录的 `UNUSED_DIRS`），以及因此空掉的目录。安装包少了上千个
 * 文件，Windows 一键安装要逐个删除旧文件、解压并复制新文件，文件数直接决定“重启以更新”要等多久。包的入口仍在由
 * `checkHostTree` 核对。返回删掉的文件数。
 */
export function pruneUnusedFiles(root: string): number {
  let count = 0;
  const removeTree = (path: string) => {
    count += countFiles(path);
    rmSync(path, { recursive: true, force: true });
  };
  const walk = (dir: string, packageRoot: boolean): boolean => {
    let empty = true;
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        if (entry === 'node_modules') {
          for (const name of packagesIn(path)) walk(join(path, name), true);
          empty = false;
        } else if (packageRoot && UNUSED_DIRS.includes(entry)) {
          removeTree(path);
        } else if (walk(path, false)) {
          rmSync(path, { recursive: true });
        } else {
          empty = false;
        }
      } else if (UNUSED_FILE.test(entry)) {
        rmSync(path);
        count += 1;
      } else {
        empty = false;
      }
    }
    return empty;
  };
  const top = join(root, 'node_modules');
  if (existsSync(top)) for (const name of packagesIn(top)) walk(join(top, name), true);
  return count;
}

function countFiles(path: string): number {
  if (!lstatSync(path).isDirectory()) return 1;
  return readdirSync(path).reduce((sum, entry) => sum + countFiles(join(path, entry)), 0);
}

/** package.json 里 Node 会解析到的文件：`main`、`bin` 与 `exports`（不含 `types` 条件、TypeScript 文件与通配）。 */
export function entryFiles(manifest: Record<string, unknown>): string[] {
  const files: string[] = [];
  const add = (value: unknown, key?: string) => {
    if (key === 'types' || key === 'typings') return;
    if (typeof value === 'string') {
      if (!value.includes('*') && !/\.[cm]?ts$/.test(value)) files.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) add(item);
    } else if (value !== null && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) add(v, k);
    }
  };
  add(manifest.main);
  add(manifest.bin);
  add(manifest.exports);
  return files;
}

/**
 * 安装包里的 Host 要满足的条件，不满足就报错：没有被排除的包；没有符号链接（签名与 extraResources 的复制都不处理它）；
 * 留下的包都没有安装脚本（deploy 用 `--ignore-scripts`，交叉准备别的平台时脚本也跑不了，新依赖需要脚本时要先在这里想清楚），
 * `REVIEWED_INSTALL_SCRIPTS` 里审查过的除外；每个包的入口（`entryFiles`）都在，`pruneUnusedFiles` 没有删掉运行时要用的文件。
 */
export function checkHostTree(
  root: string,
  excluded: readonly string[],
  reviewed: readonly string[] = REVIEWED_INSTALL_SCRIPTS,
): void {
  const problems: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) problems.push(`符号链接：${path}`);
      else if (stat.isDirectory()) walk(path);
    }
  };
  walk(root);
  const visitPackages = (nodeModules: string) => {
    if (!existsSync(nodeModules)) return;
    for (const name of packagesIn(nodeModules)) {
      const dir = join(nodeModules, name);
      if (excluded.includes(name)) problems.push(`不该进安装包的包：${dir}`);
      const manifest = readManifest(dir);
      const scripts = reviewed.includes(name) ? {} : (manifest.scripts ?? {});
      for (const hook of ['preinstall', 'install', 'postinstall']) {
        if (scripts[hook] !== undefined) problems.push(`${name} 有 ${hook} 脚本`);
      }
      for (const file of entryFiles(manifest as Record<string, unknown>)) {
        if (!existsSync(join(dir, file))) problems.push(`${name} 的入口不在：${file}`);
      }
      visitPackages(join(dir, 'node_modules'));
    }
  };
  visitPackages(join(root, 'node_modules'));
  if (problems.length > 0) throw new Error(`resources/host 不符合要求：\n${problems.join('\n')}`);
}

/** 包名（`@scope/name` 或 `name`）：去掉子路径。 */
function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return (specifier.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1)).join('/');
}

/**
 * 运行时才 require 的包名：`createRequire` 得到的 `require(…)` / `require.resolve(…)`、直接调用的 `createRequire(…)(…)`，以及打包器给
 * CommonJS 留下的 `__require(…)`。
 * 打包器不跟这些调用，它们要的包不会打进 bundle。
 */
const RUNTIME_REQUIRE =
  /(?:(?<![\w$.])(?:__)?require(?:\$\d+)?(?:\.resolve)?|createRequire\([^()]*\))\(\s*["']([^"'./][^"']*)["']\s*\)/g;

/**
 * bundle 里剩下的 import 与运行时的 require 只能是 Node 内置模块与 `allowed` 里的包；别的包没打进去，安装包里也没有，运行时会
 * 找不到（例如 `createRequire(import.meta.url)('x')` 取的包，要改成 `import()` 才会打进去）。
 */
export function checkBundleImports(
  chunks: readonly Pick<OutputChunk, 'fileName' | 'imports' | 'dynamicImports' | 'code'>[],
  allowed: readonly string[],
): void {
  const local = new Set(chunks.map((chunk) => chunk.fileName));
  const builtins = new Set(builtinModules);
  const problems: string[] = [];
  const check = (fileName: string, specifier: string, how: string) => {
    if (local.has(specifier) || specifier.startsWith('node:') || builtins.has(specifier)) return;
    if (!allowed.includes(packageName(specifier)))
      problems.push(`${fileName}：${how} ${specifier}`);
  };
  for (const chunk of chunks) {
    for (const specifier of [...chunk.imports, ...chunk.dynamicImports]) {
      check(chunk.fileName, specifier, 'import');
    }
    for (const match of chunk.code.matchAll(RUNTIME_REQUIRE)) {
      check(chunk.fileName, match[1] as string, 'require');
    }
  }
  if (problems.length > 0) {
    throw new Error(`Host 的 bundle 引用了没打进去的包：\n${problems.join('\n')}`);
  }
}

/**
 * 把 deploy 出来的 Host（`<dir>/dist/main.js` 与 `<dir>/node_modules`）打成 `<dir>/dist/` 下的一个 bundle：工作区包与第三方依赖
 * 都打进去，`import()` 的模块拆成按需加载的文件（LSP 协议、domino 与 turndown、OpenCode SDK），`ON_DISK_PACKAGES` 与
 * `EXCLUDED_PACKAGES` 留成外部依赖。不压缩、不出 source map：日志里的堆栈要能读。返回输出的文件名；`onModules` 收到打进
 * bundle 的模块路径（命令行包据此写第三方声明，apps/cli/scripts/package.ts）。
 */
export async function bundleHost(
  dir: string,
  onModules?: (ids: readonly string[]) => void,
): Promise<string[]> {
  const external = [...ON_DISK_PACKAGES, ...EXCLUDED_PACKAGES, ...WS_OPTIONAL_NATIVE];
  const out = join(dir, '.bundle');
  rmSync(out, { recursive: true, force: true });
  const bundle = await rolldown({
    input: join(dir, 'dist', 'main.js'),
    platform: 'node',
    external: (id) => external.includes(packageName(id)),
    logLevel: 'warn',
  });
  try {
    const { output } = await bundle.write({
      dir: out,
      format: 'esm',
      entryFileNames: 'main.js',
      chunkFileNames: '[name]-[hash].js',
    });
    const chunks = output.filter((item): item is OutputChunk => item.type === 'chunk');
    checkBundleImports(chunks, external);
    onModules?.(chunks.flatMap((chunk) => chunk.moduleIds));
    rmSync(join(dir, 'dist'), { recursive: true, force: true });
    renameSync(out, join(dir, 'dist'));
    return chunks.map((chunk) => chunk.fileName);
  } finally {
    await bundle.close();
  }
}

/**
 * bundle 之后 `<dir>/package.json` 只声明 `ON_DISK_PACKAGES`（版本取 deploy 装上的），`pruneDependencies` 据此只留它们与它们的依赖；
 * `"type": "module"` 让 Node 把 `dist/` 里的 `.js` 当 ES 模块。没装上的（Linux 上没有 node-pty 的预编译时照样装上，由
 * `trimNodePty` 去掉）跳过。
 */
export function writeBundleManifest(dir: string): void {
  const dependencies: Record<string, string> = {};
  const optionalDependencies: Record<string, string> = {};
  const host = readManifest(dir);
  for (const name of ON_DISK_PACKAGES) {
    const installed = join(dir, 'node_modules', name);
    if (!existsSync(join(installed, 'package.json'))) continue;
    const { version } = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')) as {
      version: string;
    };
    (host.optionalDependencies?.[name] === undefined ? dependencies : optionalDependencies)[name] =
      version;
  }
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'wevir-host', private: true, type: 'module', main: 'dist/main.js', dependencies, optionalDependencies }, null, 2)}\n`,
  );
}

/** 运行命令，失败时以它的退出码结束进程。Windows 上 pnpm 是 .cmd，要经 shell 启动；bash 是 Git Bash 的可执行文件。 */
export function run(command: string, args: readonly string[], cwd: string = repo): void {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32' && command === 'pnpm',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

export function stageCodex(dir: string, target: string): void {
  // 换了目标平台时不留上一个平台的文件（例如 Linux 的 bwrap）。
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  run('bash', [join(repo, 'scripts', 'fetch-codex.sh'), '--target', target, '--out', dir]);
  for (const file of ['LICENSE', 'NOTICE']) {
    copyFileSync(join(desktop, 'licenses', 'codex', file), join(dir, file));
  }
}

export function stagePrompts(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  cpSync(join(repo, 'prompts'), dir, {
    recursive: true,
    filter: (source) => basename(source) !== 'README.md',
  });
}

/** 电脑操作的 helper：只有 macOS 目标才有；`swift build --arch` 可以在 Apple Silicon 上编 x86_64。 */
function stageComputerUse(dir: string, target: string): void {
  rmSync(dir, { recursive: true, force: true });
  const { os, cpu } = nodePlatform(target);
  if (os !== 'darwin') return;
  if (process.platform !== 'darwin') {
    console.error('macOS 的电脑操作 helper 只能在 macOS 上编译');
    process.exit(1);
  }
  const arch = cpu === 'arm64' ? 'arm64' : 'x86_64';
  const pkg = join(desktop, 'native', 'computer-use');
  run('swift', ['build', '-c', 'release', '--arch', arch, '--package-path', pkg]);
  const built = spawnSync(
    'swift',
    ['build', '-c', 'release', '--arch', arch, '--package-path', pkg, '--show-bin-path'],
    { encoding: 'utf8' },
  );
  const binary = join(built.stdout.trim(), 'wevir-computer-use');
  if (built.status !== 0 || !existsSync(binary)) {
    console.error(`没有找到编好的 helper：${binary}`);
    process.exit(1);
  }
  mkdirSync(dir, { recursive: true });
  copyFileSync(binary, join(dir, 'wevir-computer-use'));
  chmodSync(join(dir, 'wevir-computer-use'), 0o755);
  console.log(`resources/computer-use：wevir-computer-use（${arch}）`);
}

/** 按目标平台准备 `dir`（资源目录的 `host/`）；命令行包也用它（apps/cli/scripts/package.ts）。`onModules` 见 `bundleHost`。 */
export async function stageHost(
  dir: string,
  target: string,
  onModules?: (ids: readonly string[]) => void,
): Promise<void> {
  const entry = join(repo, 'packages', 'host', 'dist', 'main.js');
  if (!existsSync(entry)) {
    console.error(`没有 ${entry}：先在仓库根目录运行 pnpm build`);
    process.exit(1);
  }
  rmSync(dir, { recursive: true, force: true });
  const { os, cpu } = nodePlatform(target);
  // deploy 把工作区包按各自 package.json 的 files 复制进来（不是链接），hoisted 布局下 node_modules 里没有符号链接。
  // --os / --cpu 收多个值，写成 --os=<值> 才不会把后面的目录也当成它的值。
  run('pnpm', [
    '--filter',
    '@wevir/host',
    'deploy',
    dir,
    '--prod',
    '--ignore-scripts',
    '--config.node-linker=hoisted',
    `--os=${os}`,
    `--cpu=${cpu}`,
  ]);
  for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml'])
    rmSync(join(dir, file), { force: true });
  const chunks = await bundleHost(dir, onModules);
  // storage 的 migrate.ts 按自己所在目录的 `../migrations/` 找迁移；打进 bundle 后那是 dist/ 的上一级。
  cpSync(join(dir, 'node_modules', '@wevir', 'storage', 'migrations'), join(dir, 'migrations'), {
    recursive: true,
  });
  writeBundleManifest(dir);
  const removed = pruneDependencies(dir, EXCLUDED_PACKAGES);
  const files = pruneUnusedFiles(dir);
  checkHostTree(dir, EXCLUDED_PACKAGES);
  const pty = trimNodePty(dir, os, cpu);
  console.log(
    `resources/host：bundle ${chunks.length} 个文件（${chunks.join('、')}），node_modules 只留 ` +
      `${ON_DISK_PACKAGES.join('、')} 与它们的依赖（去掉 ${removed.length} 个包、${files} 个运行时用不到的文件）`,
  );
  console.log(
    pty === undefined
      ? `resources/host：${os}-${cpu} 没有 node-pty 的预编译，已去掉，这个平台没有用户终端`
      : `resources/host：node-pty 只留 ${os}-${cpu}`,
  );
}

/** 按目标平台准备整个资源目录。 */
export async function stageResources(target: string): Promise<void> {
  const resources = join(desktop, 'resources');
  stageCodex(join(resources, 'engines', 'codex'), target);
  stagePrompts(join(resources, 'prompts'));
  stageComputerUse(join(resources, 'computer-use'), target);
  await stageHost(join(resources, 'host'), target);
  console.log(`资源目录已准备好（${target}）：${resources}`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { target: { type: 'string' } } });
  await stageResources(values.target ?? hostTarget());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
