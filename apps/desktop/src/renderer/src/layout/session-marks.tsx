// 会话行与顶栏标题的变化动效（desktop-tokens.md §71，跳跃）：跑完的勾与逐字显出的标题。时刻由 session-motion.ts 给，
// 动画本身在 theme.css（done-mark、glyph-in）；挂载晚了的用负的 animation-delay 接着播。

import { type CSSProperties, useEffect, useState } from 'react';
import { useReducedMotion } from '@/fx/motion';

/** 跑完的勾（照 monocode 的圈勾）：圆圈从顶上顺时针画出，接着画勾，停一会淡出；只是装饰，左栏右边另有未读点。 */
export function DoneMark({ at }: { at: number }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      data-slot="done-mark"
      className="size-3.5 done-mark text-success"
      style={motionElapsed(at)}
    >
      <circle
        cx="8"
        cy="8"
        r="6.25"
        pathLength={1}
        transform="rotate(-90 8 8)"
        className="done-mark-ring"
      />
      <path d="M5.25 8.25 7.2 10.1 10.75 6.25" pathLength={1} className="done-mark-check" />
    </svg>
  );
}

/** theme.css 的 status-jump、status-enter、done-mark 从这个变量取起点：挂载晚了的元素从已经播到的地方接着播。 */
export function motionElapsed(at: number): CSSProperties {
  return { '--motion-elapsed': `${at - Date.now()}ms` } as CSSProperties;
}

/** 每个字之间错开的时间；第 GLYPH_STAGGER_CAP 个字之后同时出现（标题截断，后面的看不到）。 */
const GLYPH_STAGGER_MS = 18;
const GLYPH_STAGGER_CAP = 32;
/** 单个字从模糊变清的时长（theme.css 的 glyph-in）。 */
const GLYPH_MS = 320;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/**
 * 标题换成生成的标题时逐字显出（照 monocode 的 particle text，简化为每个字从 4 px 模糊淡入、依次错开）。播完换回整段文字，
 * 不留一串 span 影响字距；系统开了减弱动态效果时直接显示。
 */
export function GlyphReveal({ text, at }: { text: string; at: number | undefined }) {
  const reduced = useReducedMotion();
  const glyphs =
    at === undefined ? [] : Array.from(segmenter.segment(text), (part) => part.segment);
  const total = Math.min(glyphs.length, GLYPH_STAGGER_CAP) * GLYPH_STAGGER_MS + GLYPH_MS;
  const [, rerender] = useState(0);
  useEffect(() => {
    if (at === undefined) return;
    const left = at + total - Date.now();
    if (left <= 0) return;
    const timer = setTimeout(() => rerender((n) => n + 1), left);
    return () => clearTimeout(timer);
  }, [at, total]);
  if (at === undefined || reduced || at + total <= Date.now()) return text;
  const elapsed = Date.now() - at;
  return glyphs.map((glyph, index) => (
    <span
      // 字会重复，位置才是身份；整串只在标题变了时换。
      // biome-ignore lint/suspicious/noArrayIndexKey: 见上
      key={index}
      className="glyph-in"
      style={{
        animationDelay: `${Math.min(index, GLYPH_STAGGER_CAP) * GLYPH_STAGGER_MS - elapsed}ms`,
      }}
    >
      {glyph}
    </span>
  ));
}
