// 来源 https://github.com/kuratlielia/arc-library/blob/8302b52ed9dc79ae7ca699b158a98dfdf09656f7/registry/components/button/button.module.css
// 来源提交 8302b52ed9dc79ae7ca699b158a98dfdf09656f7 · MIT License · Copyright (c) 2026 Elia Kuratli

import { cn } from 'cn';
import { t } from '@/i18n';
import styles from './ui/spinner.module.css';

/**
 * 加载圈（照 Arc 按钮的 loading）：一圈 1.5 px 的当前文字色描边、右边一段透明，0.7 s 匀速转；出现时从 60% 放大淡入。
 * 尺寸与颜色由 `className` 给（默认 20 px、次要文字色）。
 */
export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <span role="status" data-spinner className={cn(styles.root, className)}>
      <span aria-hidden className={styles.circle} />
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
