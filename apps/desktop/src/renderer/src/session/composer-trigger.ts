// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/web/src/composer-logic.ts（detectComposerTrigger、replaceTextRange）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：Wevir 的输入框是纯文本 textarea，没有内联块，光标就是字符位置，去掉折叠光标的换算；这里只认 `@` 提及（斜杠命令
// 在 composer-commands.ts，只认消息开头）；没有 PR 与 `$` skill。
//
// 输入框的 @ 提及（U33）：光标往回到上一个空白为一个词，`@` 开头时弹出文件列表，选中后整个词换成 `@路径 `。

export interface MentionTrigger {
  /** `@` 之后、光标之前的文字。 */
  query: string;
  /** 这个词在文字里的范围（含 `@`）。 */
  rangeStart: number;
  rangeEnd: number;
}

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return text.length;
  return Math.max(0, Math.min(text.length, Math.floor(cursor)));
}

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\n' || char === '\t' || char === '\r';
}

function tokenStartForCursor(text: string, cursor: number): number {
  let index = cursor - 1;
  while (index >= 0 && !isWhitespace(text[index] ?? '')) index -= 1;
  return index + 1;
}

/** 光标所在的词是 `@…` 时给出提及的查询；否则 `null`。 */
export function detectMentionTrigger(text: string, cursorInput: number): MentionTrigger | null {
  const cursor = clampCursor(text, cursorInput);
  const tokenStart = tokenStartForCursor(text, cursor);
  const token = text.slice(tokenStart, cursor);
  if (!token.startsWith('@')) return null;
  return { query: token.slice(1), rangeStart: tokenStart, rangeEnd: cursor };
}

/** 把 `[rangeStart, rangeEnd)` 换成 `replacement`，返回新文字与光标（替换内容的末尾）。 */
export function replaceTextRange(
  text: string,
  rangeStart: number,
  rangeEnd: number,
  replacement: string,
): { text: string; cursor: number } {
  const safeStart = Math.max(0, Math.min(text.length, rangeStart));
  const safeEnd = Math.max(safeStart, Math.min(text.length, rangeEnd));
  const nextText = `${text.slice(0, safeStart)}${replacement}${text.slice(safeEnd)}`;
  return { text: nextText, cursor: safeStart + replacement.length };
}

/** 提及写进消息的文字：`@路径`；路径含空白时用反引号括起来。 */
export function mentionText(path: string): string {
  return /\s/.test(path) ? `@\`${path}\`` : `@${path}`;
}
