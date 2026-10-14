import { BorderBeam, type BorderBeamProps } from 'border-beam';
import type { ReactNode } from 'react';
import { useFxTheme, useReducedMotion } from './motion';

/**
 * 静器里光束的三种用法（方向稿 src/fx.jsx、src/session.jsx）：
 * - `composer`：回合进行中的输入框，底边一道单色光（line、mono、强度 0.8）；
 * - `focus`：首页输入框获得焦点时（U4 接），同 composer；
 * - `approval`：审批卡片，金色的内侧呼吸光（pulse-inner、gold；强度同方向稿，浅色 0.9、深色 1）。pulse 类的颜色默认绕色相环
 *   转一整圈（金色会转成青、紫），这里用 staticColors 定在金色。
 */
const PRESETS: Record<
  BeamPreset,
  Pick<BorderBeamProps, 'size' | 'colorVariant' | 'strength' | 'staticColors'>
> = {
  composer: { size: 'line', colorVariant: 'mono', strength: 0.8 },
  focus: { size: 'line', colorVariant: 'mono', strength: 0.8 },
  approval: { size: 'pulse-inner', colorVariant: 'gold', staticColors: true },
};

export type BeamPreset = 'composer' | 'focus' | 'approval';

/**
 * 给一个卡片加 border-beam（包一层 div，圆角取自第一个子元素）。`active` 为 false 时光束淡出。line 这类转动的光束
 * 库不管减弱动效，这里停下；pulse 的库自己停。
 */
export function Beam({
  preset,
  active = true,
  className,
  children,
}: {
  preset: BeamPreset;
  active?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const theme = useFxTheme();
  const reduced = useReducedMotion();
  const {
    size,
    colorVariant,
    staticColors,
    strength = theme === 'light' ? 0.9 : 1,
  } = PRESETS[preset];
  return (
    <BorderBeam
      size={size}
      colorVariant={colorVariant}
      theme={theme}
      strength={strength}
      staticColors={staticColors}
      active={active && !(reduced && size === 'line')}
      data-beam-preset={preset}
      className={className}
    >
      {children}
    </BorderBeam>
  );
}
