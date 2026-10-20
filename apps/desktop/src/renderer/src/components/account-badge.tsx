import { cn } from 'cn';
import { accountMark } from '@/data/sources';

/**
 * 账号标签的角标（0.63.0）：像 iOS 双卡的“主”“副”，标签的第一个字放在一圈细细的、与文字同色的圆角边框里，没有底色。没有标签时
 * 不画。读屏读完整的标签。
 */
export function AccountBadge({
  label,
  size = 'md',
  className,
}: {
  label: string | undefined;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const mark = accountMark(label);
  if (mark === undefined) return null;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-account-badge={label}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-sm border border-current font-medium leading-none select-none',
        size === 'md' ? 'size-4 text-[0.625rem]' : 'size-3.5 text-[0.5625rem]',
        className,
      )}
    >
      {mark}
    </span>
  );
}
