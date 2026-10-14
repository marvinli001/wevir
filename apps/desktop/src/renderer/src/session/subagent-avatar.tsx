import { cn } from 'cn';
import type { ReactNode } from 'react';
import { type AvatarShape, avatarFor } from './avatar';

/** 每种形状在 16 × 16 里的画法：`main` 用主色，`soft` 用辅色（tokens.css 的 --avatar-N 与 --avatar-N-soft）。 */
const SHAPES: Record<AvatarShape, (main: string, soft: string) => ReactNode> = {
  ring: (main, soft) => (
    <>
      <circle cx="8" cy="8" r="6.5" fill={soft} />
      <circle cx="8" cy="8" r="3.5" fill={main} />
    </>
  ),
  diamond: (main, soft) => (
    <>
      <path d="M8 1.2 14.8 8 8 14.8 1.2 8Z" fill={main} />
      <path d="M8 5.2 10.8 8 8 10.8 5.2 8Z" fill={soft} />
    </>
  ),
  triad: (main, soft) => (
    <>
      <circle cx="8" cy="4.6" r="3.2" fill={main} />
      <circle cx="4.3" cy="11" r="3.2" fill={soft} />
      <circle cx="11.7" cy="11" r="3.2" fill={main} />
    </>
  ),
  hexagon: (main, soft) => (
    <>
      <path d="M8 1 14.1 4.5V11.5L8 15 1.9 11.5V4.5Z" fill={main} />
      <circle cx="8" cy="8" r="2.6" fill={soft} />
    </>
  ),
  halves: (main, soft) => (
    <>
      <path d="M8 1.5A6.5 6.5 0 0 0 8 14.5Z" fill={main} />
      <path d="M8 1.5A6.5 6.5 0 0 1 8 14.5Z" fill={soft} />
    </>
  ),
  bars: (main, soft) => (
    <>
      <rect x="1.5" y="5" width="3.6" height="9.5" rx="1.8" fill={main} />
      <rect x="6.2" y="1.5" width="3.6" height="13" rx="1.8" fill={soft} />
      <rect x="10.9" y="3.5" width="3.6" height="11" rx="1.8" fill={main} />
    </>
  ),
  badge: (main, soft) => (
    <>
      <rect x="1.5" y="3" width="11.5" height="11.5" rx="3.5" fill={main} />
      <circle cx="12" cy="4" r="3" fill={soft} />
    </>
  ),
  venn: (main, soft) => (
    <>
      <circle cx="5.8" cy="8" r="4.5" fill={soft} />
      <circle cx="10.2" cy="8" r="4.5" fill={main} fillOpacity="0.85" />
    </>
  ),
};

/**
 * 子会话的头像（R5）：由会话 ID 确定地选出颜色与形状（avatar.ts）。纯装饰，名字由旁边的文字给出。
 */
export function SubagentAvatar({
  sessionId,
  className,
}: {
  sessionId: string;
  /** 默认 16 px（size-4）。 */
  className?: string;
}) {
  const { color, shape } = avatarFor(sessionId);
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      data-avatar-shape={shape}
      data-avatar-color={color}
      className={cn('size-4 shrink-0', className)}
    >
      {SHAPES[shape](`var(--avatar-${color})`, `var(--avatar-${color}-soft)`)}
    </svg>
  );
}
