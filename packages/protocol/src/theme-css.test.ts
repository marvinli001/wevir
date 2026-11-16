// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/shared/src/themeCss.test.ts
// 来源提交 6b7027b1f43eebc4c7edf5304236a0775b2d8928
// Copyright (c) 2026 T3 Tools Inc.
// 修改：使用 Vitest；补充本机、相对地址、空白、字符串与保存时检查。

import { describe, expect, it } from 'vitest';
import { themeCssLoadsRemoteFiles, themeCssValueFetches } from './theme-css.js';

const SVG_WITH_OWN_GRADIENT =
  'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22%3E%3ClinearGradient id=%22g%22/%3E%3Crect fill=%22url(%23g)%22/%3E%3C/svg%3E';

describe('themeCssValueFetches', () => {
  it.each([
    ['url("https://example.com/a")', true],
    ['url("http://127.0.0.1:1234/leak")', true],
    ['url("/api/thing")', true],
    ['url(./thing)', true],
    ['image-set("https://example.com/a" 1x)', true],
    ['-webkit-image-set("data:image/png;base64,AA" 1x)', true],
    ['src("https://example.com/a")', true],
    ['u\\72l(https://example.com/a)', true],
    ['im\\61ge-set(var(--leak) 1x)', true],
    ['v\\61r(--none, u\\72l(https://example.com/a))', true],
    ['url("\u00a0data:/../../probe")', true],
    ['url(" data:image/png;base64,AA")', true],
    ['url("data:image/png;base64,AA")', false],
    [`url("${SVG_WITH_OWN_GRADIENT}")`, false],
    ['url( \tdata:image/png;base64,AA)', false],
    ['url( \t"data:image/png;base64,AA")', false],
    [`"url('data:" url("https://evil.example/a") "'"`, true],
    ['"url(https://example.com/a) image-set(src())"', false],
    ['url("#blur")', false],
    ['var(--pattern)', false],
    ['red', false],
  ] as const)('%s → %s', (value, fetches) => {
    expect(themeCssValueFetches(value)).toBe(fetches);
  });
});

describe('themeCssLoadsRemoteFiles', () => {
  it.each([
    ['@import "https://example.com/sheet.css";', true],
    ['/* @import "unused" */ body { color: red }', false],
    ['body { background: url(//example.com/image) }', true],
    ['body { background: image-set("image.png" 1x) }', true],
    [`body { background: url('${SVG_WITH_OWN_GRADIENT}') }`, false],
    ['body { filter: url(#blur); content: "url(https://example.com)" }', false],
    // 文本层允许转义漏过；真实 CSSOM 必须再次检查。
    ['body { background-image: u\\72l(https://example.com/a) }', false],
  ] as const)('%s → %s', (css, fetches) => {
    expect(themeCssLoadsRemoteFiles(css)).toBe(fetches);
  });
});
