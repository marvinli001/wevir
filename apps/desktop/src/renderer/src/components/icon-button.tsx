import type { ComponentProps, ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

type ButtonProps = ComponentProps<typeof Button>;

export interface IconButtonProps extends Omit<ButtonProps, 'children' | 'size' | 'aria-label'> {
  /** 无障碍名称，同时作为提示文字。只有图标的按钮必须有它。 */
  label: string;
  /** lucide 图标。 */
  children: ReactNode;
  size?: 'icon' | 'icon-xs' | 'icon-sm' | 'icon-lg';
  tooltipSide?: ComponentProps<typeof TooltipContent>['side'];
}

/** 只有图标的按钮：Button 的图标尺寸 + 悬停提示，aria-label 与提示文字是同一句。 */
export function IconButton({
  label,
  children,
  size = 'icon-sm',
  variant = 'ghost',
  tooltipSide,
  ...props
}: IconButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Button variant={variant} size={size} aria-label={label} {...props} />}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>{label}</TooltipContent>
    </Tooltip>
  );
}
