// 会话行的置顶与归档图标（照 Codex 桌面端左栏悬停时的两枚细线图标）：16 格、1.25 描边、圆头圆角，比 lucide 的 2 描边在
// 14 px 下更轻。置顶是斜 45° 的图钉，已置顶时钉身填实（不另画斜杠）；归档是带盖的盒子与一道把手。

import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function Icon({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      {...props}
    >
      {children}
    </svg>
  );
}

/** 图钉；`filled` 时钉身填实，表示已置顶。 */
export function PinIcon({ filled = false, ...props }: IconProps & { filled?: boolean }) {
  return (
    <Icon {...props}>
      <g transform="rotate(45 8 8)">
        <path
          d="M6.25 1.5h3.5M6.75 1.5v4.1L4.5 8.85h7L9.25 5.6V1.5"
          fill={filled ? 'currentColor' : 'none'}
        />
        <path d="M8 8.85v5.65" />
      </g>
    </Icon>
  );
}

export function ArchiveIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="2.5" y="3" width="11" height="3" rx="1" />
      <path d="M3.5 6v5.75a1.5 1.5 0 0 0 1.5 1.5h6a1.5 1.5 0 0 0 1.5-1.5V6" />
      <path d="M6.5 8.75h3" />
    </Icon>
  );
}
