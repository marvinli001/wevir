/**
 * 打安装包：`pnpm --filter @wevir/desktop package [--target <三元组>] [-- <electron-builder 的参数>]`。
 * 要先在仓库根目录 `pnpm build`。依次：按目标平台准备资源目录（stage-resources.ts）→ electron-vite build →
 * electron-builder（electron-builder.yml），产物在 `apps/desktop/release/`（gitignore）。
 *
 * `--app-version <版本>` 指定安装包的版本（electron-builder 的 `extraMetadata.version`，应用里的 `app.getVersion()`），不改
 * package.json；开发版写成 `X.Y.Z-beta.N`，electron-builder 据此写 `beta-*.yml`（ADR-0007 补记 2、4）。
 *
 * `--target` 默认是本机平台（fetch-codex.sh 的三元组），决定资源目录里 codex-app-server 与 Host 平台依赖的平台，
 * 以及交给 electron-builder 的 `--mac` / `--win` / `--linux` 与 `--arm64` / `--x64`。签名与公证的条件见
 * electron-builder.yml。
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { hostTarget, nodePlatform, run, stageResources } from './stage-resources.ts';

const desktop = fileURLToPath(new URL('..', import.meta.url));

/**
 * 目标平台对应的 electron-builder 参数。Linux 的 `${arch}` 按包格式换名字（AppImage 是 x86_64 / aarch64，deb 是 amd64），这里
 * 把安装包名里的架构固定成 Node 的写法（x64 / arm64），与发布目录 `linux-<架构>` 和 scripts/release.ts 认的名字一致。
 */
export function builderArgs(target: string): string[] {
  const { os, cpu } = nodePlatform(target);
  if (os === 'linux') {
    return [
      '--linux',
      `--${cpu}`,
      `-c.linux.artifactName=\${productName}-\${version}-linux-${cpu}.\${ext}`,
    ];
  }
  return [os === 'darwin' ? '--mac' : '--win', `--${cpu}`];
}

/** Linux 的图标：hicolor 的浅色一套（文件名都是 wevir，与 electron-builder.yml 的 executableName 一致）。 */
export const LINUX_HICOLOR = join(
  desktop,
  '..',
  '..',
  'assets',
  'icons',
  'exports',
  'linux',
  'light',
  'hicolor',
);

/**
 * electron-builder 的 Linux 图标要一个平铺的目录（`<尺寸>x<尺寸>.png`），不认 hicolor 的 `<尺寸>/apps/wevir.png` 层级：从
 * `hicolor` 复制到 `dest`，返回复制了的尺寸。scalable 的 SVG 不带（electron-builder 只从目录里收 PNG）。
 */
export function stageLinuxIcons(hicolor: string, dest: string): string[] {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  const sizes: string[] = [];
  for (const entry of readdirSync(hicolor).sort()) {
    const file = join(hicolor, entry, 'apps', 'wevir.png');
    if (!/^\d+x\d+$/.test(entry) || !existsSync(file)) continue;
    copyFileSync(file, join(dest, `${entry}.png`));
    sizes.push(entry);
  }
  if (sizes.length === 0) throw new Error(`no hicolor PNG icons in ${hicolor}`);
  return sizes;
}

/** 没有 Xcode 26 的 actool 时 macOS 安装包用的图标：浅色 ICNS，没有深色，启动后由 main/app-icon.ts 换程序坞图标。 */
export const MAC_FALLBACK_ICON = '../../assets/icons/exports/macos/light/Wevir.icns';

/** `actool --version` 输出（plist）里的版本号；没装 Xcode（只有命令行工具）时 actool 报错，返回 undefined。 */
export function actoolVersion(output: string): string | undefined {
  return /<key>short-bundle-version<\/key>\s*<string>([\d.]+)<\/string>/.exec(output)?.[1];
}

/**
 * macOS 安装包的图标参数：electron-builder.yml 的 mac.icon 是 Icon Composer 工程，要 actool 26 起才能编译；版本不够时改用
 * MAC_FALLBACK_ICON，不让整个打包失败。
 */
export function macIconArgs(version: string | undefined): string[] {
  const major = version === undefined ? 0 : Number.parseInt(version, 10);
  return major >= 26 ? [] : [`-c.mac.icon=${MAC_FALLBACK_ICON}`];
}

function localActoolVersion(): string | undefined {
  const result = spawnSync('actool', ['--version'], { encoding: 'utf8' });
  return result.status === 0 ? actoolVersion(result.stdout) : undefined;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: { target: { type: 'string' }, 'app-version': { type: 'string' } },
    allowPositionals: true,
  });
  const target = values.target ?? hostTarget();
  const { os } = nodePlatform(target);
  const iconArgs = os === 'darwin' ? macIconArgs(localActoolVersion()) : [];
  if (os === 'linux') {
    // 放在产物目录下（gitignore），electron-builder 自己转换出的图标也在那里（.icon-set）。
    const dir = join(desktop, 'release', '.linux-icons');
    stageLinuxIcons(LINUX_HICOLOR, dir);
    iconArgs.push(`-c.linux.icon=${dir}`);
  }
  if (os === 'darwin' && iconArgs.length > 0) {
    console.warn(
      '没有 Xcode 26 的 actool：macOS 安装包改用浅色 ICNS，图标不会在应用没启动时跟随系统的深色外观。',
    );
  }
  await stageResources(target);
  run('pnpm', ['exec', 'electron-vite', 'build'], desktop);
  run(
    'pnpm',
    [
      'exec',
      'electron-builder',
      '--config',
      'electron-builder.yml',
      // 不经 electron-builder 上传（CI 里它会自作主张发布）；发布目录由 scripts/release-dir.ts 整理。
      '--publish',
      'never',
      ...builderArgs(target),
      ...iconArgs,
      ...(values['app-version'] !== undefined
        ? [`-c.extraMetadata.version=${values['app-version']}`]
        : []),
      ...positionals,
    ],
    desktop,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
