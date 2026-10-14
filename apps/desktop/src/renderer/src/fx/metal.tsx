import {
  isMetalFxSupported,
  MetalBadge,
  MetalFx,
  MetalText,
  PRESETS,
  setSharedPresetMode,
} from 'metal-fx';
import { type ReactElement, useEffect, useState } from 'react';
import { useFxTheme, useReducedMotion } from './motion';

// metal-fx（Paper Shaders 的 liquidMetal，WebGL2，全页共用一个 GL 上下文与一个 rAF 循环）。静器用 gold。要注意的两点
// （方向稿踩过）：不要用 key 随主题重挂——初始化到一半被卸载后，新实例会一直 visibility:hidden，主题变了直接改 theme；
// 它会把子元素的背景清成透明，内圈底色是它自己的（浅色白、深色近黑，并把 color 设成对比色），子元素的文字与图标颜色
// 要继承它（不要自己设颜色）。库只在指针光效上管减弱动效：金属框在减弱动效时由这里暂停（留住当前帧的样子）；MetalText、
// MetalBadge 没有暂停的属性，减弱动效时换成不动的同款文字与徽标。
//
// 全页只有一个着色器、一套预设：MetalFx 每个实例都把共享预设设成自己的，MetalText 与 MetalBadge 写死了 chromatic，
// 同一页上有字标时发送按钮也会变成彩色。Wevir 只用 gold，所以每个封装都用 setSharedPresetMode 把共享预设钉在当前主题的
// gold 上（父组件的 effect 在 MetalFx 自己的之后执行，以它为准）。

/** 把全页的金属预设钉在 gold（见上）。只在真的渲染了 metal-fx 时调用：没有实例时调用会白建一个 GL 上下文。 */
function useGoldPreset(enabled: boolean): void {
  const theme = useFxTheme();
  useEffect(() => {
    if (enabled && isMetalFxSupported()) setSharedPresetMode(PRESETS.gold.modes[theme]);
  }, [enabled, theme]);
}

/**
 * 圆形的金属框（输入框的发送 / 停止按钮）。`children` 是单个按钮元素，尺寸由它自己定。`flowing` 为 false 时金属停在
 * 当前帧（静器的“静”，也省电：一个流动的金属框在 Electron 里要 GPU 进程约 11%、渲染进程约 7% 的 CPU），指针移上去时照样
 * 流动。
 */
export function MetalCircle({
  strength = 1,
  flowing = true,
  children,
}: {
  strength?: number;
  flowing?: boolean;
  children: ReactElement;
}) {
  const theme = useFxTheme();
  const reduced = useReducedMotion();
  const [hovered, setHovered] = useState(false);
  useGoldPreset(true);
  return (
    <MetalFx
      variant="circle"
      preset="gold"
      theme={theme}
      strength={strength}
      paused={reduced || !(flowing || hovered)}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      data-metal="circle"
    >
      {children}
    </MetalFx>
  );
}

/** 首页的金属字标（U4 用）：参数照方向稿的首页（Mona Sans 600 22px，浅色金棕、深色铂金，金属 0.6）。 */
export function MetalWordmark({ children, size = 22 }: { children: string; size?: number }) {
  const theme = useFxTheme();
  const reduced = useReducedMotion();
  useGoldPreset(!reduced);
  const font = `600 ${size}px/1.1 "Mona Sans", sans-serif`;
  const color = theme === 'dark' ? '#dfded8' : '#6f5a33';
  if (reduced) {
    return (
      <span data-metal="wordmark" style={{ font, color }}>
        {children}
      </span>
    );
  }
  return (
    <MetalText font={font} color={color} theme={theme} metalOpacity={0.6}>
      {children}
    </MetalText>
  );
}

/** “新”徽标（U4 用）：白底金属边的小药丸（库的默认尺寸 45 × 25）。 */
export function MetalNewBadge({ children }: { children: string }) {
  const theme = useFxTheme();
  const reduced = useReducedMotion();
  useGoldPreset(!reduced);
  if (reduced) {
    return (
      <span
        data-metal="badge"
        className="inline-flex h-[25px] min-w-[45px] items-center justify-center rounded-full border border-brand bg-[#ffffff] px-2 text-xs font-medium text-[#1d1d1d]"
      >
        {children}
      </span>
    );
  }
  return <MetalBadge theme={theme}>{children}</MetalBadge>;
}
