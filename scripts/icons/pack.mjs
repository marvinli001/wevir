import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const assets = path.join(repo, 'assets/icons');
const table = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const b of buffer) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
async function files(dir) {
  const result = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'release' || entry.name === '.DS_Store') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) result.push(...(await files(full)));
    else if (entry.isFile()) result.push(full);
  }
  return result.sort();
}
const payload = new Map();
for (const file of [...(await files(assets)), ...(await files(path.join(repo, 'scripts/icons')))]) {
  payload.set(path.relative(repo, file).split(path.sep).join('/'), await fs.readFile(file));
}
const pkg = JSON.parse(await fs.readFile(path.join(repo, 'package.json'), 'utf8'));
payload.set(
  'package.json',
  Buffer.from(
    `${JSON.stringify({ name: 'wevir-icons', version: '1.0.0', private: true, type: 'module', packageManager: pkg.packageManager, engines: pkg.engines, scripts: { 'icons:build': pkg.scripts['icons:build'], 'icons:check': pkg.scripts['icons:check'], 'icons:pack': pkg.scripts['icons:pack'] }, devDependencies: { sharp: pkg.devDependencies.sharp, '@biomejs/biome': pkg.devDependencies['@biomejs/biome'] } }, null, 2)}\n`,
  ),
);
payload.set(
  'README.md',
  Buffer.from(
    '# Wevir 图标资源包\n\n使用与目录说明见 assets/icons/README.md。\n\n安装 Node ≥ 24.15 与 pnpm 12.6 后执行 pnpm install、pnpm icons:build、pnpm icons:check。\n本包包含矢量源文件、位图、平台容器和可重复导出的脚本；不包含 Wevir 应用代码。\n',
  ),
);
payload.set('LICENSE', await fs.readFile(path.join(repo, 'LICENSE')));
payload.set('biome.json', await fs.readFile(path.join(repo, 'biome.json')));
payload.set('.gitignore', Buffer.from('node_modules/\n/assets/icons/release/\n'));
const locals = [];
const central = [];
let offset = 0;
// Fixed DOS timestamp makes identical inputs produce identical archives.
const dosDate = ((2026 - 1980) << 9) | (10 << 5) | 14;
for (const [filename, data] of [...payload].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
  const name = Buffer.from(filename);
  const compressed = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  assert(
    data.length < 0xffffffff && offset < 0xffffffff,
    'ZIP64 is not needed for this resource pack',
  );
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x800, 6);
  header.writeUInt16LE(8, 8);
  header.writeUInt16LE(dosDate, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(name.length, 26);
  locals.push(header, name, compressed);
  const record = Buffer.alloc(46);
  record.writeUInt32LE(0x02014b50, 0);
  record.writeUInt16LE(20, 4);
  record.writeUInt16LE(20, 6);
  record.writeUInt16LE(0x800, 8);
  record.writeUInt16LE(8, 10);
  record.writeUInt16LE(dosDate, 14);
  record.writeUInt32LE(crc, 16);
  record.writeUInt32LE(compressed.length, 20);
  record.writeUInt32LE(data.length, 24);
  record.writeUInt16LE(name.length, 28);
  record.writeUInt32LE(offset, 42);
  central.push(record, name);
  offset += header.length + name.length + compressed.length;
}
const directory = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(payload.size, 8);
end.writeUInt16LE(payload.size, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...locals, directory, end]);
await fs.mkdir(path.join(assets, 'release'), { recursive: true });
await fs.writeFile(path.join(assets, 'release/wevir-icons-v1.zip'), zip);
await fs.writeFile(
  path.join(assets, 'release/SHA256SUMS'),
  `${createHash('sha256').update(zip).digest('hex')}  wevir-icons-v1.zip\n`,
);
console.log(
  `Packed ${payload.size} files (${zip.length} bytes): assets/icons/release/wevir-icons-v1.zip`,
);
