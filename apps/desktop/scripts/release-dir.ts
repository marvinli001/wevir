/**
 * 把一次打包的产物整理成两条下载线路共用的发布目录，并签好更新清单（ADR-0007 补记 4）：
 *
 *   node scripts/release-dir.ts --out <目录> [--target <三元组>] [--key <私钥.pem> | --key -]
 *
 * 读 `apps/desktop/release/` 里 electron-builder 写的更新清单（`latest-mac.yml` / `beta-mac.yml`，Windows 是 `latest.yml` /
 * `beta.yml`，Linux 是 `latest-linux.yml`、arm64 是 `latest-linux-arm64.yml`，列着 AppImage 与 deb），把清单、清单列出的文件与它们的 blockmap 复制到 `<目录>/desktop/<平台>-<架构>/`，给清单写 `<清单>.sig`，
 * 最后用应用内置的公钥（src/main/updates/keys.ts）核对一遍：对不上就失败，不留下客户端验不过的发布目录。
 * `--key -` 从环境变量 WEVIR_UPDATE_SIGNING_KEY 读私钥（CI 的 secret）；默认 `~/.wevir-release/update-signing-key.pem`。
 *
 * 上传时把 `<目录>` 原样同步到每条线路的根：先传安装包与 blockmap，最后传清单与签名（清单只许更高的版本覆盖，发布流水线
 * 负责）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { manifestFile, parseManifest, verifyManifest } from '../src/main/updates/feed.ts';
import { UPDATE_PUBLIC_KEYS } from '../src/main/updates/keys.ts';
import { hostTarget, nodePlatform } from './stage-resources.ts';
import { signManifest } from './update-signing.ts';

const desktop = fileURLToPath(new URL('..', import.meta.url));

/** 一份清单要放进发布目录的文件：清单本身、它列出的文件，以及存在的 blockmap。 */
export function releaseFiles(
  manifestName: string,
  manifestText: string,
  exists: (name: string) => boolean,
): string[] {
  const info = parseManifest(manifestText);
  const files = new Set<string>([manifestName]);
  for (const file of info.files) {
    files.add(file.url);
    if (exists(`${file.url}.blockmap`)) files.add(`${file.url}.blockmap`);
  }
  return [...files];
}

function readSigningKey(path: string): string {
  if (path === '-') {
    const key = process.env.WEVIR_UPDATE_SIGNING_KEY;
    if (key === undefined || key.trim() === '')
      throw new Error('WEVIR_UPDATE_SIGNING_KEY is empty');
    return key;
  }
  return readFileSync(path, 'utf8');
}

function main(): void {
  const { values } = parseArgs({
    options: { out: { type: 'string' }, target: { type: 'string' }, key: { type: 'string' } },
  });
  if (values.out === undefined) {
    console.error('usage: release-dir.ts --out <dir> [--target <triple>] [--key <key.pem>|-]');
    process.exit(2);
  }
  const { os, cpu } = nodePlatform(values.target ?? hostTarget());
  const source = join(desktop, 'release');
  const dest = join(values.out, 'desktop', `${os}-${cpu}`);
  const key = readSigningKey(
    values.key ?? join(homedir(), '.wevir-release', 'update-signing-key.pem'),
  );
  const manifests = ['latest', 'beta']
    .map((name) => manifestFile(name, os, cpu))
    .filter((name) => existsSync(join(source, name)));
  if (manifests.length === 0)
    throw new Error(`no update manifest in ${source}; run pnpm package first`);
  mkdirSync(dest, { recursive: true });
  for (const manifest of manifests) {
    const text = readFileSync(join(source, manifest));
    for (const file of releaseFiles(manifest, text.toString('utf8'), (name) =>
      existsSync(join(source, name)),
    )) {
      copyFileSync(join(source, file), join(dest, file));
    }
    const signature = signManifest(text, key);
    writeFileSync(join(dest, `${manifest}.sig`), `${signature}\n`);
    if (!verifyManifest(text, signature, UPDATE_PUBLIC_KEYS)) {
      throw new Error(
        `${manifest}: the signing key does not match any public key in src/main/updates/keys.ts`,
      );
    }
    console.log(`${manifest} → ${dest}（已签名，${parseManifest(text.toString('utf8')).version}）`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
