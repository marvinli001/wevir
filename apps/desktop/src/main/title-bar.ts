// Windows 的标题栏：隐藏系统标题栏，由页面的顶栏充当标题栏，最小化、最大化与关闭按钮由系统画在窗口右上角
// （Electron 的 titleBarOverlay）。这里只算按钮的参数，不碰 Electron 的运行时，单元测试直接检查。

/** 页面顶栏的高（渲染进程的 h-11），界面缩放比例是 1 时窗口按钮也这么高。 */
export const TITLE_BAR_HEIGHT = 44;

/** Chromium 的缩放范围（25 % 到 500 %）。 */
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;

export interface TitleBarOverlay {
  color: string;
  symbolColor: string;
  height: number;
}

/**
 * 窗口按钮的底色、图形颜色与高。
 *
 * - 底色透明：按钮下面是页面的顶栏（壳的颜色或系统材质），悬停与按下的底色由系统按深浅色画。
 * - 图形颜色跟界面的深浅色。
 * - 高跟着界面缩放比例：顶栏是 44 CSS px，放大或缩小界面后按钮要和它一样高，否则缩小时按钮伸到顶栏下面的内容上。
 */
export function titleBarOverlay(dark: boolean, zoomFactor: number): TitleBarOverlay {
  const zoom = Number.isFinite(zoomFactor) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoomFactor)) : 1;
  return {
    color: '#00000000',
    symbolColor: dark ? '#f2f2f2' : '#1a1a1a',
    height: Math.round(TITLE_BAR_HEIGHT * zoom),
  };
}
