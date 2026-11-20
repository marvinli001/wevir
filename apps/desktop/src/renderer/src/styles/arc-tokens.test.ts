import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEMABLE_TOKENS } from '@wevir/protocol';
import { expect, it } from 'vitest';

const ui = fileURLToPath(new URL('../components/ui/', import.meta.url));
const tokens = readFileSync(new URL('./arc-tokens.css', import.meta.url), 'utf8');
const defined = new Set(Array.from(tokens.matchAll(/(--arc-[\w-]+)\s*:/g), (match) => match[1]));
const themable = new Set<string>(THEMABLE_TOKENS);
// 这些几何变量由 Base UI 在 Positioner、Dialog 与 Tabs 上逐帧提供。
const layout = new Set([
  'available-height',
  'available-width',
  'anchor-width',
  'transform-origin',
  'nested-dialogs',
  'active-tab-left',
  'active-tab-top',
  'active-tab-width',
  'active-tab-height',
]);

it('Arc 组件只引用已定义的 Arc 令牌、公开主题色与原语的几何变量', () => {
  const errors: string[] = [];
  const modules = readdirSync(ui, { recursive: true, encoding: 'utf8' }).filter((name) =>
    name.endsWith('.module.css'),
  );
  expect(modules.length).toBeGreaterThan(0);
  for (const name of modules) {
    const css = readFileSync(join(ui, name), 'utf8');
    for (const [, variable] of css.matchAll(/var\(\s*--([\w-]+)/g)) {
      if (
        variable &&
        !defined.has(`--${variable}`) &&
        !themable.has(variable) &&
        !layout.has(variable)
      )
        errors.push(`${name}: --${variable}`);
    }
  }
  expect(errors).toEqual([]);
});
