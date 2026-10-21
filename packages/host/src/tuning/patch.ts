// 把模型给的 unified diff 打到文本上（调优的建议 0.87.0，`rule` 类）。模型写的 diff 行号常常不准，所以不看行号，按上下文与删除行
// 在原文里找位置：从上一个 hunk 结束的地方往后找第一处完全相同的一段，找不到再按去掉行尾空白比一次。只有新增行、没有上下文的 hunk
// 按头里的旧起始行放（超出就放末尾）。任何一个 hunk 放不上就整体失败，不猜。

interface Hunk {
  /** `@@ -a,b +c,d @@` 里的 a（从 1 起；0 表示空文件）。 */
  oldStart: number;
  lines: { op: ' ' | '-' | '+'; text: string }[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/;

function parseHunks(diff: string): Hunk[] | undefined {
  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  for (const raw of diff.replace(/\r\n/g, '\n').split('\n')) {
    const header = HUNK_HEADER.exec(raw);
    if (header !== null) {
      current = { oldStart: Number(header[1]), lines: [] };
      hunks.push(current);
      continue;
    }
    if (current === undefined) continue;
    if (raw.startsWith('\\')) continue;
    if (raw.startsWith('--- ') || raw.startsWith('+++ ')) {
      // 下一个文件的头：只认第一个文件。
      if (current.lines.length > 0) break;
      continue;
    }
    const op = raw[0];
    if (op === '+' || op === '-' || op === ' ') current.lines.push({ op, text: raw.slice(1) });
    // 模型常把空的上下文行写成真正的空行。
    else if (raw === '') current.lines.push({ op: ' ', text: '' });
    else return undefined;
  }
  // 去掉每个 hunk 末尾由文本结尾带出来的空上下文行。
  for (const hunk of hunks) {
    while (hunk.lines.at(-1)?.op === ' ' && hunk.lines.at(-1)?.text === '') hunk.lines.pop();
  }
  const usable = hunks.filter((hunk) => hunk.lines.some((line) => line.op !== ' '));
  return usable.length === 0 ? undefined : usable;
}

function find(
  haystack: readonly string[],
  needle: readonly string[],
  from: number,
  same: (a: string, b: string) => boolean,
): number {
  for (let start = from; start + needle.length <= haystack.length; start += 1) {
    let ok = true;
    for (let i = 0; i < needle.length; i += 1) {
      if (!same(haystack[start + i] as string, needle[i] as string)) {
        ok = false;
        break;
      }
    }
    if (ok) return start;
  }
  return -1;
}

/** 打补丁；放不上、没有改动或 diff 读不懂时 `undefined`。 */
export function applyUnifiedDiff(before: string, diff: string): string | undefined {
  const hunks = parseHunks(diff);
  if (hunks === undefined) return undefined;
  const normalized = before.replace(/\r\n/g, '\n');
  const lines = normalized === '' ? [] : normalized.split('\n');
  const trailingNewline = normalized === '' || normalized.endsWith('\n');
  if (trailingNewline && lines.at(-1) === '') lines.pop();
  let cursor = 0;
  for (const hunk of hunks) {
    const old = hunk.lines.filter((line) => line.op !== '+').map((line) => line.text);
    let at: number;
    if (old.length === 0) {
      at = Math.max(cursor, Math.min(lines.length, Math.max(0, hunk.oldStart)));
    } else {
      at = find(lines, old, cursor, (a, b) => a === b);
      if (at < 0) at = find(lines, old, cursor, (a, b) => a.trimEnd() === b.trimEnd());
      if (at < 0) return undefined;
    }
    // 上下文行留原文（模型抄的可能差了行尾空白）。
    const added: string[] = [];
    let offset = at;
    for (const line of hunk.lines) {
      if (line.op === '+') added.push(line.text);
      else {
        if (line.op === ' ') added.push(lines[offset] as string);
        offset += 1;
      }
    }
    lines.splice(at, old.length, ...added);
    cursor = at + added.length;
  }
  const after = lines.join('\n') + (trailingNewline && lines.length > 0 ? '\n' : '');
  return after === normalized ? undefined : after;
}
