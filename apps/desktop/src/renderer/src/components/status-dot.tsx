import { cn } from 'cn';

export type StatusTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

/** accent 是进行中（运行中、登录中、未读），用运行色；neutral 是空闲，用强分隔线（方向稿 A 的空闲圆点）。 */
const TONES: Record<StatusTone, string> = {
  neutral: 'bg-border-strong',
  accent: 'bg-running',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-destructive',
};

export interface StatusDotProps {
  tone: StatusTone;
  /** 读屏读出的状态；省略时圆点只是装饰（旁边已有文字说明）。 */
  label?: string;
  /** 进行中的状态（运行中、重连中）缓慢闪烁；系统开了减少动效时不闪。 */
  pulse?: boolean;
  className?: string;
}

/** 状态圆点：会话行的运行中 / 待审批 / 出错，Host 连接状态等。颜色只取语义状态色。 */
export function StatusDot({ tone, label, pulse = false, className }: StatusDotProps) {
  const classes = cn(
    'inline-block size-2 shrink-0 rounded-full',
    TONES[tone],
    pulse && 'animate-pulse',
    className,
  );
  return label ? (
    <span
      data-slot="status-dot"
      data-tone={tone}
      role="img"
      aria-label={label}
      className={classes}
    />
  ) : (
    <span data-slot="status-dot" data-tone={tone} aria-hidden className={classes} />
  );
}
