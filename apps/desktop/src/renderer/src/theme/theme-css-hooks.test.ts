// SPDX-License-Identifier: MIT
// 改写自 pingdotgg/t3code apps/web/src/themeCssHooks.test.ts
// 来源提交 6b7027b1f43eebc4c7edf5304236a0775b2d8928
// Copyright (c) 2026 T3 Tools Inc.
// 修改：锁定 Wevir 的 data 属性；只扫描非测试 TS/TSX 的属性使用，不扫描允许表或 CSS。

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { THEME_CSS_HOOKS } from '@wevir/protocol';
import { expect, it } from 'vitest';

const sourceDirectory = join(import.meta.dirname, '..');
const source = readdirSync(sourceDirectory, { recursive: true, encoding: 'utf8' })
  .filter((file) => /\.tsx?$/.test(file) && !file.includes('.test.'))
  .map((file) => readFileSync(join(sourceDirectory, file), 'utf8'))
  .join('\n');

function sourcePattern(selector: string): RegExp {
  const match = /^\[(data-[a-z-]+)(?:="([a-z-]+)")?\]$/.exec(selector);
  if (!match) throw new Error(`Unsupported theme selector: ${selector}`);
  const [, attribute, value] = match;
  return value
    ? new RegExp(`\\b${attribute}\\s*=\\s*["']${value}["']`)
    : new RegExp(`\\b${attribute}(?:\\s*=|(?=\\s*(?:\\n|/?>)))`);
}

it.each(THEME_CSS_HOOKS.map((hook) => hook.selector))('%s remains in UI source', (selector) => {
  expect(source).toMatch(sourcePattern(selector));
});
