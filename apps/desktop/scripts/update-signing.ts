/**
 * 更新清单的签名（ADR-0007 补记 4）：Ed25519，签清单文件的原始字节，签名（base64）写在旁边的 `<清单>.sig`。应用里内置公钥
 * （src/main/updates/keys.ts），清单验签不过就不下载。
 *
 *   node scripts/update-signing.ts keygen <私钥.pem>          生成密钥对：私钥写成 PKCS#8 PEM（0600，已存在时拒绝覆盖），
 *                                                              只打印公钥（SPKI DER 的 base64），把它加进 keys.ts
 *   node scripts/update-signing.ts sign <私钥.pem> <清单>...   给每份清单写 `<清单>.sig`；私钥也可以经环境变量
 *                                                              WEVIR_UPDATE_SIGNING_KEY（PEM 原文，CI 的 secret）给，这时第一个参数写 -
 *   node scripts/update-signing.ts verify <清单>...             用 keys.ts 里的公钥核对 `<清单>.sig`
 *
 * 私钥不进仓库、不打印；发布流水线用 GitHub Actions 的 secret。
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verifyManifest } from '../src/main/updates/feed.ts';
import { UPDATE_PUBLIC_KEYS } from '../src/main/updates/keys.ts';

/** PEM 私钥对应的公钥（SPKI DER 的 base64，keys.ts 的写法）。 */
export function publicKeyOf(privateKeyPem: string): string {
  const der = createPublicKey(createPrivateKey(privateKeyPem)).export({
    format: 'der',
    type: 'spki',
  });
  return Buffer.from(der).toString('base64');
}

/** 对清单字节的签名（base64）。 */
export function signManifest(manifest: Uint8Array, privateKeyPem: string): string {
  return sign(null, manifest, createPrivateKey(privateKeyPem)).toString('base64');
}

function readKey(path: string): string {
  if (path === '-') {
    const key = process.env.WEVIR_UPDATE_SIGNING_KEY;
    if (key === undefined || key.trim() === '')
      throw new Error('WEVIR_UPDATE_SIGNING_KEY is empty');
    return key;
  }
  return readFileSync(path, 'utf8');
}

function main(): void {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'keygen' && args.length === 1) {
    const [out] = args as [string];
    if (existsSync(out))
      throw new Error(`${out} already exists; refusing to overwrite a signing key`);
    const { privateKey } = generateKeyPairSync('ed25519');
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    writeFileSync(out, pem, { mode: 0o600 });
    console.log(publicKeyOf(pem));
    return;
  }
  if (command === 'sign' && args.length >= 2) {
    const [keyPath, ...files] = args as [string, ...string[]];
    const key = readKey(keyPath);
    for (const file of files) {
      writeFileSync(`${file}.sig`, `${signManifest(readFileSync(file), key)}\n`);
      console.log(`signed ${file}`);
    }
    return;
  }
  if (command === 'verify' && args.length >= 1) {
    let failed = false;
    for (const file of args) {
      const ok = verifyManifest(
        readFileSync(file),
        readFileSync(`${file}.sig`, 'utf8'),
        UPDATE_PUBLIC_KEYS,
      );
      console.log(`${ok ? 'ok' : 'FAILED'} ${file}`);
      failed ||= !ok;
    }
    if (failed) process.exit(1);
    return;
  }
  console.error(
    'usage: update-signing.ts keygen <key.pem> | sign <key.pem|-> <manifest>... | verify <manifest>...',
  );
  process.exit(2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
