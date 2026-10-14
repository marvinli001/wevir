import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { defs, geometry, logoBody, modes } from './design.mjs';

const root = fileURLToPath(new URL('../../assets/icons/', import.meta.url));
const out = path.join(root, 'exports');
const ui = JSON.parse(await fs.readFile(path.join(root, 'source/ui-paths.json'), 'utf8'));
const word = JSON.parse(await fs.readFile(path.join(root, 'source/wordmark-paths.json'), 'utf8'));
const entries = [];
const fontNotice =
  '<!-- Wordmark outlines: github/mona-sans, fonts/static/ttf/MonaSans-Bold.ttf; commit 4bc6ba8b354c36b4fb66d32cd67b4c1f2beb0a06; SIL OFL-1.1. See source/fonts/OFL.txt. -->';
const xml = (body, size, viewBox = '0 0 32 32') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${viewBox}">${body}</svg>`;
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

async function write(relative, value) {
  if (
    relative.endsWith('.svg') &&
    typeof value === 'string' &&
    !/<svg[^>]*(?:aria-label|aria-hidden)=/.test(value)
  ) {
    value = value.replace(
      '<svg ',
      `<svg role="img" aria-label="Wevir ${path.basename(relative, '.svg')}" `,
    );
  }
  const dest = path.join(root, relative);
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, value);
  return dest;
}
async function asset(relative, source, { opaque = false, grayscale = false, logicalSize } = {}) {
  const svgPath = relative.replace(/^exports\//, 'svg/').replace(/\.png$/, '.svg');
  await write(svgPath, source);
  let raster = sharp(Buffer.from(source));
  if (opaque) raster = raster.removeAlpha();
  if (grayscale) raster = raster.grayscale().toColourspace('srgb');
  const buffer = await raster.png().toBuffer();
  const meta = await sharp(buffer).metadata();
  await write(relative, buffer);
  entries.push({
    path: relative,
    source: svgPath,
    width: meta.width,
    height: meta.height,
    alpha: meta.hasAlpha,
    opaque,
    grayscale,
    logicalSize: logicalSize ?? meta.width,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  });
  return buffer;
}
const mark = (mode, size, logicalSize = size) =>
  xml(`${defs()}${logoBody(mode, { detail: logicalSize >= 64, tiny: logicalSize <= 18 })}`, size);
const flat = (color, size, view = '0 0 32 32') =>
  xml(`<path d="${geometry}" fill="${color}"/>`, size, view);

function app(mode, size, platform = 'desktop', logicalSize = size) {
  const background = mode === 'light' ? 'tile-warm' : 'tile';
  const small = logicalSize <= 32;
  const inset = platform === 'macos' ? 100 : 40;
  const extent = 1024 - inset * 2;
  const radius = platform === 'macos' ? 184 : 188;
  const glyphSize = small ? 800 : 560;
  const start = (1024 - glyphSize) / 2;
  const body = `${defs()}
  ${platform === 'macos' && !small ? `<rect x="${inset}" y="${inset + 12}" width="${extent}" height="${extent}" rx="${radius}" fill="#000" opacity=".16" filter="url(#tile-shadow)"/>` : ''}
  <rect x="${inset}" y="${inset}" width="${extent}" height="${extent}" rx="${radius}" fill="url(#${background})" stroke="${mode === 'light' ? '#D1CFC5' : '#56595D'}" stroke-width="${small ? 0 : 1.5}"/>
  <g transform="translate(${start} ${start}) scale(${glyphSize / 32})">${small ? `<path d="${geometry}" fill="${modes[mode].flat}"/>` : logoBody(mode, { carrier: true, detail: logicalSize >= 64 })}</g>`;
  return xml(body, size, '0 0 1024 1024');
}
function fullBleed(mode, size, { transparent = false, tinted = false } = {}) {
  const body = `${defs()}${transparent ? '' : `<rect width="1024" height="1024" fill="${tinted ? (mode === 'light' ? '#E5E5E5' : '#262626') : modes[mode].bg}"/>`}
  <g transform="translate(232 232) scale(17.5)">${tinted ? `<path d="${geometry}" fill="${mode === 'light' ? '#262626' : '#E5E5E5'}"/>` : logoBody(mode, { detail: true })}</g>`;
  return xml(body, size, '0 0 1024 1024');
}
function ico(frames) {
  const header = Buffer.alloc(6 + frames.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach(({ size, buffer }, i) => {
    const p = 6 + i * 16;
    header[p] = size === 256 ? 0 : size;
    header[p + 1] = header[p];
    header.writeUInt16LE(1, p + 4);
    header.writeUInt16LE(32, p + 6);
    header.writeUInt32LE(buffer.length, p + 8);
    header.writeUInt32LE(offset, p + 12);
    offset += buffer.length;
  });
  return Buffer.concat([header, ...frames.map((f) => f.buffer)]);
}
function icns(frames) {
  const chunks = frames.map(({ type, buffer }) => {
    const head = Buffer.alloc(8);
    head.write(type, 0, 4, 'ascii');
    head.writeUInt32BE(buffer.length + 8, 4);
    return Buffer.concat([head, buffer]);
  });
  const head = Buffer.alloc(8);
  head.write('icns');
  head.writeUInt32BE(8 + chunks.reduce((sum, b) => sum + b.length, 0), 4);
  return Buffer.concat([head, ...chunks]);
}

// Brand master, material, monochrome, outlined wordmark and lockups.
await write('exports/brand/mark.svg', flat('currentColor', 32));
for (const mode of Object.keys(modes)) {
  for (const size of [16, 18, 20, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    await asset(`exports/brand/${mode}/mark-${size}.png`, mark(mode, size));
  }
  const [left, top, right, bottom] = word.bounds;
  const w = right - left;
  const h = bottom - top;
  const paths = `<g transform="translate(${-left} ${-top})" fill="${modes[mode].ink}">${word.paths.map((d) => `<path d="${d}"/>`).join('')}</g>`;
  await write(
    `exports/brand/${mode}/wordmark.svg`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${fontNotice}${paths}</svg>`,
  );
  const wordScale = 68 / h;
  const width = Math.ceil(124 + w * wordScale);
  const lockup = `${defs()}<g transform="translate(0 2) scale(2.25)">${logoBody(mode, { detail: false })}</g><g transform="translate(94 6) scale(${wordScale})">${paths}</g>`;
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="80" viewBox="0 0 ${width} 80">${fontNotice}${lockup}</svg>`;
  await asset(`exports/brand/${mode}/lockup.png`, source);
  const stacked = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240" viewBox="0 0 320 240">${fontNotice}${defs()}<g transform="translate(96 4) scale(4)">${logoBody(mode, { detail: true })}</g><g transform="translate(${(320 - w * wordScale) / 2} 166) scale(${wordScale})">${paths}</g></svg>`;
  await asset(`exports/brand/${mode}/lockup-stacked.png`, stacked);
}
for (const [name, color] of [
  ['black', '#000000'],
  ['white', '#FFFFFF'],
]) {
  await asset(`exports/brand/monochrome/${name}.png`, flat(color, 256));
}

// macOS classic Big Sur-style carrier, 1x/2x representations and ICNS.
const macTypes = {
  '16-1': 'icp4',
  '16-2': 'ic11',
  '32-1': 'icp5',
  '32-2': 'ic12',
  '128-1': 'ic07',
  '128-2': 'ic13',
  '256-1': 'ic08',
  '256-2': 'ic14',
  '512-1': 'ic09',
  '512-2': 'ic10',
};
for (const mode of Object.keys(modes)) {
  const images = [];
  const frames = [];
  for (const points of [16, 32, 128, 256, 512])
    for (const scale of [1, 2]) {
      const filename = `icon_${points}x${points}${scale === 2 ? '@2x' : ''}.png`;
      const source = app(mode, points * scale, 'macos', points);
      const buffer = await asset(`exports/macos/${mode}/Wevir.iconset/${filename}`, source, {
        logicalSize: points,
      });
      await write(`exports/macos/${mode}/AppIcon.appiconset/${filename}`, buffer);
      images.push({ filename, idiom: 'mac', scale: `${scale}x`, size: `${points}x${points}` });
      frames.push({ type: macTypes[`${points}-${scale}`], buffer });
    }
  await write(`exports/macos/${mode}/Wevir.icns`, icns(frames));
  await write(
    `exports/macos/${mode}/AppIcon.appiconset/Contents.json`,
    json({ images, info: { author: 'wevir', version: 1 } }),
  );
}
for (const points of [16, 18]) {
  const images = [];
  for (const scale of [1, 2]) {
    const name = `Wevir${points}Template${scale === 2 ? '@2x' : ''}.png`;
    const buffer = await asset(`exports/macos/menubar/${name}`, flat('#000000', points * scale), {
      logicalSize: points,
    });
    await write(`exports/macos/menubar/Wevir${points}.imageset/${name}`, buffer);
    images.push({ filename: name, idiom: 'universal', scale: `${scale}x` });
    for (const mode of Object.keys(modes))
      await asset(
        `exports/macos/menubar/previews/${mode}/${name}`,
        flat(mode === 'light' ? '#000000' : '#FFFFFF', points * scale),
        { logicalSize: points },
      );
  }
  await write(
    `exports/macos/menubar/Wevir${points}.imageset/Contents.json`,
    json({
      images,
      info: { author: 'wevir', version: 1 },
      properties: { 'template-rendering-intent': 'template' },
    }),
  );
}

// Windows ICO plus explicit light/dark AppList targetsize names.
const windowsSizes = [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 128, 256];
for (const mode of Object.keys(modes)) {
  const appFrames = [];
  const trayFrames = [];
  for (const size of windowsSizes) {
    const buffer = await asset(`exports/windows/${mode}/app-${size}.png`, app(mode, size));
    appFrames.push({ size, buffer });
    const unplated = await asset(
      `exports/windows/${mode}/AppList.targetsize-${size}${mode === 'light' ? '_altform-lightunplated' : '_altform-unplated'}.png`,
      mark(mode, size),
    );
    if (mode === 'light')
      await write(`exports/windows/default/AppList.targetsize-${size}.png`, unplated);
    if ([16, 20, 24, 32, 40, 48, 64].includes(size)) {
      const tray = await asset(
        `exports/windows/${mode}/tray-${size}.png`,
        flat(mode === 'light' ? '#000000' : '#FFFFFF', size),
      );
      trayFrames.push({ size, buffer: tray });
    }
  }
  await write(`exports/windows/${mode}/Wevir.ico`, ico(appFrames));
  await write(`exports/windows/${mode}/WevirTray.ico`, ico(trayFrames));
}

// iOS/iPadOS full square source. Transparent dark foreground, grayscale tinted.
await asset(
  'exports/ios/Assets.xcassets/AppIcon.appiconset/AppIconLight.png',
  fullBleed('light', 1024),
  { opaque: true },
);
await asset(
  'exports/ios/Assets.xcassets/AppIcon.appiconset/AppIconDark.png',
  fullBleed('dark', 1024, { transparent: true }),
);
await asset(
  'exports/ios/Assets.xcassets/AppIcon.appiconset/AppIconTinted.png',
  fullBleed('dark', 1024, { tinted: true }),
  { opaque: true, grayscale: true },
);
await write(
  'exports/ios/Assets.xcassets/Contents.json',
  json({ info: { author: 'wevir', version: 1 } }),
);
await write(
  'exports/ios/Assets.xcassets/AppIcon.appiconset/Contents.json',
  json({
    images: [
      { filename: 'AppIconLight.png', idiom: 'universal', platform: 'ios', size: '1024x1024' },
      {
        filename: 'AppIconDark.png',
        idiom: 'universal',
        platform: 'ios',
        size: '1024x1024',
        appearances: [{ appearance: 'luminosity', value: 'dark' }],
      },
      {
        filename: 'AppIconTinted.png',
        idiom: 'universal',
        platform: 'ios',
        size: '1024x1024',
        appearances: [{ appearance: 'luminosity', value: 'tinted' }],
      },
    ],
    info: { author: 'wevir', version: 1 },
  }),
);
for (const mode of Object.keys(modes)) {
  await asset(`exports/ios/${mode}/AppIcon-1024.png`, fullBleed(mode, 1024), { opaque: true });
  await asset(
    `exports/ios/${mode}/AppIconTinted-1024.png`,
    fullBleed(mode, 1024, { tinted: true }),
    { opaque: true, grayscale: true },
  );
  for (const size of [20, 29, 40, 58, 60, 76, 80, 87, 120, 152, 167, 180])
    await asset(`exports/ios/${mode}/icon-${size}.png`, fullBleed(mode, size), { opaque: true });
  // Unbaked layers for current Icon Composer; no project/settings are generated.
  await asset(
    `exports/apple-layers/${mode}/foreground.png`,
    xml(
      `<g transform="translate(232 232) scale(17.5)"><path d="${geometry}" fill="${modes[mode].flat}"/></g>`,
      1024,
      '0 0 1024 1024',
    ),
  );
  await asset(
    `exports/apple-layers/${mode}/background.png`,
    xml(`<rect width="1024" height="1024" fill="${modes[mode].bg}"/>`, 1024, '0 0 1024 1024'),
    { opaque: true },
  );
}

// Android adaptive layers: 108dp canvas, logo fits the central 66dp circle.
const densities = [
  ['mdpi', 1],
  ['hdpi', 1.5],
  ['xhdpi', 2],
  ['xxhdpi', 3],
  ['xxxhdpi', 4],
];
for (const mode of Object.keys(modes)) {
  const fgBody = `${defs()}<g transform="translate(25.52 25.52) scale(1.78)">${logoBody(mode, { detail: true })}</g>`;
  const monoBody = `<g transform="translate(25.52 25.52) scale(1.78)"><path d="${geometry}" fill="#000000"/></g>`;
  for (const [density, scale] of densities) {
    const folder = `exports/android/res/drawable${mode === 'dark' ? '-night' : ''}-${density}`;
    await asset(`${folder}/wevir_foreground.png`, xml(fgBody, 108 * scale, '0 0 108 108'));
    await asset(
      `${folder}/wevir_background.png`,
      xml(`<rect width="108" height="108" fill="${modes[mode].bg}"/>`, 108 * scale, '0 0 108 108'),
      { opaque: true },
    );
    await asset(
      `exports/android/${mode}/monochrome-${108 * scale}.png`,
      xml(monoBody, 108 * scale, '0 0 108 108'),
    );
    await asset(
      `exports/android/res/mipmap${mode === 'dark' ? '-night' : ''}-${density}/ic_launcher.png`,
      app(mode, 48 * scale),
    );
  }
  await asset(`exports/android/${mode}/play-store-512.png`, fullBleed(mode, 512), { opaque: true });
  for (const shape of ['circle', 'rounded-square', 'squircle']) {
    const mask =
      shape === 'circle'
        ? '<circle cx="54" cy="54" r="36"/>'
        : `<rect x="18" y="18" width="72" height="72" rx="${shape === 'squircle' ? 24 : 15}"/>`;
    await asset(
      `exports/android/${mode}/preview-${shape}.png`,
      xml(
        `<defs><clipPath id="mask">${mask}</clipPath></defs><g clip-path="url(#mask)"><rect width="108" height="108" fill="${modes[mode].bg}"/>${fgBody}</g>`,
        432,
        '0 0 108 108',
      ),
    );
  }
}
await write(
  'exports/android/res/drawable/wevir_monochrome.xml',
  `<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="108dp" android:height="108dp" android:viewportWidth="108" android:viewportHeight="108"><group android:translateX="25.52" android:translateY="25.52" android:scaleX="1.78" android:scaleY="1.78"><path android:fillColor="#FF000000" android:pathData="${geometry}"/></group></vector>\n`,
);
for (const version of [26, 33]) {
  const source = `<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android"><background android:drawable="@drawable/wevir_background"/><foreground android:drawable="@drawable/wevir_foreground"/>${version === 33 ? '<monochrome android:drawable="@drawable/wevir_monochrome"/>' : ''}</adaptive-icon>\n`;
  await write(`exports/android/res/mipmap-anydpi-v${version}/ic_launcher.xml`, source);
  await write(`exports/android/res/mipmap-anydpi-v${version}/ic_launcher_round.xml`, source);
}

// Linux and Web: source SVG, hicolor rasters, favicon, Apple touch and maskable.
for (const mode of Object.keys(modes)) {
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024])
    await asset(`exports/linux/${mode}/hicolor/${size}x${size}/apps/wevir.png`, app(mode, size));
  await write(`exports/linux/${mode}/hicolor/scalable/apps/wevir.svg`, app(mode, 1024));
  const frames = [];
  for (const size of [16, 32, 48])
    frames.push({
      size,
      buffer: await asset(`exports/web/${mode}/favicon-${size}.png`, app(mode, size)),
    });
  await write(`exports/web/${mode}/favicon.ico`, ico(frames));
  await write(`exports/web/${mode}/favicon.svg`, app(mode, 32));
  for (const size of [192, 512])
    await asset(`exports/web/${mode}/pwa-${size}.png`, fullBleed(mode, size), { opaque: true });
  await asset(`exports/web/${mode}/apple-touch-icon.png`, fullBleed(mode, 180), { opaque: true });
  await write(
    `exports/web/${mode}/site.webmanifest`,
    json({
      name: 'Wevir',
      short_name: 'Wevir',
      icons: [192, 512].map((size) => ({
        src: `pwa-${size}.png`,
        sizes: `${size}x${size}`,
        type: 'image/png',
        purpose: 'any maskable',
      })),
      theme_color: modes[mode].bg,
      background_color: modes[mode].bg,
      display: 'standalone',
    }),
  );
}
await write(
  'exports/web/favicon.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><style>.dark{display:none}@media(prefers-color-scheme:dark){.light{display:none}.dark{display:inline}}</style><g class="light"><rect width="32" height="32" rx="6" fill="${modes.light.bg}"/><path d="${geometry}" fill="${modes.light.flat}"/></g><g class="dark"><rect width="32" height="32" rx="6" fill="${modes.dark.bg}"/><path d="${geometry}" fill="${modes.dark.flat}"/></g></svg>`,
);

// Eight original linear functional icons; a tintable SVG sprite for clients.
const stroke = (body, color) =>
  `<g fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</g>`;
for (const [name, body] of Object.entries(ui)) {
  await write(
    `exports/ui/current-color/${name}.svg`,
    xml(stroke(body, 'currentColor'), 24, '0 0 24 24'),
  );
  for (const mode of Object.keys(modes))
    for (const points of [16, 18, 20, 24, 32])
      for (const scale of [1, 2]) {
        await asset(
          `exports/ui/${mode}/${points}/${name}${scale === 2 ? '@2x' : ''}.png`,
          xml(stroke(body, modes[mode].ink), points * scale, '0 0 24 24'),
          { logicalSize: points },
        );
      }
}
await write(
  'exports/ui/sprite.svg',
  `<svg xmlns="http://www.w3.org/2000/svg">${Object.entries(ui)
    .map(
      ([name, body]) =>
        `<symbol id="wevir-${name}" viewBox="0 0 24 24">${stroke(body, 'currentColor')}</symbol>`,
    )
    .join('')}</svg>`,
);
await write(
  'manifest.json',
  json({
    version: 1,
    material: 'champagne-gold-ivory / platinum-graphite',
    geometry,
    uiGrid: 24,
    uiStroke: 2,
    palette: modes,
    androidSafeCircle: { cx: 54, cy: 54, radius: 33 },
    rasterCount: entries.length,
    rasters: entries,
  }),
);
console.log(`Exported ${entries.length} SVG-derived PNGs to ${out}`);
