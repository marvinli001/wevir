// “进程输出”窗格（0.68.0）的纯逻辑：输出缓冲按 Host 给的字节偏移量分块存（往后接、往前补、超出上限时丢掉另一头的整块），
// 拆成行（`\r` 覆写同一行只留最后一段），按窗格的列数折成等高的显示行，供虚拟滚动只渲染看得见的那几行。

import type { HostProcess, MethodResult } from '@wevir/protocol';

/** 缓冲里最多留多少字符；超出时丢掉另一头的整块。 */
export const OUTPUT_MAX_CHARS = 2_000_000;

export type OutputPage = MethodResult<'process.output'>;

interface Chunk {
  from: number;
  next: number;
  text: string;
}

export interface OutputBuffer {
  chunks: readonly Chunk[];
  /** 缓冲开头的偏移量。 */
  from: number;
  /** 缓冲末尾的偏移量（下一次往后读的 `offset`）。 */
  next: number;
  /** Host 还留着的最早偏移量。 */
  start: number;
  chars: number;
  /** 往前补时丢掉了末尾：不再跟着往后读，直到“跳到最新”。 */
  detached: boolean;
}

/** 同一个进程：Host 重启后 ID 会重用，加上启动时刻才认得出。 */
export function processKey(process: Pick<HostProcess, 'id' | 'startedAt'>): string {
  return `${process.id}@${process.startedAt}`;
}

export function bufferFromPage(page: OutputPage): OutputBuffer {
  return {
    chunks: page.text === '' ? [] : [{ from: page.from, next: page.next, text: page.text }],
    from: page.from,
    next: page.next,
    start: page.start,
    chars: page.text.length,
    detached: false,
  };
}

/** 往后接一页（`page.from` 应等于 `buffer.next`）。超出上限时从开头丢整块。 */
export function appendPage(buffer: OutputBuffer, page: OutputPage): OutputBuffer {
  if (page.next <= buffer.next) return { ...buffer, start: page.start };
  const chunks = [...buffer.chunks, { from: page.from, next: page.next, text: page.text }];
  let chars = buffer.chars + page.text.length;
  while (chars > OUTPUT_MAX_CHARS && chunks.length > 1) {
    chars -= (chunks.shift() as Chunk).text.length;
  }
  return {
    chunks,
    from: Math.max(chunks[0]?.from ?? page.from, page.start),
    next: page.next,
    start: page.start,
    chars,
    detached: false,
  };
}

/** 往前补一页（`page.next` 应等于 `buffer.from`）。超出上限时从末尾丢整块，之后不再跟着往后读。 */
export function prependPage(buffer: OutputBuffer, page: OutputPage): OutputBuffer {
  if (page.from >= buffer.from) return { ...buffer, start: page.start };
  const chunks = [{ from: page.from, next: page.next, text: page.text }, ...buffer.chunks];
  let chars = buffer.chars + page.text.length;
  let detached = buffer.detached;
  while (chars > OUTPUT_MAX_CHARS && chunks.length > 1) {
    chars -= (chunks.pop() as Chunk).text.length;
    detached = true;
  }
  return {
    chunks,
    from: page.from,
    next: chunks.at(-1)?.next ?? page.next,
    start: page.start,
    chars,
    detached,
  };
}

/** 更早的输出还在 Host 上。 */
export function hasEarlier(buffer: OutputBuffer): boolean {
  return buffer.from > buffer.start;
}

/** 缓冲开头之前的输出已经轮转丢掉了。 */
export function droppedBefore(buffer: OutputBuffer): boolean {
  return buffer.start > 0 && buffer.from <= buffer.start;
}

/** 拆成行：去掉 CRLF 的 `\r`，进度条用 `\r` 覆写的只留最后一段；末尾的换行不多出一个空行。 */
export function outputLines(buffer: OutputBuffer): string[] {
  const text = buffer.chunks.map((chunk) => chunk.text).join('');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines.map((raw) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const cut = line.lastIndexOf('\r');
    return (cut < 0 ? line : line.slice(cut + 1)).replaceAll('\t', '    ');
  });
}

export interface DisplayRow {
  text: string;
  /** 折行的后续部分。 */
  continued: boolean;
}

/** 按列数折行：每个显示行等高，超长的一行（几十万字符）也只是很多个显示行。 */
export function wrapRows(lines: readonly string[], columns: number): DisplayRow[] {
  const width = Math.max(20, Math.floor(columns));
  const rows: DisplayRow[] = [];
  for (const line of lines) {
    if (line.length <= width) {
      rows.push({ text: line, continued: false });
      continue;
    }
    for (let at = 0; at < line.length; at += width) {
      rows.push({ text: line.slice(at, at + width), continued: at > 0 });
    }
  }
  return rows;
}

/** 虚拟滚动：看得见的显示行的范围（多留几行）。 */
export function visibleRange(
  scrollTop: number,
  height: number,
  rowHeight: number,
  total: number,
  overscan = 10,
): { first: number; last: number } {
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(total, Math.ceil((scrollTop + height) / rowHeight) + overscan);
  return { first, last };
}

/** 列表里先列在跑的（最近起的在前），再列已结束的（最近结束的在前）。 */
export function sortProcesses(processes: readonly HostProcess[]): {
  running: HostProcess[];
  exited: HostProcess[];
} {
  const running = processes
    .filter((item) => item.status === 'running')
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const exited = processes
    .filter((item) => item.status !== 'running')
    .sort((a, b) => (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt));
  return { running, exited };
}

/** 停止的对象：POSIX 上是进程组；只能 SIGKILL 的（Windows）是进程树；检查是这一次检查。 */
export function stopTarget(process: HostProcess): 'group' | 'tree' | 'check' {
  if (process.source.kind === 'check') return 'check';
  return process.stopSignals.includes('SIGINT') ? 'group' : 'tree';
}
