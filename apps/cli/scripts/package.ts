/**
 * 打自带 Node 的命令行包（ADR-0007 补记 13）：`pnpm --filter @wevir/cli package [--target <三元组>] [--version <版本>]`。
 * 要先在仓库根目录 `pnpm build`（Host 的 dist/，同桌面端的资源目录；CLI 自己从源码打包）。不装桌面端也能用，Linux 服务器上同样。
 *
 * 产物在 `apps/cli/release/`（gitignore）：`wevir-cli-<版本>-<平台>-<架构>.tar.gz`（Windows 是 `.zip`），平台与架构的写法同桌面端的
 * 发布目录（`linux-x64`、`darwin-arm64`、`win32-x64`）。解开是同名的目录：
 *
 *   bin/wevir                     启动脚本（Windows 是 bin/wevir.cmd）：用包里的 Node 跑 lib/cli/main.js，跟着符号链接找 lib/
 *   lib/node/node[.exe]、LICENSE  Node 官方发布包里的可执行文件与许可证（版本跟 .node-version，按 SHASUMS256.txt 核对 sha256）
 *   lib/cli/                      CLI 打成的 bundle（rolldown，从源码打，工作区包与 ws、mute-stream 都打进去）
 *   lib/host/、lib/engines/codex/、lib/prompts/
 *                                 与桌面端资源目录相同的布局，由 apps/desktop/scripts/stage-resources.ts 的 stageHost、stageCodex、
 *                                 stagePrompts 准备；`wevir host start` 用包里的 Node 拉起 lib/host，并把 lib/ 作为 WEVIR_RESOURCES_DIR
 *                                 交给它（apps/cli/src/commands/host.ts 的 bundledResourcesDir）
 *   LICENSE、NOTICE               仓库根目录的
 *   THIRD_PARTY_LICENSES.txt      打进两个 bundle 与 lib/host/node_modules 里的 npm 包的许可证（Codex 与 ripgrep 的在 lib/engines/codex/，
 *                                 Node 的在 lib/node/）
 *
 * 没有 macOS 的电脑操作 helper（它要随应用签名，系统权限也是按应用给的）：命令行包里的 Host 不提供电脑操作。
 * Linux 的 Node 是官方的 glibc 版（glibc 2.28 起），codex-app-server 是 musl 静态的；Alpine 这类 musl 系统上 Node 跑不起来。
 *
 * 环境变量：`WEVIR_NODE_MIRROR` 替换 `https://nodejs.org/dist` 前缀（大陆网络，例如 `https://npmmirror.com/mirrors/node`），
 * SHASUMS256.txt 也从那里取；`WEVIR_GITHUB_MIRROR` 同 scripts/fetch-codex.sh。下载的 Node 缓存在 `.wevir-dev/node/`。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { type OutputChunk, rolldown } from 'rolldown';
import {
  checkBundleImports,
  hostTarget,
  nodePlatform,
  stageCodex,
  stageHost,
  stagePrompts,
} from '../../desktop/scripts/stage-resources.ts';

const cli = fileURLToPath(new URL('..', import.meta.url));
const repo = join(cli, '..', '..');

/** ws 在 try 里 require 的可选原生加速包，不打进来（同 stage-resources.ts）。 */
const WS_OPTIONAL_NATIVE: readonly string[] = ['bufferutil', 'utf-8-validate'];

/** 发布目录与产物名里的平台目录（`linux-x64`），同桌面端（src/main/updates/feed.ts）。 */
export function platformDir(target: string): string {
  const { os, cpu } = nodePlatform(target);
  return `${os}-${cpu}`;
}

/** 产物的文件名：`wevir-cli-<版本>-<平台>-<架构>.tar.gz`，Windows 是 `.zip`。 */
export function archiveName(version: string, target: string): string {
  const ext = nodePlatform(target).os === 'win32' ? 'zip' : 'tar.gz';
  return `wevir-cli-${version}-${platformDir(target)}.${ext}`;
}

/** Node 官方发布包的文件名与包里的根目录（`node-v24.22.1-linux-x64`）。Windows 是 zip，其余用 tar.gz。 */
export function nodeDist(version: string, target: string): { file: string; root: string } {
  const { os, cpu } = nodePlatform(target);
  const root = `node-v${version}-${os === 'win32' ? 'win' : os}-${cpu}`;
  return { file: `${root}.${os === 'win32' ? 'zip' : 'tar.gz'}`, root };
}

/** SHASUMS256.txt 里某个文件的 sha256；没有这一行时返回 undefined。 */
export function shasumOf(shasums: string, file: string): string | undefined {
  for (const line of shasums.split('\n')) {
    const match = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/.exec(line);
    if (match?.[2] === file) return match[1];
  }
  return undefined;
}

/**
 * Unix 的启动脚本。`~/.local/bin/wevir` 这类符号链接指过来时先逐级解开（只用 POSIX 的 readlink，macOS 也有），再按自己所在的
 * 目录找 `../lib`。
 */
export const UNIX_LAUNCHER = `#!/bin/sh
# wevir：用包里的 Node 运行 Wevir 命令行客户端。
self=$0
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case $link in
    /*) self=$link ;;
    *) self=$(dirname "$self")/$link ;;
  esac
done
lib=$(cd "$(dirname "$self")/../lib" && pwd -P) || exit 1
exec "$lib/node/node" "$lib/cli/main.js" "$@"
`;

/** Windows 的启动脚本（CRLF）。`setlocal` 不让变量漏到调用方的 cmd 里，退出码原样交回。 */
export const WINDOWS_LAUNCHER = [
  '@echo off',
  'rem wevir: run the Wevir command-line client with the bundled Node.',
  'setlocal',
  'set "WEVIR_LIB=%~dp0..\\lib"',
  '"%WEVIR_LIB%\\node\\node.exe" "%WEVIR_LIB%\\cli\\main.js" %*',
  'exit /b %ERRORLEVEL%',
  '',
].join('\r\n');

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

async function download(url: string, file: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok || response.body === null) {
    throw new Error(`下载 ${url} 失败：HTTP ${response.status}`);
  }
  const partial = `${file}.partial`;
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  renameSync(partial, file);
}

/** 取 Node 官方发布包（有缓存且校验和对得上就不再下载），解出可执行文件与 LICENSE 到 `dir`。 */
async function stageNode(dir: string, target: string): Promise<string> {
  const version = readFileSync(join(repo, '.node-version'), 'utf8').trim();
  const base = (process.env.WEVIR_NODE_MIRROR?.trim() || 'https://nodejs.org/dist').replace(
    /\/+$/,
    '',
  );
  const { file, root } = nodeDist(version, target);
  const cache = join(repo, '.wevir-dev', 'node');
  mkdirSync(cache, { recursive: true });
  const shasums = await fetch(`${base}/v${version}/SHASUMS256.txt`, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!shasums.ok)
    throw new Error(`下载 ${base}/v${version}/SHASUMS256.txt 失败：HTTP ${shasums.status}`);
  const expected = shasumOf(await shasums.text(), file);
  if (expected === undefined) throw new Error(`SHASUMS256.txt 里没有 ${file}`);
  const archive = join(cache, file);
  if (!existsSync(archive) || (await sha256File(archive)) !== expected) {
    await download(`${base}/v${version}/${file}`, archive);
  }
  const actual = await sha256File(archive);
  if (actual !== expected) {
    rmSync(archive, { force: true });
    throw new Error(`${file} 的 sha256 是 ${actual}，SHASUMS256.txt 里是 ${expected}`);
  }

  const { os } = nodePlatform(target);
  const exe = os === 'win32' ? 'node.exe' : 'node';
  const inner = os === 'win32' ? `${root}/${exe}` : `${root}/bin/${exe}`;
  const temp = join(tmpdir(), `wevir-node-${process.pid}`);
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(temp, { recursive: true });
  try {
    // bsdtar（macOS、Windows 10 起的 System32\tar.exe）也读 zip；GNU tar 不读，Linux 上解 zip 用 unzip。
    const zipOnGnu = os === 'win32' && process.platform === 'linux';
    run(
      zipOnGnu ? 'unzip' : systemTar(),
      zipOnGnu
        ? ['-q', archive, inner, `${root}/LICENSE`, '-d', temp]
        : ['-xf', archive, '-C', temp, inner, `${root}/LICENSE`],
    );
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    copyFileSync(join(temp, inner), join(dir, exe));
    copyFileSync(join(temp, root, 'LICENSE'), join(dir, 'LICENSE'));
    chmodSync(join(dir, exe), 0o755);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  console.log(`lib/node：Node ${version}（${file}，sha256 ${expected}）`);
  return version;
}

/** Windows 上用系统自带的 bsdtar（Git Bash 的 GNU tar 在 PATH 前面时不认 zip，也不认 `C:\` 这样的路径）。 */
function systemTar(): string {
  if (process.platform !== 'win32') return 'tar';
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
}

function run(command: string, args: readonly string[], cwd: string = repo): void {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    // macOS 的 tar 不写 ._ 文件与扩展属性（GNU tar 解开时会告警）。
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  if (result.error) throw new Error(`运行 ${command} 失败：${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 退出码 ${result.status}`);
}

/**
 * 把 CLI 从源码打成 `dir` 下的 bundle：工作区包按 `@wevir/source` 条件取源码（`.js` 的相对导入解析到 `.ts`），第三方依赖都打进去，
 * `package.json` 的版本换成 `version`（`wevir --version`）。返回打进去的模块路径。
 */
export async function bundleCli(dir: string, version: string): Promise<string[]> {
  const manifestPath = join(cli, 'package.json');
  const bundle = await rolldown({
    input: join(cli, 'src', 'main.ts'),
    platform: 'node',
    resolve: {
      conditionNames: ['@wevir/source', 'node', 'import', 'default'],
      extensionAlias: { '.js': ['.ts', '.js'] },
    },
    external: (id) => WS_OPTIONAL_NATIVE.includes(id),
    logLevel: 'warn',
    plugins: [
      {
        name: 'wevir-cli-version',
        load(id) {
          if (id !== manifestPath) return null;
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as object;
          return JSON.stringify({ ...manifest, version });
        },
      },
    ],
  });
  try {
    rmSync(dir, { recursive: true, force: true });
    const { output } = await bundle.write({
      dir,
      format: 'esm',
      entryFileNames: 'main.js',
      chunkFileNames: '[name]-[hash].js',
    });
    const chunks = output.filter((item): item is OutputChunk => item.type === 'chunk');
    checkBundleImports(chunks, WS_OPTIONAL_NATIVE);
    writeFileSync(
      join(dir, 'package.json'),
      `${JSON.stringify({ name: 'wevir-cli', private: true, type: 'module', version }, null, 2)}\n`,
    );
    return chunks.flatMap((chunk) => chunk.moduleIds);
  } finally {
    await bundle.close();
  }
}

/** 模块路径所在的 npm 包的根目录（最后一个 `node_modules/` 之后的包名）；不在 node_modules 里（工作区源码、虚拟模块）时返回 undefined。 */
export function packageRootOf(id: string): string | undefined {
  const match = /^(.*[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]+)[\\/]/.exec(id);
  return match?.[1];
}

interface LicenseEntry {
  name: string;
  version: string;
  license: string;
  texts: string[];
}

const LICENSE_FILE = /^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/i;

/** 第三方声明的收集：按包名与版本去重；工作区包（`@wevir/*`）是 Wevir 自己的代码，由 LICENSE 覆盖，不收。 */
export class ThirdPartyLicenses {
  readonly #entries = new Map<string, LicenseEntry>();

  /** 记下一个包（`dir` 是包的根目录），立即读它的文件：Host 的依赖在 bundle 之后就删掉了。 */
  addPackage(dir: string): void {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name?: string;
      version?: string;
      license?: unknown;
    };
    const name = manifest.name ?? dir;
    if (name.startsWith('@wevir/')) return;
    const key = `${name}@${manifest.version ?? ''}`;
    if (this.#entries.has(key)) return;
    const texts = readdirSync(dir)
      .filter((file) => LICENSE_FILE.test(file))
      .sort()
      .map((file) => readFileSync(join(dir, file), 'utf8').trim());
    this.#entries.set(key, {
      name,
      version: manifest.version ?? '',
      license: typeof manifest.license === 'string' ? manifest.license : 'UNKNOWN',
      texts,
    });
  }

  addModules(ids: readonly string[]): void {
    const roots = new Set(ids.map(packageRootOf).filter((dir) => dir !== undefined));
    for (const dir of roots) this.addPackage(dir);
  }

  /** `node_modules` 下（含嵌套的）所有包。 */
  addTree(nodeModules: string): void {
    if (!existsSync(nodeModules)) return;
    for (const entry of readdirSync(nodeModules)) {
      if (entry.startsWith('.')) continue;
      const names = entry.startsWith('@')
        ? readdirSync(join(nodeModules, entry)).map((name) => join(entry, name))
        : [entry];
      for (const name of names) {
        const dir = join(nodeModules, name);
        if (!existsSync(join(dir, 'package.json'))) continue;
        this.addPackage(dir);
        this.addTree(join(dir, 'node_modules'));
      }
    }
  }

  get size(): number {
    return this.#entries.size;
  }

  render(): string {
    const entries = [...this.#entries.values()].sort((a, b) =>
      a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
    );
    const rule = '-'.repeat(80);
    const parts = [
      'Third-party software in the Wevir command-line package',
      '',
      'npm packages bundled into lib/cli/ and lib/host/dist/, and the packages kept in lib/host/node_modules/.',
      'Node.js: lib/node/LICENSE. OpenAI Codex: lib/engines/codex/LICENSE and NOTICE.',
      'ripgrep (lib/engines/codex/codex-path/rg): lib/engines/codex/ripgrep/LICENSE-MIT and UNLICENSE.',
    ];
    for (const entry of entries) {
      parts.push('', rule, `${entry.name} ${entry.version} (${entry.license})`, rule);
      parts.push(
        entry.texts.length > 0 ? entry.texts.join('\n\n') : '(no license file in the package)',
      );
    }
    return `${parts.join('\n')}\n`;
  }
}

/** 打一个目标平台的包，返回产物路径。 */
export async function packageCli(target: string, version: string): Promise<string> {
  const { os } = nodePlatform(target);
  const release = join(cli, 'release');
  const name = archiveName(version, target).replace(/\.(?:tar\.gz|zip)$/, '');
  const root = join(release, name);
  rmSync(root, { recursive: true, force: true });
  const lib = join(root, 'lib');
  mkdirSync(join(root, 'bin'), { recursive: true });

  const licenses = new ThirdPartyLicenses();
  await stageNode(join(lib, 'node'), target);
  licenses.addModules(await bundleCli(join(lib, 'cli'), version));
  console.log('lib/cli：CLI 的 bundle');
  stageCodex(join(lib, 'engines', 'codex'), target);
  stagePrompts(join(lib, 'prompts'));
  await stageHost(join(lib, 'host'), target, (ids) => licenses.addModules(ids));
  licenses.addTree(join(lib, 'host', 'node_modules'));

  if (os === 'win32') {
    writeFileSync(join(root, 'bin', 'wevir.cmd'), WINDOWS_LAUNCHER);
  } else {
    writeFileSync(join(root, 'bin', 'wevir'), UNIX_LAUNCHER, { mode: 0o755 });
    chmodSync(join(root, 'bin', 'wevir'), 0o755);
  }
  for (const file of ['LICENSE', 'NOTICE']) copyFileSync(join(repo, file), join(root, file));
  writeFileSync(join(root, 'THIRD_PARTY_LICENSES.txt'), licenses.render());
  console.log(`THIRD_PARTY_LICENSES.txt：${licenses.size} 个 npm 包`);

  const archive = join(release, archiveName(version, target));
  rmSync(archive, { force: true });
  if (os !== 'win32') {
    run(systemTar(), ['-czf', archive, '-C', release, name]);
  } else if (process.platform === 'linux') {
    run('zip', ['-qr', archive, name], release);
  } else {
    // bsdtar 按扩展名 .zip 写 zip（-a）。
    run(systemTar(), ['-a', '-cf', archive, '-C', release, name]);
  }
  console.log(`命令行包已打好（${target}）：${archive}`);
  return archive;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { target: { type: 'string' }, version: { type: 'string' } },
  });
  const manifest = JSON.parse(readFileSync(join(cli, 'package.json'), 'utf8')) as {
    version: string;
  };
  await packageCli(values.target ?? hostTarget(), values.version ?? manifest.version);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
