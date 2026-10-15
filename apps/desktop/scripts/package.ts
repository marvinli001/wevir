/**
 * 打安装包：`pnpm --filter @wevir/desktop package [--target <三元组>] [-- <electron-builder 的参数>]`。
 * 要先在仓库根目录 `pnpm build`。依次：按目标平台准备资源目录（stage-resources.ts）→ electron-vite build →
 * electron-builder（electron-builder.yml），产物在 `apps/desktop/release/`（gitignore）。
 *
 * `--target` 默认是本机平台（fetch-codex.sh 的三元组），决定资源目录里 codex-app-server 与 Host 平台依赖的平台，
 * 以及交给 electron-builder 的 `--mac` / `--win` / `--linux` 与 `--arm64` / `--x64`。签名与公证的条件见
 * electron-builder.yml。
 */
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

function main(): void {
  const { values, positionals } = parseArgs({
    options: { target: { type: 'string' } },
    allowPositionals: true,
  });
  const target = values.target ?? hostTarget();
  stageResources(target);
  run('pnpm', ['exec', 'electron-vite', 'build'], desktop);
  run(
    'pnpm',
    [
      'exec',
      'electron-builder',
      '--config',
      'electron-builder.yml',
      ...builderArgs(target),
      ...positionals,
    ],
    desktop,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
