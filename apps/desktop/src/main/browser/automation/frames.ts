// 页面里的 frame（0.48.0）：快照、执行、查询与等待能进入 iframe，跨域的也行。
//
// frame 的编号从顶层起每层是它在父窗口 `frames` 里的序号（`1`、`1.0`），页面里的脚本（aria-snapshot-script.ts 的 framePathOf）和
// 这里用同一个算法：跨域时也能比较 WindowProxy、读 `parent.frames`，所以每个 frame 能自己算出编号，不用把 Electron 的
// WebFrameMain 和 DOM 里的 iframe 元素对上。脚本经 WebFrameMain.executeJavaScript 在那个 frame 的主世界里跑（同进程与跨进程的
// frame 一样），坐标换算逐层在父 frame 里量 iframe 内容区的位置。

import type { SnapshotPage } from './snapshot-engine.js';

/** 一个子 frame（不含顶层）。 */
export interface TabFrame {
  /** 编号，例如 `1.0`。 */
  id: string;
  url: string;
  name: string;
  page: SnapshotPage;
}

/** 列出 frame 的标签页（contents.ts 的 `listFrames`）。 */
export interface FramedPage extends SnapshotPage {
  listFrames?(): Promise<TabFrame[]>;
}

/** 在 frame 里算出自己的编号；顶层是空串，算不出来是 null。 */
export const FRAME_PATH_SCRIPT = `(() => {
  const parts = [];
  let current = window;
  try {
    while (current !== current.top) {
      const parent = current.parent;
      let index = -1;
      for (let i = 0; i < parent.frames.length; i += 1) {
        if (parent.frames[i] === current) { index = i; break; }
      }
      if (index < 0) return null;
      parts.unshift(index);
      current = parent;
    }
  } catch {
    return null;
  }
  return parts.join('.');
})()`;

/** 在父 frame 里量第 `index` 个子 frame 的内容区左上角，并看 `point`（子 frame 里的坐标）上是不是点得到这个 iframe。 */
export function childFrameOffsetScript(index: number, point: { x: number; y: number }): string {
  return `(() => {
    const child = window.frames[${JSON.stringify(index)}];
    if (!child) return null;
    let element = null;
    for (const candidate of document.querySelectorAll('iframe, frame')) {
      if (candidate.contentWindow === child) { element = candidate; break; }
    }
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const x = rect.left + element.clientLeft + (parseFloat(style.paddingLeft) || 0);
    const y = rect.top + element.clientTop + (parseFloat(style.paddingTop) || 0);
    const point = ${JSON.stringify(point)};
    const hit = document.elementFromPoint(x + point.x, y + point.y);
    return { x, y, hit: hit === element };
  })()`;
}

/**
 * 按 agent 给的说法找 frame：编号（`1.0`）优先，其次是名字，再次是地址里含有这一段。
 */
export function findFrame(frames: readonly TabFrame[], spec: string): TabFrame | undefined {
  return (
    frames.find((frame) => frame.id === spec) ??
    frames.find((frame) => frame.name !== '' && frame.name === spec) ??
    frames.find((frame) => frame.url.includes(spec))
  );
}

/** 找不到 frame 时的说明：列出有哪些。 */
export function frameNotFoundMessage(frames: readonly TabFrame[], spec: string): string {
  if (frames.length === 0)
    return `The page has no frames, so there is no frame ${JSON.stringify(spec)}.`;
  const listed = frames
    .slice(0, 10)
    .map(
      (frame) =>
        `${frame.id}${frame.name ? ` name=${JSON.stringify(frame.name)}` : ''} ${frame.url || 'about:blank'}`,
    );
  return `No frame matches ${JSON.stringify(spec)}. Frames: ${listed.join('; ')}${frames.length > 10 ? `; and ${frames.length - 10} more` : ''}. Pass a frame id from the snapshot (frame=…), a frame name or part of its URL.`;
}

/**
 * 把 frame 里的一点换算成顶层页面的坐标：从里往外，逐层在父 frame 里加上 iframe 内容区的位置。`covered` 是某一层上这一点
 * 点到的不是那个 iframe（被盖住了，或在父 frame 的视口外）；量不出来时返回 null（frame 已经换了文档或没了）。
 */
export async function frameToTopPoint(
  top: SnapshotPage,
  frames: readonly TabFrame[],
  frameId: string,
  point: { x: number; y: number },
): Promise<{ x: number; y: number; covered: boolean } | null> {
  if (frameId === '') return { ...point, covered: false };
  const parts = frameId.split('.');
  let current = { ...point };
  let covered = false;
  for (let level = parts.length - 1; level >= 0; level -= 1) {
    const ownerId = parts.slice(0, level).join('.');
    const owner = ownerId === '' ? top : frames.find((frame) => frame.id === ownerId)?.page;
    if (!owner) return null;
    const measured = await owner
      .executeJavaScript(childFrameOffsetScript(Number(parts[level]), current))
      .catch(() => null);
    if (!isOffset(measured)) return null;
    current = { x: current.x + measured.x, y: current.y + measured.y };
    if (!measured.hit) covered = true;
  }
  return { ...current, covered };
}

function isOffset(value: unknown): value is { x: number; y: number; hit: boolean } {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.x === 'number' &&
    Number.isFinite(record.x) &&
    typeof record.y === 'number' &&
    Number.isFinite(record.y)
  );
}
