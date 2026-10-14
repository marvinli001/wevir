import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { modes } from './design.mjs';

const root = fileURLToPath(new URL('../../assets/icons/', import.meta.url));
const labels = {
  'new-session': '新建会话',
  workspace: '工作区',
  session: '会话',
  model: '模型',
  file: '文件',
  terminal: '终端',
  extension: '扩展',
  settings: '设置',
};
const platforms = (mode) => [
  ['macOS', `exports/macos/${mode}/Wevir.iconset/icon_512x512@2x.png`],
  ['Windows', `exports/windows/${mode}/app-256.png`],
  ['iOS', `exports/ios/${mode}/AppIcon-1024.png`],
  ['Android', `exports/android/${mode}/preview-circle.png`],
  ['Linux', `exports/linux/${mode}/hicolor/256x256/apps/wevir.png`],
  ['Web', `exports/web/${mode}/pwa-512.png`],
];
const text = (s, x, y, size, color, weight = 400) =>
  `<text x="${x}" y="${y}" font-family="Arial,PingFang SC,sans-serif" font-size="${size}" font-weight="${weight}" fill="${color}">${s}</text>`;
const rect = (x, y, w, h, fill, r = 0) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"/>`;
async function image(file, x, y, w, h = w) {
  const b = await fs.readFile(path.join(root, file));
  return `<image x="${x}" y="${y}" width="${w}" height="${h}" href="data:image/png;base64,${b.toString('base64')}"/>`;
}
let body = rect(0, 0, 1920, 1260, '#E4E4DE');
body += text('Wevir / 共核', 48, 70, 38, '#191A17', 700);
body += text('完整图标资源 · 香槟金 / 灰调象牙白 · 铂金 / 石墨黑', 48, 115, 24, '#77776F');
for (const [i, [mode, m]] of Object.entries(modes).entries()) {
  const x = 48 + i * 936;
  body += rect(x, 158, 888, 1038, m.bg, 24);
  body += text(
    mode === 'light' ? '浅色 · 香槟金 / 灰调象牙白' : '深色 · 铂金 / 石墨黑',
    x + 32,
    208,
    28,
    m.ink,
    700,
  );
  body += await image(`exports/brand/${mode}/lockup.png`, x + 32, 242, 420, 80);
  body += text('应用图标', x + 32, 368, 23, m.muted, 600);
  for (const [j, [name, file]] of platforms(mode).entries()) {
    body += await image(file, x + 24 + j * 140, 392, 124);
    body += text(name, x + 38 + j * 140, 548, 20, m.muted);
  }
  body += text('菜单栏 / 托盘 · 实际尺寸', x + 32, 617, 23, m.muted, 600);
  for (const [j, points] of [16, 18].entries()) {
    body += await image(
      `exports/macos/menubar/previews/${mode}/Wevir${points}Template.png`,
      x + 38 + j * 170,
      650,
      points,
    );
    body += text(`${points}pt 模板`, x + 76 + j * 170, 666, 18, m.ink);
  }
  body += await image(`exports/windows/${mode}/tray-16.png`, x + 396, 650, 16);
  body += text('16px 托盘', x + 434, 666, 18, m.ink);
  body += await image(`exports/windows/${mode}/tray-32.png`, x + 628, 642, 32);
  body += text('32px 托盘', x + 678, 666, 18, m.ink);
  body += text('线性功能图标 · 24px / 16px', x + 32, 735, 23, m.muted, 600);
  for (const [j, [name, label]] of Object.entries(labels).entries()) {
    const cx = x + 43 + j * 105;
    body += await image(`exports/ui/${mode}/24/${name}.png`, cx + 8, 775, 24);
    body += await image(`exports/ui/${mode}/16/${name}.png`, cx + 12, 830, 16);
    body += text(label, cx - 9, 893, 17, m.ink);
  }
  body += text('系统变体与分层', x + 32, 954, 23, m.muted, 600);
  body += await image(`exports/ios/${mode}/AppIconTinted-1024.png`, x + 32, 979, 120);
  body += text('iOS tinted 灰度', x + 172, 1028, 19, m.ink);
  body += text('Android 前景 / 背景 / 单色层', x + 172, 1068, 19, m.muted);
  body += text('SVG 源文件 · ICNS · ICO · PNG · 资源目录', x + 32, 1154, 19, m.muted);
}
body += text('Wevir · by Wevir Labs LLC     /     2026-10-14', 48, 1238, 18, '#77776F');
await fs.mkdir(path.join(root, 'preview'), { recursive: true });
const source = `<svg role="img" aria-label="Wevir 图标资源总览" xmlns="http://www.w3.org/2000/svg" width="1920" height="1260" viewBox="0 0 1920 1260">${body}</svg>`;
await fs.writeFile(path.join(root, 'preview/overview.svg'), source);
await sharp(Buffer.from(source)).png().toFile(path.join(root, 'preview/overview.png'));
const modeSections = Object.entries(modes)
  .map(
    ([mode, m]) =>
      `<section class="theme ${mode}"><h2>${m.name}</h2><img class="lockup" src="../svg/brand/${mode}/lockup.svg" alt="Wevir ${m.name}组合标识"><div class="platforms">${platforms(
        mode,
      )
        .map(
          ([name, file]) =>
            `<figure><img class="app ${name === 'iOS' || name === 'Web' ? 'system-mask' : ''}" src="../${file}" alt="${name} ${m.name}应用图标"><figcaption>${name}</figcaption></figure>`,
        )
        .join(
          '',
        )}</div><h3>菜单栏与托盘</h3><div class="utilities"><img src="../exports/macos/menubar/previews/${mode}/Wevir16Template.png" width="16" height="16" alt="16pt菜单模板"><span>16pt</span><img src="../exports/macos/menubar/previews/${mode}/Wevir18Template.png" width="18" height="18" alt="18pt菜单模板"><span>18pt</span><img src="../exports/windows/${mode}/tray-32.png" width="32" height="32" alt="32px托盘"><span>32px</span></div><h3>八个线性功能图标</h3><div class="functions">${Object.entries(
        labels,
      )
        .map(
          ([name, label]) =>
            `<figure><img src="../exports/ui/${mode}/24/${name}.png" width="24" height="24" alt="${label}24px"><img src="../exports/ui/${mode}/16/${name}.png" width="16" height="16" alt="${label}16px"><figcaption>${label}</figcaption></figure>`,
        )
        .join(
          '',
        )}</div><h3>系统变体</h3><div class="variants"><figure><img class="app system-mask" src="../exports/ios/${mode}/AppIconTinted-1024.png" alt="iOS灰度tinted"><figcaption>iOS tinted</figcaption></figure>${['circle', 'rounded-square', 'squircle'].map((shape) => `<figure><img class="app" src="../exports/android/${mode}/preview-${shape}.png" alt="Android ${shape}遮罩预览"><figcaption>${shape}</figcaption></figure>`).join('')}</div><div class="downloads"><a download href="../exports/macos/${mode}/Wevir.icns">macOS ICNS</a><a download href="../exports/windows/${mode}/Wevir.ico">Windows ICO</a><a download href="../exports/windows/${mode}/WevirTray.ico">托盘 ICO</a><a download href="../exports/brand/${mode}/wordmark.svg">字标 SVG</a></div></section>`,
  )
  .join('');
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Wevir · 完整图标资源</title><style>*{box-sizing:border-box}body{margin:0;background:#e4e4de;color:#191a17;font-family:Arial,'PingFang SC',sans-serif}main{max-width:1500px;padding:32px 24px 64px;margin:auto}header{display:flex;align-items:center;justify-content:space-between;gap:24px}h1{font-size:32px;margin:0}p{line-height:1.6;color:#77776f}a{color:inherit;text-underline-offset:4px}a:focus-visible{outline:2px solid #77776f;outline-offset:5px}.themes{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:28px}.theme{padding:28px;border-radius:20px;background:#f4f3ed;color:#171714}.dark{background:#101114;color:#eeede8}h2{margin:0 0 24px;font-size:25px}h3{font-size:18px;opacity:.65;margin:32px 0 20px}.lockup{max-width:300px;width:100%;height:72px;object-fit:contain;object-position:left}.platforms,.variants{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}.variants{grid-template-columns:repeat(4,1fr)}figure{margin:0;display:flex;align-items:center;flex-direction:column;gap:12px}.app{display:block;width:112px;max-width:100%;height:112px;object-fit:contain}.system-mask{border-radius:24%}.platforms figcaption,.variants figcaption{font-size:14px;opacity:.7}.utilities{display:flex;gap:16px;align-items:center;min-height:40px}.utilities span{font-size:14px;opacity:.65}.functions{display:grid;grid-template-columns:repeat(4,1fr);gap:26px 16px}.functions figcaption{font-size:14px}.downloads{display:flex;flex-wrap:wrap;gap:18px;font-size:14px;margin-top:32px}footer{font-size:14px;color:#77776f;margin-top:30px}.package{display:inline-block;padding:13px 20px;border-radius:8px;background:#191a17;color:#f4f3ed;text-decoration:none}@media(max-width:900px){.themes{grid-template-columns:1fr}header{display:block}.package{margin-top:12px}}@media(max-width:440px){.theme{padding:20px}.variants{grid-template-columns:repeat(2,1fr)}}.overview{width:100%;height:auto;display:block;margin-top:28px}</style><main><header><div><h1>Wevir · 完整跨平台图标</h1><p>共核主标 · 金色主标与灰调象牙白 / 铂金与石墨黑 · 全部包含 SVG 源文件</p></div><a class="package" download href="../release/wevir-icons-v1.zip">下载完整资源包 ZIP</a></header><div class="themes">${modeSections}</div><footer>小尺寸保持清晰轮廓；功能图标使用 24 单位网格、2 单位线宽。macOS 模板由系统处理浅深色；iOS 深色透明前景与 tinted 灰度稿已单独提供；Android 预览遮罩不写入自适应源层。<br>文件已完成尺寸、透明度及容器校验；已接入的客户端与真实设备效果需在接入阶段验证。</footer><img class="overview" src="overview.png" width="1920" height="1260" alt="完整图标资源总览"></main></html>`;
await fs.writeFile(path.join(root, 'preview/index.html'), html);
console.log('Generated cross-platform icon gallery and overview');
