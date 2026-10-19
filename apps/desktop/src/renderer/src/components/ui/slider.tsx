// 滑块：Base UI 的 Slider，代替原生 <input type="range">（desktop-tokens.md §62）。轨道 4 px、次表面色加一圈淡的强分隔线，
// 已选的一段是墨色；圆钮同开关的滑块（滑块色、一档阴影、强分隔线描边），悬停放大到 110%、拖动中 115%，缩放走 press
// 弹簧。圆钮按边对齐（thumbAlignment="edge"），到两头不超出轨道。

import { Slider as SliderPrimitive } from '@base-ui/react/slider';
import { cn } from 'cn';

function Slider({
  value,
  onValueChange,
  className,
  'aria-label': ariaLabel,
  ...props
}: Omit<SliderPrimitive.Root.Props, 'value' | 'onValueChange' | 'defaultValue'> & {
  value: number;
  onValueChange: (value: number) => void;
  'aria-label': string;
}) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      value={value}
      onValueChange={(next) => onValueChange(Array.isArray(next) ? (next[0] ?? value) : next)}
      thumbAlignment="edge"
      className={cn('w-40', className)}
      {...props}
    >
      <SliderPrimitive.Control className="flex h-5 w-full touch-none items-center select-none data-disabled:opacity-50">
        <SliderPrimitive.Track className="h-1 w-full rounded-full bg-muted ring-1 ring-border-strong/60 ring-inset select-none">
          <SliderPrimitive.Indicator className="rounded-full bg-primary select-none" />
          <SliderPrimitive.Thumb
            aria-label={ariaLabel}
            className="size-4 rounded-full bg-switch-thumb shadow-xs ring-1 ring-border-strong transition-[scale,box-shadow] duration-(--spring-press-duration) ease-spring-press select-none hover:scale-110 has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-ring/50 data-dragging:scale-115"
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
