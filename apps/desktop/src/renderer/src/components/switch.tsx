import { cn } from 'cn';

/**
 * 开关（0.19.0 的 Provider 启用开关）：轨道关时是次表面色、开时是墨色，圆钮是滑块色（与分段切换同一套颜色，
 * desktop-tokens.md §32）。圆钮左右滑动走 press 弹簧，按住时往行进方向拉长 4 px（§62）。`role="switch"`，空格与回车切换。
 */
export function Switch({
  checked,
  label,
  disabled,
  onChange,
  className,
  ...rest
}: {
  checked: boolean;
  /** 读屏用的名称。 */
  label: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  className?: string;
  'data-action'?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'group/switch relative inline-flex h-4.5 w-8 shrink-0 items-center rounded-full outline-none transition-colors duration-150 focus-visible:focus-ring disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-muted ring-1 ring-border-strong ring-inset',
        className,
      )}
      {...rest}
    >
      <span
        aria-hidden
        className={cn(
          'absolute top-0.5 left-0.5 h-3.5 w-3.5 rounded-full bg-switch-thumb shadow-xs transition-[translate,width] duration-(--spring-press-duration) ease-spring-press group-enabled/switch:group-active/switch:w-4.5',
          checked && 'translate-x-3.5 group-enabled/switch:group-active/switch:translate-x-2.5',
        )}
      />
    </button>
  );
}
