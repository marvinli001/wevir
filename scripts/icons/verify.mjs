import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = fileURLToPath(new URL('../../assets/icons/', import.meta.url));
const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
try {
  const social = JSON.parse(await fs.readFile(path.join(root, 'social-manifest.json'), 'utf8'));
  manifest.rasters.push(...social.rasters);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const failures = [];
async function check(name, fn) {
  try {
    await fn();
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}
async function raw(file) {
  return sharp(path.join(root, file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
}
for (const entry of manifest.rasters)
  await check(entry.path, async () => {
    const source = await fs.readFile(path.join(root, entry.source), 'utf8');
    assert(
      !/<(?:image|text)\b/.test(source),
      'export source must contain editable vector geometry, not raster images or font-dependent text',
    );
    const buffer = await fs.readFile(path.join(root, entry.path));
    if (entry.maxBytes)
      assert(buffer.length < entry.maxBytes, 'upload exceeds platform file budget');
    const meta = await sharp(buffer).metadata();
    assert.equal(meta.width, entry.width);
    assert.equal(meta.height, entry.height);
    assert.equal(createHash('sha256').update(buffer).digest('hex'), entry.sha256);
    if (entry.opaque)
      assert.equal(meta.hasAlpha, false, 'opaque delivery must have no alpha channel');
    if (entry.grayscale) {
      const { data, info } = await raw(entry.path);
      for (let i = 0; i < data.length; i += info.channels)
        assert(
          data[i] === data[i + 1] && data[i] === data[i + 2],
          'tinted pixels must be neutral grayscale',
        );
    }
  });
for (const points of [16, 18])
  for (const scale of [1, 2])
    await check(`macOS template ${points}@${scale}`, async () => {
      const { data, info } = await raw(
        `exports/macos/menubar/Wevir${points}Template${scale === 2 ? '@2x' : ''}.png`,
      );
      assert.equal(info.width, points * scale);
      let ink = 0;
      let clear = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3]) {
          assert(data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0);
          ink++;
        } else clear++;
      }
      assert(ink > 0 && clear > 0);
    });
for (const mode of ['light', 'dark'])
  await check(`Android ${mode} safe zone`, async () => {
    const file = `exports/android/res/drawable${mode === 'dark' ? '-night' : ''}-xxxhdpi/wevir_foreground.png`;
    const { data, info } = await raw(file);
    assert.equal(info.width, 432);
    let count = 0;
    for (let y = 0; y < info.height; y++)
      for (let x = 0; x < info.width; x++) {
        const a = data[(y * info.width + x) * 4 + 3];
        if (a > 16) {
          assert(
            Math.hypot((x + 0.5) / 4 - 54, (y + 0.5) / 4 - 54) <= 33,
            `ink outside 66dp safe circle at ${x},${y}`,
          );
          count++;
        }
      }
    assert(count > 1000);
  });
for (const mode of ['light', 'dark'])
  for (const tray of [false, true])
    await check(`Windows ${mode} ${tray ? 'tray' : 'app'}`, async () => {
      const b = await fs.readFile(
        path.join(root, `exports/windows/${mode}/Wevir${tray ? 'Tray' : ''}.ico`),
      );
      assert.equal(b.readUInt16LE(0), 0);
      assert.equal(b.readUInt16LE(2), 1);
      const sizes = [];
      let end = 6 + b.readUInt16LE(4) * 16;
      for (let i = 0; i < b.readUInt16LE(4); i++) {
        const p = 6 + i * 16;
        const size = b[p] || 256;
        const offset = b.readUInt32LE(p + 12);
        const length = b.readUInt32LE(p + 8);
        assert.equal(offset, end);
        const meta = await sharp(b.subarray(offset, offset + length)).metadata();
        assert.equal(meta.width, size);
        assert.equal(meta.height, size);
        sizes.push(size);
        end += length;
      }
      assert.equal(end, b.length);
      for (const size of tray ? [16, 20, 24, 32, 40, 48, 64] : [16, 24, 32, 48, 256])
        assert(sizes.includes(size));
    });
for (const mode of ['light', 'dark'])
  await check(`macOS ${mode} ICNS`, async () => {
    const b = await fs.readFile(path.join(root, `exports/macos/${mode}/Wevir.icns`));
    assert.equal(b.toString('ascii', 0, 4), 'icns');
    assert.equal(b.readUInt32BE(4), b.length);
    const types = [];
    let p = 8;
    while (p < b.length) {
      const type = b.toString('ascii', p, p + 4);
      const length = b.readUInt32BE(p + 4);
      assert(length > 8);
      const meta = await sharp(b.subarray(p + 8, p + length)).metadata();
      if (type === 'ic10') assert.equal(meta.width, 1024);
      types.push(type);
      p += length;
    }
    assert.equal(p, b.length);
    for (const type of [
      'icp4',
      'ic11',
      'icp5',
      'ic12',
      'ic07',
      'ic13',
      'ic08',
      'ic14',
      'ic09',
      'ic10',
    ])
      assert(types.includes(type));
  });
const catalog = JSON.parse(
  await fs.readFile(
    path.join(root, 'exports/ios/Assets.xcassets/AppIcon.appiconset/Contents.json'),
    'utf8',
  ),
);
for (const entry of catalog.images)
  await check(`iOS slot ${entry.filename}`, async () => {
    const meta = await sharp(
      path.join(root, 'exports/ios/Assets.xcassets/AppIcon.appiconset', entry.filename),
    ).metadata();
    assert.equal(meta.width, 1024);
    assert.equal(meta.height, 1024);
    if (entry.appearances?.[0]?.value === 'dark') assert(meta.hasAlpha);
  });
for (const mode of ['light', 'dark'])
  await check(`outlined wordmark ${mode}`, async () => {
    const svg = await fs.readFile(path.join(root, `exports/brand/${mode}/wordmark.svg`), 'utf8');
    assert(svg.includes('<path'));
    assert(!svg.includes('<text'));
  });
await check('ivory palette', async () => {
  assert.equal(manifest.palette.light.bg, '#F4F3ED');
});
await check('gallery image references', async () => {
  const html = await fs.readFile(path.join(root, 'preview/index.html'), 'utf8');
  for (const match of html.matchAll(/<img[^>]+src="([^"]+)"/g)) {
    const file = path.resolve(root, 'preview', match[1]);
    assert(file.startsWith(root), 'gallery must reference only packaged files');
    await fs.access(file);
  }
});
const iconDocument = path.join(root, 'source/Wevir.icon');
const srgb = (hex) =>
  `srgb:${[1, 3, 5].map((i) => (Number.parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(5)).join(',')},1.00000`;
const solid = (specs, appearance) =>
  specs?.find((spec) => spec.appearance === appearance)?.value?.solid;
await check('Icon Composer document', async () => {
  const doc = JSON.parse(await fs.readFile(path.join(iconDocument, 'icon.json'), 'utf8'));
  assert.equal(solid(doc['fill-specializations'], undefined), srgb(manifest.palette.light.bg));
  assert.equal(solid(doc['fill-specializations'], 'dark'), srgb(manifest.palette.dark.bg));
  // Two baked layers (metal mark over the gradient tile) with Liquid Glass off, so the system-drawn
  // icon matches the macOS ICNS and still switches to the dark variant.
  const layers = doc.groups.flatMap((group) => group.layers);
  const variants = (name) => [
    { value: `${name}-light.svg` },
    { appearance: 'dark', value: `${name}-dark.svg` },
  ];
  assert.deepEqual(
    layers.map((layer) => layer['image-name-specializations']),
    [variants('mark'), variants('tile')],
  );
  for (const layer of layers) {
    assert.equal(layer.glass, false, `${layer.name} must not get Liquid Glass`);
    assert.equal(layer['fill-specializations'], undefined, `${layer.name} keeps its own colours`);
  }
  for (const group of doc.groups) assert.equal(group.specular, false);
  const assets = (await fs.readdir(path.join(iconDocument, 'Assets'))).filter(
    (name) => !name.startsWith('.'),
  );
  assert.deepEqual(assets.sort(), [
    'mark-dark.svg',
    'mark-light.svg',
    'tile-dark.svg',
    'tile-light.svg',
  ]);
  for (const mode of ['light', 'dark'])
    for (const [asset, exported] of [
      ['mark', 'foreground-metal'],
      ['tile', 'background-tile'],
    ])
      assert.equal(
        await fs.readFile(path.join(iconDocument, `Assets/${asset}-${mode}.svg`), 'utf8'),
        await fs.readFile(path.join(root, `svg/apple-layers/${mode}/${exported}.svg`), 'utf8'),
        `Wevir.icon must use the exported ${mode} ${exported} layer unchanged`,
      );
});
// actool ships with Xcode, so the compile check only runs on macOS with Xcode 26 or later.
let actool = false;
if (process.platform === 'darwin') {
  try {
    execFileSync('xcrun', ['--find', 'actool'], { stdio: 'ignore' });
    actool = true;
  } catch {}
}
if (actool)
  for (const [platform, devices, target] of [
    ['macosx', ['mac'], '12.0'],
    ['iphoneos', ['iphone', 'ipad'], '17.0'],
  ])
    await check(`Wevir.icon actool ${platform}`, async () => {
      const out = await fs.mkdtemp(path.join(os.tmpdir(), 'wevir-icon-'));
      try {
        const plist = path.join(out, 'partial.plist');
        const log = execFileSync(
          'xcrun',
          [
            'actool',
            iconDocument,
            '--compile',
            out,
            '--app-icon',
            'Wevir',
            '--platform',
            platform,
            ...devices.flatMap((device) => ['--target-device', device]),
            '--minimum-deployment-target',
            target,
            '--output-partial-info-plist',
            plist,
            '--output-format',
            'human-readable-text',
          ],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        );
        assert(!/\.(?:warnings|errors) \*\//.test(log), log.trim());
        await fs.access(path.join(out, 'Assets.car'));
        assert.match(
          await fs.readFile(plist, 'utf8'),
          /<key>CFBundleIconName<\/key>\s*<string>Wevir<\/string>/,
        );
      } finally {
        await fs.rm(out, { recursive: true, force: true });
      }
    });
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    `Verified ${manifest.rasters.length} SVG/raster pairs, ICNS/ICO containers, menu templates, iOS slots, grayscale tinted assets, Android safe zones and the Icon Composer document${actool ? ' (compiled with actool)' : ' (actool not available, compile skipped)'}.`,
  );
