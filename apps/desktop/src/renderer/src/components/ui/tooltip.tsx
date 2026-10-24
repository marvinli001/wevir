// 由 shadcn CLI 4.21.4 从官方 registry 生成（components.json：base-nova，Base UI，lucide）。
// MIT License，Copyright (c) 2023 shadcn。
// Wevir 的改动：U1 起箭头的 rounded-[2px] 改为圆角阶梯的 rounded-xs（同为 2px）；U10 起出现与消失 150 ms、ease-smooth；
// 交互手感一轮起入场用 reveal 弹簧（theme.css 的 --spring-reveal），退场 110 ms ease-smooth，不回弹。
// 弹层加 transition-none：duration-* 同时设置 transition-duration，打开时换主题会让弹层的颜色过渡 410 ms，Base UI 等它播完才
// 隐藏弹层，退场动画先播完，弹层又露出来闪一下。
// 发芽一轮（desktop-tokens.md §71）起弹层从触发点长出来：沿 Base UI 的 --transform-origin 从 90%（原来 95%）放大，同时从 4 px 的
// 模糊变清（tw-animate 的 blur-in-xs），入场仍是 reveal 弹簧；退场缩回 90% 并糊回 4 px（blur-out-xs），110 ms。

import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip';
import { cn } from 'cn';

function TooltipProvider({ delay = 0, ...props }: TooltipPrimitive.Provider.Props) {
  return <TooltipPrimitive.Provider data-slot="tooltip-provider" delay={delay} {...props} />;
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  side = 'top',
  sideOffset = 4,
  align = 'center',
  alignOffset = 0,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<TooltipPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset'>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            'z-50 inline-flex w-fit max-w-xs origin-(--transform-origin) items-center transition-none data-open:duration-(--spring-reveal-duration) data-open:ease-spring-reveal data-closed:duration-110 data-closed:ease-smooth gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-xs text-background has-data-[slot=kbd]:pr-1.5 data-[side=bottom]:slide-in-from-top-2 data-[side=inline-end]:slide-in-from-left-2 data-[side=inline-start]:slide-in-from-right-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-90 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-90 blur-in-xs data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-90 blur-out-xs',
            className,
          )}
          {...props}
        >
          {children}
          <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%-2px)] rotate-45 rounded-xs bg-foreground fill-foreground data-[side=bottom]:top-1 data-[side=inline-end]:top-1/2! data-[side=inline-end]:-left-1 data-[side=inline-end]:-translate-y-1/2 data-[side=inline-start]:top-1/2! data-[side=inline-start]:-right-1 data-[side=inline-start]:-translate-y-1/2 data-[side=left]:top-1/2! data-[side=left]:-right-1 data-[side=left]:-translate-y-1/2 data-[side=right]:top-1/2! data-[side=right]:-left-1 data-[side=right]:-translate-y-1/2 data-[side=top]:-bottom-2.5" />
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
