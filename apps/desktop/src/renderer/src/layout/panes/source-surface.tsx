// 文件预览里源码的显示设置（“文件”窗格的更多菜单）：制表符宽度交给 Pierre 的 `--diffs-tab-size`（高亮与编辑器的光标都按它算），
// “滚动超过末尾”在最后一行后面留出一屏减一行的空白。

import type { CSSProperties } from 'react';

/** Virtualizer 是滚动容器，按它的高留空白。 */
export const SOURCE_SCROLLER = 'h-full min-h-0 overflow-auto [container-type:size]';

export function sourceSurfaceStyle(tabSize: number): CSSProperties {
  return { '--diffs-tab-size': String(tabSize) } as CSSProperties;
}

export function ScrollPastEnd() {
  return <div aria-hidden className="h-[calc(100cqh-1.25rem)]" data-scroll-past-end="" />;
}
