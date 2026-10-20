// 行级批注的定位（0.67.0，ADR-0009）：写批注时记下那几行的原文与前后几行上下文；之后文件变了，按原文重新找。原来的行仍是原文
// 是 `current`；原文在文件里只出现一处（或多处里只有一处前后文也对得上）是 `relocated`；找不到或分不出是 `outdated`。宁可标过期，
// 也不指向另一段代码。

import type { ReviewAnchor } from '@wevir/protocol';

/** 上下文：片段前后各取几行。 */
export const REVIEW_CONTEXT_LINES = 2;

/** 文本按行切开：去掉每行末尾的 `\r`，文件以换行结尾时不多出一个空行。 */
export function splitLines(text: string): string[] {
  const lines = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (lines.length > 0 && lines.at(-1) === '') lines.pop();
  return lines;
}

export interface CapturedRange {
  snippet: string;
  contextBefore: string;
  contextAfter: string;
}

/** 取出 `startLine`–`endLine`（从 1 起、含两端）与前后的上下文；超出文件时 undefined。 */
export function captureRange(
  lines: readonly string[],
  startLine: number,
  endLine: number,
): CapturedRange | undefined {
  if (startLine < 1 || endLine < startLine || endLine > lines.length) return undefined;
  return {
    snippet: lines.slice(startLine - 1, endLine).join('\n'),
    contextBefore: lines
      .slice(Math.max(0, startLine - 1 - REVIEW_CONTEXT_LINES), startLine - 1)
      .join('\n'),
    contextAfter: lines.slice(endLine, endLine + REVIEW_CONTEXT_LINES).join('\n'),
  };
}

export interface AnchorTarget extends CapturedRange {
  startLine: number;
  endLine: number;
}

/**
 * 在现在的文件里找批注的原文。原文只出现一处就认它；出现多处时只认前后文也对得上的那一处（原来的位置优先），仍分不出就过期。
 */
export function locate(lines: readonly string[], target: AnchorTarget): ReviewAnchor {
  const wanted = target.snippet.split('\n');
  const count = wanted.length;
  const found: number[] = [];
  for (let index = 0; index + count <= lines.length; index += 1) {
    if (matchesAt(lines, wanted, index)) found.push(index);
  }
  if (found.length === 0) return { state: 'outdated', reason: 'changed' };
  const before = target.contextBefore === '' ? [] : target.contextBefore.split('\n');
  const after = target.contextAfter === '' ? [] : target.contextAfter.split('\n');
  const inContext = (index: number) =>
    matchesAt(lines, before, index - before.length) && matchesAt(lines, after, index + count);
  const original = target.startLine - 1;
  let chosen: number | undefined;
  if (found.length === 1) chosen = found[0];
  else if (found.includes(original) && inContext(original)) chosen = original;
  else {
    const candidates = found.filter(inContext);
    if (candidates.length === 1) chosen = candidates[0];
  }
  if (chosen === undefined) return { state: 'outdated', reason: 'ambiguous' };
  return {
    state: chosen === original ? 'current' : 'relocated',
    startLine: chosen + 1,
    endLine: chosen + count,
  };
}

function matchesAt(lines: readonly string[], wanted: readonly string[], index: number): boolean {
  if (index < 0 || index + wanted.length > lines.length) return false;
  return wanted.every((line, offset) => lines[index + offset] === line);
}
