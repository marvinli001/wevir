import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { THEME_BACKGROUND } from '../../../shared/theme.js';

// 设计 Token（U1「静器」）的自动校验：从 palette.css 与 tokens.css 读出浅色、深色两套变量，核对文字对各自背景的
// 对比度与几条结构约定。改色后跑 desktop 的测试即可。

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
const PALETTE = read('./palette.css');
const TOKENS = read('./tokens.css');
const FONTS = read('./fonts.css');

interface Block {
  selector: string;
  vars: Map<string, string>;
}

/** CSS 里的顶层规则块（不含 @ 规则的嵌套），只取其中的自定义属性。 */
function blocks(css: string): Block[] {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return [...source.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: (match[1] ?? '').trim(),
    vars: new Map(
      [...(match[2] ?? '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((d) => [
        d[1] ?? '',
        (d[2] ?? '').trim().replace(/\s+/g, ' '),
      ]),
    ),
  }));
}

const LIGHT = ':root';
const DARK = ':root[data-theme="dark"]';

/** 某个主题在 <html> 上的变量：:root 的块按顺序合并，深色再盖上 data-theme 的块（它的优先级更高）。 */
function themeVars(theme: 'light' | 'dark'): Map<string, string> {
  const all = [...blocks(PALETTE), ...blocks(TOKENS)];
  const vars = new Map<string, string>();
  for (const selector of theme === 'dark' ? [LIGHT, DARK] : [LIGHT]) {
    for (const block of all.filter((candidate) => candidate.selector === selector)) {
      for (const [name, value] of block.vars) vars.set(name, value);
    }
  }
  return vars;
}

/** 展开 var() 引用，得到 #rrggbb；不是纯色（color-mix 等）时报错，免得测了个空。 */
function resolve(vars: Map<string, string>, name: string): string {
  let value = vars.get(name);
  for (let depth = 0; value?.startsWith('var(') && depth < 10; depth++) {
    value = vars.get(value.slice(4, -1).trim());
  }
  if (value === undefined || !/^#[0-9a-f]{6}$/i.test(value)) {
    throw new Error(`${name} 没有展开成 #rrggbb：${value}`);
  }
  return value.toLowerCase();
}

/** WCAG 2 的相对亮度与对比度。 */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r = 0, g = 0, b = 0] = channels.map((c) =>
    c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** 文字（或图形）× 它会出现在上面的背景，以及最低对比度。 */
const PAIRS: { fg: string[]; bg: string[]; min: number }[] = [
  // 正文、次正文、说明文字：所有底色上都要能读（WCAG AA 正文 4.5:1）。
  {
    fg: ['--foreground', '--soft-foreground', '--muted-foreground'],
    bg: [
      '--background',
      '--sidebar',
      '--card',
      '--popover',
      '--muted',
      '--accent',
      '--secondary',
      '--sidebar-accent',
      '--code-background',
    ],
    min: 4.5,
  },
  { fg: ['--primary-foreground'], bg: ['--primary'], min: 4.5 },
  // 状态色也用作文字（“待审批”“失败”等）。
  {
    fg: ['--running', '--success', '--warning', '--destructive'],
    bg: ['--background', '--sidebar', '--card', '--muted'],
    min: 4.5,
  },
  {
    fg: [
      '--code-keyword',
      '--code-string',
      '--code-number',
      '--code-title',
      '--code-comment',
      '--code-meta',
    ],
    bg: ['--code-background'],
    min: 4.5,
  },
  // 品牌主标是图形，不是文字：WCAG 1.4.11 的 3:1。
  { fg: ['--brand'], bg: ['--background', '--sidebar', '--card'], min: 3 },
  // 认证徽章（插件市场）：徽章在列表、详情、悬停行与浮层的底色上，勾在徽章上，都是图形的 3:1。
  {
    fg: ['--verified', '--official'],
    bg: ['--background', '--sidebar', '--card', '--popover', '--muted', '--accent'],
    min: 3,
  },
  { fg: ['--verified-foreground'], bg: ['--verified'], min: 3 },
  { fg: ['--official-foreground'], bg: ['--official'], min: 3 },
];

describe.each(['light', 'dark'] as const)('设计 Token：%s', (theme) => {
  const vars = themeVars(theme);

  it('文字对各自的背景达到最低对比度', () => {
    const failures: string[] = [];
    for (const { fg, bg, min } of PAIRS) {
      for (const f of fg) {
        for (const b of bg) {
          const ratio = contrast(resolve(vars, f), resolve(vars, b));
          if (ratio < min) failures.push(`${f} 在 ${b} 上 ${ratio.toFixed(2)}:1，要 ≥ ${min}:1`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('--background 与主进程、首帧前脚本用的底色相同（shared/theme.ts 的 THEME_BACKGROUND）', () => {
    expect(resolve(vars, '--background')).toBe(THEME_BACKGROUND[theme]);
  });
});

describe('设计 Token 的结构', () => {
  it('palette.css 只有一个 :root 块，不随主题切换；每个原始色都被 tokens.css 用到', () => {
    const palette = blocks(PALETTE);
    expect(palette.map((block) => block.selector)).toEqual([LIGHT]);
    const unused = [...(palette[0]?.vars.keys() ?? [])].filter(
      (name) => !TOKENS.includes(`var(${name})`),
    );
    expect(unused).toEqual([]);
  });

  it('tokens.css 的浅色块与深色块定义同一组变量', () => {
    const tokens = blocks(TOKENS);
    const light = tokens.find((block) => block.selector === LIGHT);
    const dark = tokens.find((block) => block.selector === DARK);
    expect([...(dark?.vars.keys() ?? [])].sort()).toEqual([...(light?.vars.keys() ?? [])].sort());
  });

  it('fonts.css 引用的字体文件都在，assets/fonts 里的 woff2 都被引用', () => {
    const referenced = [...FONTS.matchAll(/url\("\.\.\/assets\/fonts\/([^"]+)"\)/g)].map(
      (match) => match[1] ?? '',
    );
    const dir = new URL('../assets/fonts/', import.meta.url);
    for (const file of referenced) expect(existsSync(new URL(file, dir)), file).toBe(true);
    const shipped = readdirSync(dir).filter((file) => file.endsWith('.woff2'));
    expect(shipped.sort()).toEqual([...new Set(referenced)].sort());
  });
});
