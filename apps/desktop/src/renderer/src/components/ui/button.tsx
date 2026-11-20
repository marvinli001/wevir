// 来源 https://github.com/kuratlielia/arc-library/blob/8302b52ed9dc79ae7ca699b158a98dfdf09656f7/registry/components/button/button.tsx
// 来源提交 8302b52ed9dc79ae7ca699b158a98dfdf09656f7 · MIT License · Copyright (c) 2026 Elia Kuratli
import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cn } from 'cn';
import styles from './button.module.css';
import { withClasses } from './classes';

type Variant = 'default' | 'outline' | 'secondary' | 'ghost' | 'destructive' | 'link';
type Size = 'xs' | 'sm' | 'default' | 'lg' | 'icon' | 'icon-xs' | 'icon-sm' | 'icon-lg';
type Variants = { variant?: Variant | null | undefined; size?: Size | null | undefined };

export function buttonVariants({
  variant = 'default',
  size = 'default',
  className,
  class: extra,
}: Variants & { className?: string; class?: string } = {}) {
  return cn(
    'group/button',
    styles.button,
    styles[variant ?? 'default'],
    styles[`size-${size ?? 'default'}`],
    extra,
    className,
  );
}

export function Button({
  className,
  variant,
  size,
  loading,
  children,
  disabled,
  focusableWhenDisabled,
  ...props
}: ButtonPrimitive.Props & Variants & { loading?: boolean }) {
  return (
    <ButtonPrimitive
      {...props}
      data-slot="button"
      disabled={disabled || !!loading}
      focusableWhenDisabled={disabled ? focusableWhenDisabled : loading || focusableWhenDisabled}
      aria-busy={loading || props['aria-busy']}
      className={withClasses(buttonVariants({ variant, size }), className)}
    >
      {loading === undefined ? (
        children
      ) : (
        <>
          <span className={styles.label}>{children}</span>
          <span aria-hidden className={styles.loader}>
            <span className={styles.spinner} />
          </span>
        </>
      )}
    </ButtonPrimitive>
  );
}
