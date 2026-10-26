// SPDX-License-Identifier: MIT
// 改写自 kuratlielia/arc-library registry/components/button/button.tsx 与 button.module.css 的加载圈（loader / spinner）
// 来源提交 fff39c044c6e3b86006e3a6acc9a32a821a80d99
// Copyright (c) 2026 Elia Kuratli
// 由 Wevir 修改：拆成独立的加载圈，不用 motion 与 CSS modules；出现时的放大淡入用 tw-animate 与 theme.css 的弹簧令牌，
// 减弱动效由 index.css 末尾的全局规则停下；带一段只给读屏的“正在加载”。

import { cn } from 'cn';
import { t } from '@/i18n';

/**
 * 加载圈（照 Arc 按钮的 loading）：一圈 1.5 px 的当前文字色描边、右边一段透明，0.7 s 匀速转；出现时从 60% 放大淡入。
 * 尺寸与颜色由 `className` 给（默认 20 px、次要文字色）。
 */
export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <span
      role="status"
      data-spinner
      className={cn(
        'inline-flex size-5 shrink-0 text-muted-foreground animate-in fade-in-0 zoom-in-60 duration-(--spring-reveal-duration) ease-spring-reveal fill-mode-both',
        className,
      )}
    >
      <span
        aria-hidden
        className="size-full animate-[spin_0.7s_linear_infinite] rounded-full border-[1.5px] border-current border-r-transparent"
      />
      <span className="sr-only">{label ?? t('common.loading')}</span>
    </span>
  );
}

/** 整页（中栏、设置页、窗格）还没读到数据时：加载圈居中，上下留白。 */
export function PageSpinner({ className }: { className?: string }) {
  return (
    <div className={cn('flex justify-center py-16', className)}>
      <Spinner />
    </div>
  );
}
