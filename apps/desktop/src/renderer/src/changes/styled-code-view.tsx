// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/web/src/components/diffs/StyledDiffCodeView.tsx
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：文件头由窗格自己画（renderCustomHeader），这里只给它定位与底色；去掉行选择与批注的样式（Wevir 不做 diff
// 批注）；颜色与字体换成 Wevir 的变量；展开的淡入遵守减弱动效。
//
// Pierre 的虚拟化 CodeView 加上 Wevir 的样式（desktop-tokens.md §33）：样式写进它的 shadow root（unsafeCSS），与虚拟
// 列表用的尺寸（itemMetrics）放在一起，改一边就要核对另一边。

import {
  CodeView,
  type CodeViewHandle,
  type CodeViewProps,
  type ControlledCodeViewProps,
} from '@pierre/diffs/react';
import type { Ref } from 'react';
import { DIFF_SURFACE_THEME_UNSAFE_CSS } from './diff-rendering';
import { DiffWorkerPoolProvider } from './diff-worker-pool';

/** 文件头与分隔条的高度：样式与 itemMetrics 共用，虚拟列表按它们排每一项。 */
export const DIFF_HEADER_HEIGHT = 32;
const HUNK_SEPARATOR_HEIGHT = 24;

export const DIFF_VIEW_UNSAFE_CSS = `${DIFF_SURFACE_THEME_UNSAFE_CSS}
[data-file-info] {
  background-color: var(--code-background) !important;
  border-block-color: transparent !important;
  color: var(--code-foreground) !important;
}

/* 文件头：内容是窗格画的（自定义头的 slot），这里只管吸顶、高度与底色。下边一条细线用内阴影，不占高度。 */
[data-diffs-header] {
  position: sticky !important;
  top: 0;
  z-index: 4;
  height: ${DIFF_HEADER_HEIGHT}px !important;
  min-height: ${DIFF_HEADER_HEIGHT}px !important;
  padding: 0 !important;
  background-color: var(--code-background) !important;
  border-bottom-color: transparent !important;
  box-shadow: inset 0 -1px var(--border);
  font-family: var(--font-ui) !important;
}

/* 分隔条是通往未修改的行的入口：保持库的布局（展开按钮单独一格），比代码底色深一点，悬停时提亮。（T3） */
:is([data-separator="line-info"], [data-separator="line-info-basic"]) {
  /* 精确、没有外边距：虚拟列表按下面的 hunkSeparatorHeight 排行。 */
  height: ${HUNK_SEPARATOR_HEIGHT}px !important;
  margin-block: 0 !important;
  --diffs-bg-separator: color-mix(in srgb, var(--code-background) 96%, var(--code-foreground));
}

:is([data-separator="line-info"], [data-separator="line-info-basic"]) [data-separator-content] {
  color: var(--muted-foreground) !important;
  font-family: var(--font-ui) !important;
  font-size: 12px !important;
  text-decoration: none !important;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"]) [data-expand-button] {
  color: var(--muted-foreground) !important;
}

:is([data-separator="line-info"], [data-separator="line-info-basic"])[data-expand-index]
  :is([data-separator-content], [data-expand-button]):hover {
  color: var(--code-foreground) !important;
  background-color: color-mix(in srgb, var(--code-background) 90%, var(--code-foreground)) !important;
  cursor: pointer;
}

/* 展开一个文件时正文一次挂上，淡入 200 ms（同 Collapse）。只动外观，几何归虚拟列表管，高度没法过渡。（T3） */
[data-diff],
[data-file] {
  transition: opacity 200ms cubic-bezier(0.22, 1, 0.36, 1);
}

@starting-style {
  [data-diff],
  [data-file] {
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  [data-diff],
  [data-file] {
    transition: none;
  }
}
`;

export type StyledDiffCodeViewOptions = Omit<
  NonNullable<CodeViewProps<undefined, undefined>['options']>,
  'unsafeCSS' | 'itemMetrics' | 'layout'
>;

type StyledDiffCodeViewProps = Omit<ControlledCodeViewProps<undefined, undefined>, 'options'> & {
  readonly options?: StyledDiffCodeViewOptions;
  readonly viewerRef?: Ref<CodeViewHandle<undefined, undefined>>;
};

/** 变更窗格的 CodeView：Wevir 的样式与虚拟化的尺寸在这里配对。 */
export function StyledDiffCodeView({
  options,
  viewerRef,
  className,
  ...props
}: StyledDiffCodeViewProps) {
  return (
    <DiffWorkerPoolProvider>
      <CodeView
        {...props}
        {...(viewerRef ? { ref: viewerRef } : {})}
        // 元素本身可以获得焦点（键盘滚动），它的原生轮廓画在窗格的裁切边界外，所以去掉；里面的控件保留自己的焦点环。
        className={`[--code-background:var(--background)] [--code-foreground:var(--foreground)] outline-none ${className ?? ''}`}
        options={{
          ...options,
          unsafeCSS: DIFF_VIEW_UNSAFE_CSS,
          itemMetrics: {
            diffHeaderHeight: DIFF_HEADER_HEIGHT,
            hunkSeparatorHeight: HUNK_SEPARATOR_HEIGHT,
            // Pierre 在展开文件的布局里把通用的文件间距当后备，和下面的 paddingTop 一起保持 0，否则展开第一个文件时头上又多出
            // 库默认的 8 px。（T3）
            spacing: 0,
            paddingTop: 0,
            // 文件最后一行下面的 8 px 是 Pierre 的样式无条件画的（--diffs-gap-fallback），尺寸里要算上，否则每个展开的文件的虚拟
            // 高度少 8 px，列表的末尾滚不到。（T3）
            paddingBottom: 8,
          },
          layout: { paddingTop: 0, paddingBottom: 0, gap: 0 },
        }}
      />
    </DiffWorkerPoolProvider>
  );
}
