/**
 * 准备随安装包分发的运行时（ADR-0007 决策 5）：`pnpm --filter @wevir/desktop resources [--target <三元组>]`。
 *
 * 产物在 `apps/desktop/resources/`（gitignore），打包时原样进入安装包的资源目录（electron-builder 的 `extraResources`，
 * 运行时是 `process.resourcesPath`）；桌面端拉起 Host 时把这个目录交给它（`WEVIR_RESOURCES_DIR`），adapter-codex 先在
 * 这里找 codex-app-server。
 *
 *   resources/engines/codex/codex-app-server[.exe]   锁定版本，scripts/fetch-codex.sh 按 sha256 校验
 *   resources/engines/codex/codex-resources/bwrap    只有 Linux（LGPL-2.0-or-later）
 *   resources/engines/codex/LICENSE、NOTICE          Codex 的 Apache-2.0 全文与署名（licenses/codex/，取自锁定提交）
 *
 * `--target` 默认是本机平台；打别的平台的安装包时给出那个平台的三元组（fetch-codex.sh 的列表）。
 * `WEVIR_GITHUB_MIRROR` 同 fetch-codex.sh。
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
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

function main(): void {
  const { values } = parseArgs({ options: { target: { type: 'string' } } });
  const target = values.target ?? hostTarget();
  const codexDir = join(desktop, 'resources', 'engines', 'codex');
  // 换了目标平台时不留上一个平台的文件（例如 Linux 的 bwrap）。
  rmSync(codexDir, { recursive: true, force: true });
  mkdirSync(codexDir, { recursive: true });
  const result = spawnSync(
    'bash',
    [join(repo, 'scripts', 'fetch-codex.sh'), '--target', target, '--out', codexDir],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
  for (const file of ['LICENSE', 'NOTICE']) {
    copyFileSync(join(desktop, 'licenses', 'codex', file), join(codexDir, file));
  }
  console.log(`资源目录已准备好（${target}）：${join(desktop, 'resources')}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
