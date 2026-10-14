import type { OrbState } from 'thinking-orbs';
import { ThinkingOrb } from 'thinking-orbs';
import { useFxTheme } from './motion';

/** 静器的 orb 墨色（方向稿 src/fx.jsx）。画在 canvas 上，要字面颜色，不能用 CSS 变量。 */
const ORB_INK = { light: '#2b2a26', dark: '#e9e8e2' } as const;

/**
 * thinking orb（thinking-orbs，20px 那档）：消息流里进行中那一行、左栏运行中的会话。纯装饰，旁边有文字说明状态。
 * 库自己处理减弱动效（画静帧）、屏外与窗口隐藏时暂停。`paused` 冻结在当前帧（等待审批）。
 */
export function Orb({
  state,
  paused = false,
  className,
}: {
  state: OrbState;
  paused?: boolean;
  className?: string;
}) {
  const theme = useFxTheme();
  return (
    <ThinkingOrb
      state={state}
      size={20}
      theme={theme}
      color={ORB_INK[theme]}
      paused={paused}
      aria-hidden
      data-orb={state}
      className={className}
    />
  );
}
