import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { defs, geometry, logoBody, modes } from './design.mjs';

const root = fileURLToPath(new URL('../../assets/icons/', import.meta.url));
const word = JSON.parse(await fs.readFile(path.join(root, 'source/wordmark-paths.json'), 'utf8'));
const copy = JSON.parse(
  await fs.readFile(path.join(root, 'source/social-copy-paths.json'), 'utf8'),
).copy;
const notice =
  '<!-- Typography: github/mona-sans, fonts/static/ttf/MonaSans-Bold.ttf; commit 4bc6ba8b354c36b4fb66d32cd67b4c1f2beb0a06; SIL OFL-1.1. See source/fonts/OFL.txt. -->';
const rasters = [];
const critical = [
  { name: 'mark', x: 400, y: 130, width: 158, height: 158 },
  {
    name: 'wordmark',
    x: 590,
    y: 138,
    width: (word.bounds[2] - word.bounds[0]) * 1.9,
    height: (word.bounds[3] - word.bounds[1]) * 1.9,
  },
  {
    name: 'tagline',
    x: 590,
    y: 313,
    width: (copy.tagline.bounds[2] - copy.tagline.bounds[0]) * 0.3,
    height: (copy.tagline.bounds[3] - copy.tagline.bounds[1]) * 0.3,
  },
  {
    name: 'domain',
    x: 590,
    y: 366,
    width: (copy.domain.bounds[2] - copy.domain.bounds[0]) * 0.26,
    height: (copy.domain.bounds[3] - copy.domain.bounds[1]) * 0.26,
  },
];

function svg(body, width, height = width, viewBox = `0 0 ${width} ${height}`, label = 'Wevir') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${viewBox}" role="img" aria-label="${label}">${notice}${body}</svg>`;
}
function letters(data, x, y, scale, color) {
  return `<g transform="translate(${x} ${y}) scale(${scale})"><g transform="translate(${-data.bounds[0]} ${-data.bounds[1]})" fill="${color}">${data.paths.map((d) => `<path d="${d}"/>`).join('')}</g></g>`;
}
function avatar(mode, size) {
  return svg(
    `${defs()}<rect width="1000" height="1000" fill="${modes[mode].bg}"/><g transform="translate(140 140) scale(22.5)">${logoBody(mode, { detail: true })}</g>`,
    size,
    size,
    '0 0 1000 1000',
    `Wevir ${mode} avatar`,
  );
}
function banner(mode, width) {
  const m = modes[mode];
  const ghost = `<g transform="translate(1100 -64) scale(20)" fill="none" stroke="${m.accent}" stroke-width=".055" opacity=".19"><path d="${geometry}"/></g>`;
  return svg(
    `${defs()}<rect width="1500" height="500" fill="${m.bg}"/>${ghost}<g transform="translate(400 130) scale(4.9375)">${logoBody(mode, { detail: true })}</g>${letters(word, 590, 138, 1.9, m.ink)}${letters(copy.tagline, 590, 313, 0.3, m.muted)}${letters(copy.domain, 590, 366, 0.26, m.accent)}`,
    width,
    width / 3,
    '0 0 1500 500',
    `Wevir ${mode} X header`,
  );
}
async function write(relative, data) {
  const file = path.join(root, relative);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
}
async function render(relative, source, width, height, maxBytes) {
  assert(
    !/<(?:image|text)\b/.test(source),
    'Upload masters must be pure vector, with outlined text',
  );
  const sourcePath = relative.replace(/^exports\//, 'svg/').replace(/\.(?:png|jpg)$/, '.svg');
  await write(sourcePath, source);
  let job = sharp(Buffer.from(source)).removeAlpha();
  job = relative.endsWith('.jpg')
    ? job.jpeg({ quality: 94, chromaSubsampling: '4:4:4' })
    : job.png();
  const buffer = await job.toBuffer();
  const meta = await sharp(buffer).metadata();
  assert.equal(meta.width, width);
  assert.equal(meta.height, height);
  assert.equal(meta.hasAlpha, false);
  if (maxBytes) assert(buffer.length < maxBytes, `${relative} exceeds upload budget`);
  await write(relative, buffer);
  rasters.push({
    path: relative,
    source: sourcePath,
    width,
    height,
    bytes: buffer.length,
    alpha: false,
    opaque: true,
    maxBytes,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  });
  return buffer;
}

// Keep the full mark inside a conservative avatar circle, independent of its paint.
const mask = svg(
  `<g transform="translate(140 140) scale(22.5)"><path d="${geometry}" fill="#000"/></g>`,
  400,
  400,
  '0 0 1000 1000',
);
const { data } = await sharp(Buffer.from(mask))
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
for (let y = 0; y < 400; y++)
  for (let x = 0; x < 400; x++) {
    if (data[(y * 400 + x) * 4 + 3] > 16)
      assert(Math.hypot(x + 0.5 - 200, y + 0.5 - 200) < 180, 'Avatar mark crosses the safe circle');
  }
for (const box of critical) {
  assert(
    box.x >= 350 && box.x + box.width <= 1420,
    `${box.name} enters horizontal crop/overlap area`,
  );
  assert(
    box.y >= 60 && box.y + box.height <= 440,
    `${box.name} enters the possible 60px top/bottom crop`,
  );
}

for (const mode of Object.keys(modes)) {
  for (const size of [512, 1024])
    await render(
      `exports/social/stripe/${mode}/company-avatar-${size}.png`,
      avatar(mode, size),
      size,
      size,
      500_000,
    );
  for (const size of [400, 1024])
    await render(
      `exports/social/x/${mode}/avatar-${size}.png`,
      avatar(mode, size),
      size,
      size,
      1_900_000,
    );
  await render(
    `exports/social/x/${mode}/header-1500x500.png`,
    banner(mode, 1500),
    1500,
    500,
    1_900_000,
  );
  await render(
    `exports/social/x/${mode}/header-1500x500.jpg`,
    banner(mode, 1500),
    1500,
    500,
    1_900_000,
  );
  await render(`exports/social/x/${mode}/header-3000x1000.png`, banner(mode, 3000), 3000, 1000);
}
await write(
  'social-manifest.json',
  `${JSON.stringify({ version: 1, date: '2026-10-25', identity: 'Existing Wevir Open Host mark and outlined wordmark', avatarSafeRadiusRatio: 0.45, bannerCriticalBounds: critical, sources: { stripe: 'https://docs.stripe.com/receipts#image-requirements', xDimensions: 'https://help.x.com/en/managing-your-account/how-to-customize-your-profile', xCrop: 'https://help.x.com/en/managing-your-account/common-issues-when-uploading-profile-photo' }, rasters }, null, 2)}\n`,
);

const cards = Object.entries(modes)
  .map(
    ([mode, m]) =>
      `<section class="theme ${mode}" style="--surface:${m.bg};--ink:${m.ink};--muted:${m.muted}"><h2>${m.name}</h2><div class="avatars"><figure><img src="../../exports/social/stripe/${mode}/company-avatar-512.png" alt="Stripe公司头像" width="144" height="144"><figcaption>Stripe · 512 × 512</figcaption><a download href="../../exports/social/stripe/${mode}/company-avatar-512.png">下载 PNG</a></figure><figure><img class="circle" src="../../exports/social/x/${mode}/avatar-400.png" alt="X头像圆形裁切预览" width="144" height="144"><figcaption>X · 400 × 400</figcaption><a download href="../../exports/social/x/${mode}/avatar-400.png">下载 PNG</a></figure></div><h3>X 横幅</h3><img class="banner" src="../../exports/social/x/${mode}/header-1500x500.png" alt="Wevir X横幅" width="1500" height="500"><div class="links"><a download href="../../exports/social/x/${mode}/header-1500x500.png">1500 × 500 PNG</a><a download href="../../exports/social/x/${mode}/header-1500x500.jpg">JPG</a><a download href="../../exports/social/x/${mode}/header-3000x1000.png">3000 × 1000</a><a download href="../../svg/social/x/${mode}/header-1500x500.svg">SVG 源文件</a></div><h3>头像遮挡与裁切预览</h3><div class="profile"><div class="profile-header"><img src="../../exports/social/x/${mode}/header-1500x500.png" alt="桌面横幅与头像位置示意"></div><img class="profile-avatar" src="../../exports/social/x/${mode}/avatar-400.png" alt="X圆形头像"><strong>Wevir</strong><span>wevir.si</span></div><div class="crop"><img src="../../exports/social/x/${mode}/header-1500x500.png" alt="上下各裁切60px的保守预览"></div><p>下图模拟上下各裁切 60px；头像、横幅和图标均使用现有品牌源文件。</p></section>`,
  )
  .join('');
const page = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wevir · Stripe 与 X 品牌资源</title><style>*{box-sizing:border-box}body{margin:0;background:#E4E4DE;color:#171714;font-family:Arial,'PingFang SC',sans-serif}main{max-width:1400px;margin:auto;padding:36px 24px 60px}header{display:flex;align-items:center;justify-content:space-between;gap:24px}h1{font-size:30px;margin:0}p{line-height:1.6;color:#726E64}a{color:inherit;text-underline-offset:4px}a:focus-visible{outline:2px solid #9b7840;outline-offset:4px}.package{padding:14px 18px;background:#171714;color:#f4f3ed;border-radius:8px;white-space:nowrap;text-decoration:none}.themes{display:grid;gap:24px;margin-top:28px}.theme{padding:28px;background:var(--surface);color:var(--ink);border-radius:20px}h2{margin:0 0 24px;font-size:25px}h3{font-size:18px;color:var(--muted);margin:28px 0 18px}.avatars{display:flex;gap:48px;flex-wrap:wrap}figure{margin:0;display:flex;flex-direction:column;gap:12px;align-items:center}figure img{border:1px solid #8882}.circle{border-radius:50%}figcaption,.links,figure a{font-size:14px}.banner{display:block;width:100%;height:auto;border:1px solid #8882}.links{display:flex;flex-wrap:wrap;gap:24px;margin-top:18px}.profile{max-width:900px;border:1px solid #8883;border-radius:12px;overflow:hidden;position:relative;padding-bottom:24px}.profile-header img{display:block;width:100%;height:auto}.profile-avatar{display:block;position:relative;width:18%;margin:-9% 0 10px 4%;border:5px solid var(--surface);border-radius:50%;background:var(--surface)}.profile strong,.profile span{display:block;margin:5px 4%}.profile strong{font-size:24px}.profile span{font-size:14px;color:var(--muted)}.crop{max-width:900px;aspect-ratio:1500/380;overflow:hidden;margin-top:24px}.crop img{display:block;width:100%;height:auto;transform:translateY(-12%)}.theme p{font-size:14px;color:var(--muted)}footer{margin-top:28px;font-size:14px;color:#726e64}@media(max-width:640px){header{display:block}.package{display:inline-block;margin-top:12px}.theme{padding:20px}.avatars{gap:32px}} </style><main><header><div><h1>Stripe 公司头像 · X 官号头像与横幅</h1><p>金色 / 象牙白主版；铂金 / 石墨黑备选。SVG 字标和文案均已转曲。</p></div><a class="package" download href="../../release/wevir-social-v1.zip">下载社交品牌资源包</a></header><div class="themes">${cards}</div><footer>成品文件用于手动上传。此页为裁切示意，没有连接或修改 Stripe / X 账户。</footer></main></html>`;
await write('preview/social/index.html', page);
console.log(
  `Exported ${rasters.length} social images; avatars fit the circular safe area and header content avoids crop/overlap zones.`,
);
