// 来源 https://github.com/kuratlielia/arc-library/blob/8302b52ed9dc79ae7ca699b158a98dfdf09656f7/registry/components/checkbox/checkbox.tsx
// 来源提交 8302b52ed9dc79ae7ca699b158a98dfdf09656f7 · MIT License · Copyright (c) 2026 Elia Kuratli

import { Checkbox as CheckboxPrimitive } from '@base-ui/react/checkbox';
import { cn } from 'cn';
import styles from './checkbox.module.css';
import { withClasses } from './classes';

function Checkbox({
  className,
  size = 'default',
  ...props
}: CheckboxPrimitive.Root.Props & { size?: 'default' | 'sm' }) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={withClasses(cn(styles.box, size === 'sm' && styles.small), className)}
      {...props}
    >
      <CheckboxPrimitive.Indicator className={styles.indicator}>
        <svg
          aria-hidden
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 8.4 6.7 11 12 5.2" pathLength={1} className={styles.check} />
          <path d="M4.5 8h7" pathLength={1} className={styles.dash} />
        </svg>
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export { Checkbox };
