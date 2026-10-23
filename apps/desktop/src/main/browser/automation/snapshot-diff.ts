// 增量快照（0.113.0）：和这个标签页上一次同范围的快照逐行比，只给变了的行。引用在两次快照之间对同一个元素不变
// （aria-snapshot-script.ts 沿用上一次的编号），所以没变的元素那一行也不变；变了的部分按块给出，每块开头注明它在哪些
// 祖先节点下面。变得太多或放不进一段时由调用方改给整个快照。

/** 最多比到多少处增删（Myers 的 D）；再多就当作整页换了。 */
const MAX_EDITS = 2_000;
/** 每块开头最多列几层祖先。 */
const MAX_ANCESTORS = 3;
const MAX_ANCESTOR_CHARS = 100;

export type LineEdit = { kind: 'same' | 'add' | 'remove'; text: string };

/** 逐行比较（先去掉相同的头尾，中间用 Myers）；增删超过 `maxEdits` 时返回 undefined。 */
export function diffLines(
  before: readonly string[],
  after: readonly string[],
  maxEdits = MAX_EDITS,
): LineEdit[] | undefined {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  )
    tail += 1;
  const middle = myers(
    before.slice(head, before.length - tail),
    after.slice(head, after.length - tail),
    maxEdits,
  );
  if (!middle) return undefined;
  return [
    ...before.slice(0, head).map((text): LineEdit => ({ kind: 'same', text })),
    ...middle,
    ...before.slice(before.length - tail).map((text): LineEdit => ({ kind: 'same', text })),
  ];
}

function myers(
  a: readonly string[],
  b: readonly string[],
  maxEdits: number,
): LineEdit[] | undefined {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((text) => ({ kind: 'add', text }));
  if (m === 0) return a.map((text) => ({ kind: 'remove', text }));
  const limit = Math.min(n + m, maxEdits);
  const offset = limit + 1;
  let v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= limit; d += 1) {
    trace.push(v.slice());
    const next = v.slice();
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number))
          ? (v[offset + k + 1] as number)
          : (v[offset + k - 1] as number) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      next[offset + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, [...trace, next], offset, d);
    }
    v = next;
  }
  return undefined;
}

function backtrack(
  a: readonly string[],
  b: readonly string[],
  trace: Int32Array[],
  offset: number,
  depth: number,
): LineEdit[] {
  const edits: LineEdit[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = depth; d > 0; d -= 1) {
    const v = trace[d] as Int32Array;
    const k = x - y;
    const down =
      k === -d || (k !== d && (v[offset + k - 1] as number) < (v[offset + k + 1] as number));
    const prevK = down ? k + 1 : k - 1;
    const prevX = v[offset + prevK] as number;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      edits.push({ kind: 'same', text: a[x] as string });
    }
    if (down) {
      y -= 1;
      edits.push({ kind: 'add', text: b[y] as string });
    } else {
      x -= 1;
      edits.push({ kind: 'remove', text: a[x] as string });
    }
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    edits.push({ kind: 'same', text: a[x] as string });
  }
  return edits.reverse();
}

export interface SnapshotChanges {
  /** 只有变了的块（没变化时是一行说明）。 */
  text: string;
  added: number;
  removed: number;
  unchanged: number;
}

const indentOf = (line: string) => line.length - line.trimStart().length;

function describeLine(line: string): string {
  const text = line.trim().replace(/^- /, '');
  return text.length > MAX_ANCESTOR_CHARS ? `${text.slice(0, MAX_ANCESTOR_CHARS)}…` : text;
}

/**
 * 把逐行比较的结果写成增量：每块前面一行 `# in: 祖先 > 祖先`，增加的行前面是 `+`、去掉的是 `-`，后面是原来的那一行
 * （保留缩进）。`clamp` 截断超长的行。
 */
export function renderChanges(
  edits: readonly LineEdit[],
  clamp: (line: string) => string,
): SnapshotChanges {
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  // 祖先：在“现在的”快照里往回找缩进更少的行；去掉的行用它在原来快照里的位置。
  const current: string[] = [];
  const out: string[] = [];
  let inHunk = false;
  for (const edit of edits) {
    if (edit.kind === 'same') {
      unchanged += 1;
      current.push(edit.text);
      inHunk = false;
      continue;
    }
    if (!inHunk) {
      inHunk = true;
      const ancestors: string[] = [];
      let depth = indentOf(edit.text);
      for (let index = current.length - 1; index >= 0 && depth > 0; index -= 1) {
        const line = current[index] as string;
        const indent = indentOf(line);
        if (indent < depth) {
          // 最外层的 document 只在没有别的祖先时写。
          if (indent === 0 && ancestors.length > 0) break;
          ancestors.unshift(describeLine(line));
          depth = indent;
          if (ancestors.length >= MAX_ANCESTORS) break;
        }
      }
      out.push(ancestors.length > 0 ? `# in: ${ancestors.join(' > ')}` : '# at the top:');
    }
    if (edit.kind === 'add') {
      added += 1;
      current.push(edit.text);
      out.push(`+${clamp(edit.text)}`);
    } else {
      removed += 1;
      out.push(`-${clamp(edit.text)}`);
    }
  }
  return { text: out.join('\n'), added, removed, unchanged };
}
