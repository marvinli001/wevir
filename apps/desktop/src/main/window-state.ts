// 主窗口的位置与大小（记在桌面端的 userData 里，window-state.json）：关掉再打开时回到上次的样子。存的是“还原”时的
// 位置与大小（最大化时取 getNormalBounds）和是否最大化；全屏不恢复（打开就进全屏很突兀），按退出全屏后的大小存。
// 读回时对着当前的显示器校正：显示器拔掉了、分辨率变小了，窗口不能落在屏幕外或比屏幕还大。

import { readFileSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface WindowState {
  /** 没有位置时由系统居中。 */
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

export const WINDOW_STATE_FILE = 'window-state.json';

/** 窗口至少要有这么多露在某个显示器的工作区里，否则当作看不见，回到居中。 */
const MIN_VISIBLE = 64;

const isInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value);

/** 读回文件内容；格式不对时返回 undefined（用默认大小）。 */
export function parseWindowState(raw: unknown): WindowState | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const value = raw as Partial<Record<keyof WindowState, unknown>>;
  if (!isInt(value.width) || !isInt(value.height) || value.width <= 0 || value.height <= 0) {
    return undefined;
  }
  return {
    ...(isInt(value.x) && isInt(value.y) && { x: value.x, y: value.y }),
    width: value.width,
    height: value.height,
    maximized: value.maximized === true,
  };
}

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  return {
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

/**
 * 把存下的状态校正到当前的显示器：大小不小于最小尺寸、不大于最大的工作区；位置要让窗口在某个工作区里露出至少
 * MIN_VISIBLE 见方（标题栏一带能抓得到），否则去掉位置，由系统居中。
 */
export function fitWindowState(
  state: WindowState,
  workAreas: readonly Rect[],
  min: { width: number; height: number },
): WindowState {
  const maxWidth = Math.max(min.width, ...workAreas.map((area) => area.width));
  const maxHeight = Math.max(min.height, ...workAreas.map((area) => area.height));
  const width = Math.min(Math.max(state.width, min.width), maxWidth);
  const height = Math.min(Math.max(state.height, min.height), maxHeight);
  const base = { width, height, maximized: state.maximized };
  if (state.x === undefined || state.y === undefined) return base;
  const bounds = { x: state.x, y: state.y, width, height };
  // 顶部一条（标题栏）要在屏幕里：只看窗口最上面 MIN_VISIBLE 高的那条。
  const titleBar = { ...bounds, height: Math.min(MIN_VISIBLE, height) };
  const visible = workAreas.some((area) => {
    const shown = overlap(titleBar, area);
    return shown.width >= MIN_VISIBLE && shown.height > 0;
  });
  return visible ? { ...base, x: state.x, y: state.y } : base;
}

/** 启动时同步读（窗口创建之前）；没有或坏了返回 undefined。 */
export function loadWindowState(dir: string): WindowState | undefined {
  try {
    return parseWindowState(JSON.parse(readFileSync(join(dir, WINDOW_STATE_FILE), 'utf8')));
  } catch {
    return undefined;
  }
}

/** 先写临时文件再改名，写到一半退出不会留下坏文件。 */
export async function saveWindowState(dir: string, state: WindowState): Promise<void> {
  const file = join(dir, WINDOW_STATE_FILE);
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(state)}\n`, 'utf8');
  await rename(temp, file);
}
