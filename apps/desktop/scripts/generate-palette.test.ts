import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PALETTE_FAMILIES, PALETTE_FILE, renderPalette } from './generate-palette.js';

describe('palette.css', () => {
  it('与 @radix-ui/colors 当前版本的生成结果一致（不一致就运行 pnpm --filter @wevir/desktop palette）', () => {
    expect(readFileSync(PALETTE_FILE, 'utf8')).toBe(renderPalette());
  });

  it('亮色、暗色、P3 各有 9 个色系 × 24 阶；暗色只用 data-theme 选择器', () => {
    const css = renderPalette();
    expect(css.match(/^:root \{$/gm)).toHaveLength(1);
    expect(css.match(/^ {4}:root \{$/gm)).toHaveLength(1);
    expect(css.match(/:root\[data-theme="dark"\] \{/g)).toHaveLength(2);
    expect(css).not.toMatch(/\.dark|\.light/);
    expect(css.match(/--sand-a12:/g)).toHaveLength(4);
    expect(PALETTE_FAMILIES).toHaveLength(9);
    expect(css.match(/--pink-a12:/g)).toHaveLength(4);
    expect(css.match(/^\s+--[a-z]+-a?\d+: /gm)).toHaveLength(4 * 9 * 24);
  });
});
