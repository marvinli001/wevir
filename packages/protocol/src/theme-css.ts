// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/shared/src/themeCss.ts
// 来源提交 6b7027b1f43eebc4c7edf5304236a0775b2d8928
// Copyright (c) 2026 T3 Tools Inc.
// 修改：只保留 CSS 取文件检查；稳定选择器改为 Wevir 的界面与组件。

const FETCHES_BY_STRING = /image-set\(|\bsrc\(/i;
// 只接受 CSS 空白；不换行空格等字符会把 data: 变成相对地址。
const URL_NOT_LOCAL = /url\((?![ \t\n\f\r]*["']?(?:data:|#))/i;
const URL_OR_STRING =
  /url\((?![ \t\n\f\r]*["'])[^)]*|url\([ \t\n\f\r]*("[^"\n\r\f]*"|'[^'\n\r\f]*')|"[^"\n\r\f]*"|'[^'\n\r\f]*'/gi;

function fetchesByText(code: string): boolean {
  const outsideStrings = code.replace(URL_OR_STRING, (token, urlString: string | undefined) => {
    if (urlString !== undefined) return /^["'](?:data:|#)/i.test(urlString) ? '' : 'url(';
    return token.startsWith('"') || token.startsWith("'") ? '' : token;
  });
  return FETCHES_BY_STRING.test(outsideStrings) || URL_NOT_LOCAL.test(outsideStrings);
}

/** var() 保留未解析的 token；拒绝残留转义，避免隐藏的 url、var 或 image-set 绕过检查。 */
export function themeCssValueFetches(value: string): boolean {
  return value.includes('\\') || fetchesByText(value);
}

/** 仅供保存时尽早报错；转义可绕过文本检查，客户端 CSSOM 才是守卫。 */
export function themeCssLoadsRemoteFiles(css: string): boolean {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
  return /@import/i.test(code) || fetchesByText(code);
}

/** 主题可依赖的选择器；theme-css-hooks.test.ts 锁定对应源码，工具指南复用此表。 */
export const THEME_CSS_HOOKS = [
  { selector: '[data-app-shell]', styles: 'application shell' },
  { selector: '[data-app-sidebar]', styles: 'application sidebar' },
  { selector: '[data-session-row]', styles: 'sidebar session row' },
  { selector: '[data-app-header]', styles: 'title bar' },
  { selector: '[data-main-card]', styles: 'main content card' },
  { selector: '[data-message-scroll]', styles: 'message scroller' },
  { selector: '[data-message-role="user"]', styles: 'user message row' },
  { selector: '[data-user-message-bubble]', styles: 'user message bubble' },
  { selector: '[data-message-role="assistant"]', styles: 'assistant message' },
  { selector: '[data-code-block]', styles: 'code block' },
  { selector: '[data-composer-box]', styles: 'composer surface' },
  { selector: '[data-aux-pane]', styles: 'auxiliary pane' },
  { selector: '[data-session-rail]', styles: 'session sidebar' },
  { selector: '[data-settings-page]', styles: 'settings page' },
  { selector: '[data-slot="button"]', styles: 'button' },
  { selector: '[data-slot="input"]', styles: 'text input' },
  { selector: '[data-slot="textarea"]', styles: 'multiline input' },
  { selector: '[data-slot="checkbox"]', styles: 'checkbox' },
  { selector: '[data-slot="radio"]', styles: 'radio button' },
  { selector: '[data-slot="slider"]', styles: 'slider' },
  { selector: '[data-slot="select-trigger"]', styles: 'select trigger' },
  { selector: '[data-slot="select-content"]', styles: 'select popup' },
  { selector: '[data-slot="select-item"]', styles: 'select item' },
  { selector: '[data-slot="dialog-overlay"]', styles: 'dialog overlay' },
  { selector: '[data-slot="dialog-content"]', styles: 'dialog' },
  { selector: '[data-slot="sheet-overlay"]', styles: 'sheet overlay' },
  { selector: '[data-slot="sheet-content"]', styles: 'sheet' },
  { selector: '[data-slot="popover-content"]', styles: 'popover' },
  { selector: '[data-slot="dropdown-menu-content"]', styles: 'menu' },
  { selector: '[data-slot="dropdown-menu-item"]', styles: 'menu item' },
  { selector: '[data-slot="context-menu-content"]', styles: 'context menu' },
  { selector: '[data-slot="tooltip-content"]', styles: 'tooltip' },
  { selector: '[data-slot="scroll-area-viewport"]', styles: 'scroll viewport' },
  { selector: '[data-slot="scroll-area-scrollbar"]', styles: 'overlay scrollbar' },
  { selector: '[data-slot="scroll-area-thumb"]', styles: 'overlay scrollbar thumb' },
] as const;
