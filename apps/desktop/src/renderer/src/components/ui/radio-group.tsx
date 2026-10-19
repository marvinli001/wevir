// 单选：Base UI 的 RadioGroup 与 Radio，代替原生 <input type="radio">（desktop-tokens.md §62）。圆钮外形同勾选框
// （checkbox.tsx）：表面色底、强分隔线的边框，选中是墨底，中间的圆点按 press 弹簧从无到有（dot-pop）；按下缩到 88%。
// RadioGroup 渲染一个 div，可以直接当网格或列表的容器。

import { Radio as RadioPrimitive } from '@base-ui/react/radio';
import { RadioGroup as RadioGroupPrimitive } from '@base-ui/react/radio-group';
import { cn } from 'cn';

function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
  return <RadioGroupPrimitive data-slot="radio-group" className={className} {...props} />;
}

function Radio({ className, ...props }: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      data-slot="radio"
      className={cn(
        'inline-flex size-4 shrink-0 items-center justify-center rounded-full border border-input bg-card outline-none pressable [--press-scale:0.88] hover:border-foreground/40 focus-visible:border-ring-soft focus-visible:ring-2 focus-visible:ring-ring/25 data-checked:border-primary data-checked:bg-primary data-disabled:pointer-events-none data-disabled:opacity-50',
        className,
      )}
      {...props}
    >
      <RadioPrimitive.Indicator className="size-1.5 rounded-full bg-primary-foreground dot-pop" />
    </RadioPrimitive.Root>
  );
}

export { Radio, RadioGroup };
