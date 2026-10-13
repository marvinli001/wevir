// 设计 Token 的第一层：从 @radix-ui/colors 生成原始色阶 src/renderer/src/styles/palette.css（T5.2）。
//
// 运行：pnpm --filter @wevir/desktop palette。升级 @radix-ui/colors 或改动下面的色系后重新生成；
// generate-palette.test.ts 核对文件与本脚本的输出一致。
//
// 不直接 import Radix 自带的 CSS：那些文件的暗色选择器是 `.dark, .dark-theme`，而 Wevir 的暗色只认
// `<html data-theme="dark">`（openwork-notes §9.3）。

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as radix from '@radix-ui/colors';
import radixPackage from '@radix-ui/colors/package.json' with { type: 'json' };

/** 一个中性色系、一个强调色、红 / 琥珀 / 绿三个状态色。语义层（tokens.css）只引用这几个。 */
export const PALETTE_FAMILIES = ['sand', 'indigo', 'red', 'amber', 'green'] as const;

export const PALETTE_FILE = fileURLToPath(
  new URL('../src/renderer/src/styles/palette.css', import.meta.url),
);

type Scale = Record<string, string>;

/**
 * Radix 的导出名：`sand`、`sandA`、`sandDark`、`sandDarkA`，P3 版本在暗色后缀之后加 `P3`
 * （`sandP3A`、`sandDarkP3A`）。
 */
function scale(family: string, dark: boolean, p3: boolean, alpha: boolean): Scale {
  const name = `${family}${dark ? 'Dark' : ''}${p3 ? 'P3' : ''}${alpha ? 'A' : ''}`;
  const value = (radix as unknown as Record<string, Scale | undefined>)[name];
  if (!value) throw new Error(`@radix-ui/colors 没有导出 ${name}`);
  return value;
}

/** `sand3` → `--sand-3`，`sandA3` → `--sand-a3`，与 Radix 自带 CSS 的变量名相同。 */
function declarations(family: string, dark: boolean, p3: boolean, indent: string): string[] {
  const lines: string[] = [];
  for (const alpha of [false, true]) {
    const values = scale(family, dark, p3, alpha);
    for (let step = 1; step <= 12; step++) {
      const key = `${family}${alpha ? 'A' : ''}${step}`;
      const color = values[key];
      if (color === undefined) throw new Error(`${family} 缺少第 ${step} 阶（${key}）`);
      lines.push(`${indent}--${family}-${alpha ? 'a' : ''}${step}: ${color};`);
    }
  }
  return lines;
}

function block(dark: boolean, p3: boolean, indent: string): string[] {
  const selector = dark ? ':root[data-theme="dark"]' : ':root';
  return [
    `${indent}${selector} {`,
    ...PALETTE_FAMILIES.flatMap((family) => declarations(family, dark, p3, `${indent}  `)),
    `${indent}}`,
  ];
}

export function renderPalette(): string {
  return [
    `/* 由 apps/desktop/scripts/generate-palette.ts 从 @radix-ui/colors ${radixPackage.version} 生成，不要手改。`,
    ' * Radix Colors：MIT License，Copyright (c) 2021 Radix（WorkOS）。',
    ' * 亮色在 :root，暗色只认 <html data-theme="dark">；支持 Display P3 的屏幕改用 P3 值（写法同 Radix 自带的 CSS）。',
    ' * 界面代码不直接用这里的变量，只用 tokens.css 的语义变量。 */',
    '',
    ...block(false, false, ''),
    '',
    ...block(true, false, ''),
    '',
    '@supports (color: color(display-p3 1 1 1)) {',
    '  @media (color-gamut: p3) {',
    ...block(false, true, '    '),
    '',
    ...block(true, true, '    '),
    '  }',
    '}',
    '',
  ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(PALETTE_FILE, renderPalette());
  console.log(`已写入 ${PALETTE_FILE}`);
}
