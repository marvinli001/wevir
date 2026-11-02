// 流式回答的渐进显示（打字机）：收到的文字先进缓冲，按帧匀速放出来，落后越多放得越快；节奏同桌面端
// （apps/desktop 的 session/markdown/reveal.ts）。另有流式 Markdown 的末尾修补：还没写完的语法先不露出来。纯逻辑。

/** 两次放字之间至少隔多久：每一帧都要重新解析 Markdown，手机上约 30 帧每秒。 */
export const REVEAL_FRAME_MS = 32;

/** 最慢每秒放多少字：缓冲很少时也像在打字，不会一顿一顿。 */
const MIN_CHARS_PER_SECOND = 60;
/** 缓冲多久能放完：落后的字数除以它就是速度。 */
const CATCH_UP_MS = 320;
/** 回答写完以后剩下的放得更快。 */
const FINISH_MS = 140;

/**
 * 下一帧显示到第几个字（UTF-16 下标）。`shown` 是现在显示的，`target` 是收到的全文，`elapsedMs` 是离上一帧多久，
 * `ended` 是不会再有新字了。不会切开代理对。
 */
export function revealStep(
  shown: number,
  target: string,
  elapsedMs: number,
  ended: boolean,
): number {
  const backlog = target.length - shown;
  if (backlog <= 0) return target.length;
  const perMs = Math.max(MIN_CHARS_PER_SECOND / 1000, backlog / (ended ? FINISH_MS : CATCH_UP_MS));
  let next = Math.min(target.length, shown + Math.max(1, Math.round(perMs * elapsedMs)));
  const code = target.charCodeAt(next - 1);
  if (code >= 0xd800 && code <= 0xdbff && next < target.length) next += 1;
  return next;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const BARE_MARKER = /^ {0,3}(?:#{1,6}|[-*+]|\d{1,9}[.)]?|>)\s*$/;
const PARTIAL_FENCE = /^ {0,3}(?:`{1,2}|~{1,2}|`{3,}[^`]*|~{3,}.*)$/;

/** 末尾是否在没闭合的围栏代码块里。 */
function insideFence(lines: readonly string[]): boolean {
  let open: string | undefined;
  for (const line of lines) {
    const match = FENCE.exec(line);
    if (!match) continue;
    const marker = match[1] as string;
    if (open === undefined) open = marker;
    else if (marker[0] === open[0] && marker.length >= open.length && line.trim() === marker) {
      open = undefined;
    }
  }
  return open !== undefined;
}

/**
 * 还在写的回答的末尾修补（思路同桌面端 stream-safe.ts，只动末行）：末行只有块标记（`#`、`-`、`1.`、`>`）或是半截围栏开头时
 * 先不显示这一行；末行没闭合的 `**` 与 `` ` `` 补上闭合（刚写出开头、后面还没有字时去掉开头）。代码块里的内容不动。
 */
export function streamSafe(text: string): string {
  const start = text.lastIndexOf('\n') + 1;
  const head = text.slice(0, start);
  const last = text.slice(start);
  if (last === '') return text;
  const before = head.split('\n');
  const inFence = insideFence(before);
  if (!inFence && (BARE_MARKER.test(last) || PARTIAL_FENCE.test(last))) return head;
  if (inFence) return text;
  let line = last;
  for (const mark of ['**', '`']) {
    const count = line.split(mark).length - 1;
    if (count % 2 === 0) continue;
    line = line.endsWith(mark) ? line.slice(0, -mark.length) : `${line}${mark}`;
  }
  return head + line;
}
