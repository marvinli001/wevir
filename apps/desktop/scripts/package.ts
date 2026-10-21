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
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { hostTarget, nodePlatform, run, stageResources } from './stage-resources.ts';

const desktop = fileURLToPath(new URL('..', import.meta.url));

/** 目标平台对应的 electron-builder 参数。 */
export function builderArgs(target: string): string[] {
  const { os, cpu } = nodePlatform(target);
  const platform = os === 'darwin' ? '--mac' : os === 'win32' ? '--win' : '--linux';
  return [platform, `--${cpu}`];
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
  const iconArgs = nodePlatform(target).os === 'darwin' ? macIconArgs(localActoolVersion()) : [];
  if (iconArgs.length > 0) {
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
