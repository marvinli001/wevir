import { BorderBeam, type BorderBeamProps } from 'border-beam';
import { type ReactNode, useEffect, useRef } from 'react';
import { useReducedGpuEffects } from '@/lib/gpu-effects';
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

/** 光束每秒画多少次。光束是一团柔光，30 帧与跟着屏幕刷新率（60 / 120 / 144）看不出差别。 */
const BEAM_FPS = 30;
/** 停用后库还要淡出 0.5 s，这段时间接着推进。 */
const BEAM_FADE_MS = 600;

/**
 * 光束的帧率上限。border-beam 用 CSS 动画改自定义属性（位置、宽度、呼吸），每一帧都要在主线程重算样式、重画三层渐变：按屏幕
 * 刷新率跑时，一条光束就占渲染进程两到三成的一个核心，回合进行中正好与流式输出抢主线程。这里把循环的那几条动画停住，改由定时器按
 * BEAM_FPS 推进它们的 currentTime；淡入淡出（只播一次）不动。库停下动画的情况（减弱动效、移出视口的 data-paused）照旧。
 */
function useBeamFrameCap(active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  // 淡出期间新旧两个定时器会并存，共用上一次推进的时刻，不会走成两倍速。
  const last = useRef(0);
  useEffect(() => {
    const root = ref.current;
    if (!active || root === null || typeof root.getAnimations !== 'function') return;
    last.current = performance.now();
    const tick = () => {
      const now = performance.now();
      const elapsed = now - last.current;
      last.current = now;
      if (document.visibilityState === 'hidden' || root.hasAttribute('data-paused')) return;
      // 先读完再写：改了一条动画的 currentTime 之后再读下一条的状态，会逼着浏览器当场重算一次样式。
      const looping: { animation: Animation; time: number; running: boolean }[] = [];
      for (const animation of root.getAnimations({ subtree: true })) {
        const name = (animation as Partial<CSSAnimation>).animationName;
        if (name === undefined || !name.startsWith('beam-')) continue;
        if (animation.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY) continue;
        looping.push({
          animation,
          time: Number(animation.currentTime) || 0,
          running: animation.playState !== 'paused',
        });
      }
      for (const { animation, time, running } of looping) {
        if (running) animation.pause();
        animation.currentTime = time + elapsed;
      }
    };
    const timer = window.setInterval(tick, 1000 / BEAM_FPS);
    return () => {
      window.setTimeout(() => window.clearInterval(timer), BEAM_FADE_MS);
    };
  }, [active]);
  return ref;
}

/**
 * 给一个卡片加 border-beam（包一层 div，圆角取自第一个子元素）。`active` 为 false 时光束淡出。line 这类转动的光束
 * 库不管减弱动效，这里停下；pulse 的库自己停。
 *
 * 光束的自定义属性是可继承的，动画挂在这层 div 上：里面的每个元素每一帧都跟着重算样式。所以内容多的卡片不要包进来，只包一块
 * 不带内容的底板，内容叠在上面（消息输入框的做法，session/composer.tsx）。
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
  const lowGpu = useReducedGpuEffects();
  const {
    size,
    colorVariant,
    staticColors,
    strength = theme === 'light' ? 0.9 : 1,
  } = PRESETS[preset];
  const on = active && !lowGpu && !(reduced && size === 'line');
  const ref = useBeamFrameCap(on);
  return (
    <BorderBeam
      ref={ref}
      size={size}
      colorVariant={colorVariant}
      theme={theme}
      strength={strength}
      staticColors={staticColors}
      active={on}
      data-beam-preset={preset}
      className={className}
    >
      {children}
    </BorderBeam>
  );
}
