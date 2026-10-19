// 下拉选择（设置页与引导页的 <select> 换成它）：Base UI 的 Select，外形与 dropdown-menu.tsx 同一套——触发按钮照
// components/ui/input.tsx 的输入框（表面色、强分隔线的边框、运行色的焦点环），弹层 rounded-xl、选项 rounded-lg，
// 选中项右边打勾（照 Codex 桌面端的筛选下拉）。弹层落在按钮下方、与按钮同宽（至少 10rem），不像 macOS 原生那样盖住按钮。
// 弹层加 transition-none：duration-* 同时设置 transition-duration，打开时换主题会让弹层的颜色过渡 410 ms，Base UI 等它播完才
// 隐藏弹层，退场动画先播完，弹层又露出来闪一下。

import { Select as SelectPrimitive } from '@base-ui/react/select';
import { cn } from 'cn';
import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export interface SelectOption<Value extends string = string> {
  value: Value;
  label: ReactNode;
  /** 左边的图标。 */
  icon?: ReactNode;
}

export function Select<Value extends string>({
  id,
  value,
  options,
  onValueChange,
  disabled,
  className,
  popupClassName,
  'aria-label': ariaLabel,
  ...rest
}: {
  id?: string;
  value: Value;
  options: readonly SelectOption<Value>[];
  onValueChange: (value: Value) => void;
  disabled?: boolean;
  /** 触发按钮的额外样式（宽度、字体）。 */
  className?: string;
  popupClassName?: string;
  'aria-label'?: string;
} & Record<`data-${string}`, string | boolean | undefined>) {
  const selected = options.find((option) => option.value === value);
  return (
    <SelectPrimitive.Root
      {...(id !== undefined && { id })}
      value={value}
      items={options.map((option) => ({ value: option.value, label: option.label }))}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next as Value);
      }}
      disabled={disabled ?? false}
      modal={false}
    >
      <SelectPrimitive.Trigger
        data-slot="select-trigger"
        aria-label={ariaLabel}
        className={cn(
          'flex h-8 w-full min-w-0 items-center gap-2 rounded-lg border border-input bg-card px-2.5 text-left text-sm text-foreground outline-none transition-colors duration-150 select-none hover:bg-muted/60 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-disabled:pointer-events-none data-disabled:opacity-50 data-popup-open:bg-muted/60',
          className,
        )}
        {...rest}
      >
        {selected?.icon !== undefined && (
          <span className="flex shrink-0 text-muted-foreground [&_svg]:size-4">
            {selected.icon}
          </span>
        )}
        <SelectPrimitive.Value className="min-w-0 flex-1 truncate" />
        <SelectPrimitive.Icon className="flex shrink-0 text-muted-foreground">
          <ChevronDownIcon aria-hidden className="size-4" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner
          className="isolate z-50 outline-none"
          side="bottom"
          align="start"
          sideOffset={4}
          alignItemWithTrigger={false}
        >
          <SelectPrimitive.Popup
            data-slot="select-content"
            className={cn(
              'z-50 max-h-(--available-height) w-(--anchor-width) min-w-40 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-xl bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-open:slide-in-from-top-2 transition-none data-open:duration-(--spring-reveal-duration) data-open:ease-spring-reveal data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-closed:duration-110 data-closed:ease-smooth',
              popupClassName,
            )}
          >
            <SelectPrimitive.List>
              {options.map((option) => (
                <SelectPrimitive.Item
                  key={option.value}
                  value={option.value}
                  data-slot="select-item"
                  className="relative flex cursor-default items-center gap-2 rounded-lg py-1.5 pr-7 pl-2 text-sm outline-hidden select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0"
                >
                  {option.icon !== undefined && (
                    <span className="flex shrink-0 text-muted-foreground [&_svg]:size-4">
                      {option.icon}
                    </span>
                  )}
                  <SelectPrimitive.ItemText className="min-w-0 flex-1 truncate">
                    {option.label}
                  </SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator className="absolute right-2 flex items-center">
                    <CheckIcon aria-hidden className="size-4" />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              ))}
            </SelectPrimitive.List>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
