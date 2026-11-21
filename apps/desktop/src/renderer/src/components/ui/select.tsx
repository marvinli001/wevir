// 来源 https://github.com/kuratlielia/arc-library/blob/8302b52ed9dc79ae7ca699b158a98dfdf09656f7/registry/components/select/select.tsx
// 来源提交 8302b52ed9dc79ae7ca699b158a98dfdf09656f7 · MIT License · Copyright (c) 2026 Elia Kuratli

import { Select as SelectPrimitive } from '@base-ui/react/select';
import { cn } from 'cn';
import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import menu from './dropdown-menu.module.css';
import { MenuHighlight } from './menu-highlight';
import styles from './select.module.css';

export interface SelectOption<Value extends string = string> {
  value: Value;
  label: ReactNode;
  /** 左边的图标。 */
  icon?: ReactNode;
  description?: ReactNode;
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
        className={cn(styles.trigger, className)}
        {...rest}
      >
        {selected?.icon !== undefined && <span className={styles.icon}>{selected.icon}</span>}
        <SelectPrimitive.Value className={styles.value} />
        <SelectPrimitive.Icon className={styles.chevron}>
          <ChevronDownIcon aria-hidden className="size-4" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner
          className={menu.positioner}
          side="bottom"
          align="start"
          sideOffset={4}
          alignItemWithTrigger={false}
        >
          <SelectPrimitive.Popup
            data-slot="select-content"
            className={cn(menu.popup, styles.popup, popupClassName)}
          >
            <SelectPrimitive.List className={menu.list}>
              <MenuHighlight />
              {options.map((option) => (
                <SelectPrimitive.Item
                  key={option.value}
                  value={option.value}
                  data-slot="select-item"
                  className={cn(menu.item, menu.choice)}
                >
                  {option.icon !== undefined && <span className={styles.icon}>{option.icon}</span>}
                  <span className={styles.copy}>
                    <SelectPrimitive.ItemText className={styles.value}>
                      {option.label}
                    </SelectPrimitive.ItemText>
                    {option.description && (
                      <span className={styles.description}>{option.description}</span>
                    )}
                  </span>
                  <SelectPrimitive.ItemIndicator className={menu.indicator}>
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
