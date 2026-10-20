import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 控件一致性（desktop-tokens.md §62）：界面代码里的勾选框、单选与滑块只用 components/ui 的原语，不用浏览器原生的；
// 圆角只用阶梯里的类名，阴影不写字面色值。components/ui 本身不查（原语在那里定义）。

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx') ? [path] : [];
  });
}

const FILES = sources(ROOT)
  .map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, 'utf8') }))
  .filter(({ path }) => !path.startsWith(join('components', 'ui')));

const RULES: { name: string; pattern: RegExp }[] = [
  {
    name: '原生勾选框、单选或滑块（用 Checkbox / Radio / Slider）',
    pattern: /type="(checkbox|radio|range)"/,
  },
  {
    name: '原生控件的 accent-color（accent-*）',
    pattern: /(?<=[\s"'`])accent-(primary|foreground)\b/,
  },
  { name: '阶梯外的圆角（rounded-[Npx]）', pattern: /rounded-\[\d/ },
  {
    name: '粗焦点环（用 focus-ring / focus-field，§63）',
    pattern:
      /focus(-visible|-within)?:(ring-(2|3|\[)|ring-(sidebar-)?ring(\/|(?![\w-]))|outline-(\d|ring)|border-ring\b)/,
  },
  {
    name: '写死颜色的阴影（shadow-[…rgb / #…]）',
    pattern: /shadow-\[[^\]]*(rgb|hsl|#[0-9a-fA-F]{3})/,
  },
];

describe('控件一致性', () => {
  it('找得到界面源码', () => {
    expect(FILES.length).toBeGreaterThan(50);
  });

  for (const rule of RULES) {
    it(`不用${rule.name}`, () => {
      const hits = FILES.flatMap(({ path, text }) =>
        text
          .split('\n')
          .flatMap((line, index) => (rule.pattern.test(line) ? [`${path}:${index + 1}`] : [])),
      );
      expect(hits).toEqual([]);
    });
  }
});
