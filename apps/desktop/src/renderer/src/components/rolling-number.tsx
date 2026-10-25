// SPDX-License-Identifier: MIT
// 改写自 kuratlielia/arc-library registry/components/slot-text/slot-text.tsx
// 来源提交 fff39c044c6e3b86006e3a6acc9a32a821a80d99
// Copyright (c) 2026 Elia Kuratli
// 由 Wevir 修改：不用 motion，每位数字是一列 0–9，用 CSS 的 translate 过渡滚到新值（snap 弹簧），从右往左每位晚 16 ms；
// 宽度与基线由下面一层透明的原文决定，读屏、复制与 textContent 读的也是它（滚轮与上层字符都是 CSS 生成内容）；非数字的字符不滚。

import { cn } from 'cn';

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
/** 相邻两位开始滚动的间隔（ms）。 */
const STAGGER_MS = 16;

/**
 * 数字变化时逐位滚过去（照 Arc 的 slot-text）：`value` 是已经格式化好的文字（千分位、单位、百分号都可以），其中的数字
 * 各自是一列滚轮，其余字符原样显示。位置从右往左对齐，位数变了时新增的位直接出现。第一次显示不滚。
 */
export function RollingNumber({ value, className }: { value: string; className?: string }) {
  const chars = Array.from(value);
  return (
    <span className={cn('relative inline-block whitespace-nowrap tabular-nums', className)}>
      <span className="text-transparent">{value}</span>
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 flex overflow-hidden whitespace-pre select-none"
      >
        {chars.map((char, index) => {
          const fromEnd = chars.length - 1 - index;
          const digit = DIGITS.indexOf(char);
          return digit < 0 ? (
            <span
              key={`c${fromEnd}`}
              data-char={char}
              className="before:content-[attr(data-char)]"
            />
          ) : (
            <span key={`d${fromEnd}`} className="h-full overflow-hidden">
              <span
                className="digit-reel transition-[translate] duration-(--spring-snap-duration) ease-spring-snap"
                style={{
                  translate: `0 ${digit * -10}%`,
                  transitionDelay: `${fromEnd * STAGGER_MS}ms`,
                }}
              />
            </span>
          );
        })}
      </span>
    </span>
  );
}
