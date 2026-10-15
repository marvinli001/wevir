/**
 * 准备随安装包分发的运行时（ADR-0007 决策 4、5）：`pnpm --filter @wevir/desktop resources [--target <三元组>]`。
 * 要先在仓库根目录 `pnpm build`（Host 与它依赖的工作区包的 dist/）。
 *
 * 产物在 `apps/desktop/resources/`（gitignore），打包时原样进入安装包的资源目录（electron-builder 的 `extraResources`，
 * 运行时是 `process.resourcesPath`）；桌面端拉起 Host 时把这个目录交给它（`WEVIR_RESOURCES_DIR`），adapter-codex 先在
 * 这里找 codex-app-server 与提示词。
 *
 *   resources/engines/codex/codex-app-server[.exe]   锁定版本，scripts/fetch-codex.sh 按 sha256 校验
 *   resources/engines/codex/codex-resources/bwrap    只有 Linux（LGPL-2.0-or-later）
 *   resources/engines/codex/LICENSE、NOTICE          Codex 的 Apache-2.0 全文与署名（licenses/codex/，取自锁定提交）
 *   resources/prompts/                               仓库的 prompts/（不含 README.md）
 *   resources/host/                                  wevir-host（dist/main.js）与它的生产依赖：pnpm deploy 的 hoisted
 *                                                    布局（没有符号链接），不含 EXCLUDED_PACKAGES；桌面端用 Electron
 *                                                    自带的 Node 运行
 *
 * `--target` 默认是本机平台；打别的平台的安装包时给出那个平台的三元组（fetch-codex.sh 的列表），Host 的平台可选依赖
 * 也按它装。`WEVIR_GITHUB_MIRROR` 同 fetch-codex.sh。
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

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
 * - `@deepseek-ai/dsh`：adapter-dsh 的开发依赖（ADR-0007 决策 6：可选组件推迟期间，dsh 只在开发环境经 pnpm 安装），
 *   这里再拦一次；
 * - `@anthropic-ai/claude-agent-sdk`、`@cursor/sdk`：许可证是“All rights reserved”，维护者定不随应用再分发（ADR-0007
 *   补记 3）。没有它们时 Host 不挂 Claude 与 Cursor 引擎（host 的 engines.ts）。
 */
export const EXCLUDED_PACKAGES: readonly string[] = [
  'vitest',
  '@deepseek-ai/dsh',
  '@anthropic-ai/claude-agent-sdk',
  '@cursor/sdk',
];

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

/**
 * 安装包里的 Host 要满足的条件，不满足就报错：没有被排除的包；没有符号链接（签名与 extraResources 的复制都不处理它）；
 * 留下的包都没有安装脚本（deploy 用 `--ignore-scripts`，交叉准备别的平台时脚本也跑不了，新依赖需要脚本时要先在这里想清楚）。
 */
export function checkHostTree(root: string, excluded: readonly string[]): void {
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
      const scripts = readManifest(dir).scripts ?? {};
      for (const hook of ['preinstall', 'install', 'postinstall']) {
        if (scripts[hook] !== undefined) problems.push(`${name} 有 ${hook} 脚本`);
      }
      visitPackages(join(dir, 'node_modules'));
    }
  };
  visitPackages(join(root, 'node_modules'));
  if (problems.length > 0) throw new Error(`resources/host 不符合要求：\n${problems.join('\n')}`);
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

function stageCodex(dir: string, target: string): void {
  // 换了目标平台时不留上一个平台的文件（例如 Linux 的 bwrap）。
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  run('bash', [join(repo, 'scripts', 'fetch-codex.sh'), '--target', target, '--out', dir]);
  for (const file of ['LICENSE', 'NOTICE']) {
    copyFileSync(join(desktop, 'licenses', 'codex', file), join(dir, file));
  }
}

function stagePrompts(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  cpSync(join(repo, 'prompts'), dir, {
    recursive: true,
    filter: (source) => basename(source) !== 'README.md',
  });
}

function stageHost(dir: string, target: string): void {
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
  const removed = pruneDependencies(dir, EXCLUDED_PACKAGES);
  checkHostTree(dir, EXCLUDED_PACKAGES);
  console.log(
    `resources/host：去掉了 ${removed.length} 个包（${EXCLUDED_PACKAGES.join('、')} 与只被它们用到的）`,
  );
}

/** 按目标平台准备整个资源目录。 */
export function stageResources(target: string): void {
  const resources = join(desktop, 'resources');
  stageCodex(join(resources, 'engines', 'codex'), target);
  stagePrompts(join(resources, 'prompts'));
  stageHost(join(resources, 'host'), target);
  console.log(`资源目录已准备好（${target}）：${resources}`);
}

function main(): void {
  const { values } = parseArgs({ options: { target: { type: 'string' } } });
  stageResources(values.target ?? hostTarget());
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
