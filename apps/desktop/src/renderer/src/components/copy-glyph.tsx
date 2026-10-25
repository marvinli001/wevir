// SPDX-License-Identifier: MIT
// 改写自 kuratlielia/arc-library registry/components/copy-button/copy-button.tsx 与 use-copy-feedback.ts
// 来源提交 fff39c044c6e3b86006e3a6acc9a32a821a80d99
// Copyright (c) 2026 Elia Kuratli
// 由 Wevir 修改：不用 motion，两个图标叠在同一格里用 CSS 过渡交叉淡化（复制图标缩小、糊掉，对勾按 pathLength 画出来），
// 回到复制图标时同样过渡；文字按 Arc 的做法预留最宽的一种，按钮宽度不变；时长与缓动用 theme.css 的令牌，没有失败状态。

import { cn } from 'cn';
import { Copy } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

/** 复制后显示对勾多久。 */
const COPIED_MS = 1500;

/** 复制成功后的一小段时间里为 true；`mark` 重复调用时重新计时。 */
export function useCopied(): [copied: boolean, mark: () => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const mark = useCallback(() => {
    window.clearTimeout(timer.current);
    setCopied(true);
    timer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
  }, []);
  return [copied, mark];
}

/**
 * 复制按钮里的图标：复制图标与对勾叠在同一格。复制后复制图标缩到 50%、糊掉淡出（150 ms），对勾从 85% 走 press 弹簧放大，
 * 同时从起点画到终点（220 ms ease-fall，晚 40 ms）；回去时对勾 100 ms 淡出，复制图标走 press 弹簧回来。尺寸跟着按钮的
 * `[&_svg]` 规则。
 */
export function CopyGlyph({ copied }: { copied: boolean }) {
  return (
    <span aria-hidden className="inline-grid shrink-0 place-items-center *:[grid-area:1/1]">
      <Copy
        className={cn(
          'transition-[opacity,scale,filter]',
          copied
            ? 'scale-50 opacity-0 blur-[2px] duration-150 ease-smooth'
            : 'duration-(--spring-press-duration) ease-spring-press',
        )}
      />
      {/* lucide 的 Check，路径加 pathLength 才能按比例画。 */}
      <svg
        aria-hidden
        xmlns="http://www.w3.org/2000/svg"
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={cn(
          'transition-[opacity,scale]',
          copied
            ? 'duration-(--spring-press-duration) ease-spring-press'
            : 'scale-85 opacity-0 duration-100 ease-smooth',
        )}
      >
        <path
          d="M20 6 9 17l-5-5"
          pathLength={1}
          className={cn(
            '[stroke-dasharray:1] transition-[stroke-dashoffset]',
            copied
              ? 'delay-40 duration-220 ease-fall [stroke-dashoffset:0]'
              : 'delay-100 duration-0 [stroke-dashoffset:1]',
          )}
        />
      </svg>
    </span>
  );
}

/**
 * 复制按钮的文字：“复制”与“已复制”叠在同一格，宽度取两者里宽的那个，切换时交叉淡化并上移 2 px。读屏只读当前那句。
 */
export function CopyLabel({ copied, idle, done }: { copied: boolean; idle: string; done: string }) {
  return (
    <span className="inline-grid *:[grid-area:1/1] *:justify-self-start">
      <span
        aria-hidden={copied}
        className={cn(
          'transition-[opacity,translate] duration-150 ease-smooth',
          copied && '-translate-y-0.5 opacity-0',
        )}
      >
        {idle}
      </span>
      <span
        aria-hidden={!copied}
        className={cn(
          'transition-[opacity,translate] duration-150 ease-smooth',
          !copied && 'translate-y-0.5 opacity-0',
        )}
      >
        {done}
      </span>
    </span>
  );
}
