// 勾选框：Base UI 的 Checkbox，代替原生 <input type="checkbox">（desktop-tokens.md §62）。外形同输入框：表面色底、
// 强分隔线的边框，悬停时边框加深；勾上与半选是墨底，勾从左往右画出来（check-stroke，220 ms ease-fall），底色与边框
// 150 ms ease-smooth；按下缩到 88%，松开走 press 弹簧（pressable）。焦点环同按钮。放在 <label> 里时整行都能点。

import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox';
import { cn } from 'cn';

function Checkbox({
  className,
  size = 'default',
  ...props
}: CheckboxPrimitive.Root.Props & { size?: 'default' | 'sm' }) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'group/checkbox inline-flex shrink-0 items-center justify-center rounded-sm border border-input bg-card text-primary-foreground outline-none pressable [--press-scale:0.88] hover:border-foreground/40 focus-visible:border-ring-soft focus-visible:ring-2 focus-visible:ring-ring/25 aria-invalid:border-destructive data-checked:border-primary data-checked:bg-primary data-indeterminate:border-primary data-indeterminate:bg-primary data-disabled:pointer-events-none data-disabled:opacity-50',
        size === 'sm' ? 'size-3.5' : 'size-4',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="flex size-full items-center justify-center">
        <svg
          aria-hidden
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-full"
        >
          <path
            d="M4 8.4 6.7 11 12 5.2"
            pathLength={1}
            className="check-stroke group-data-indeterminate/checkbox:hidden"
          />
          <path
            d="M4.5 8h7"
            pathLength={1}
            className="check-stroke hidden group-data-indeterminate/checkbox:inline"
          />
        </svg>
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
