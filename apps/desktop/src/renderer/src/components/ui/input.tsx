// 来源 https://github.com/kuratlielia/arc-library/blob/8302b52ed9dc79ae7ca699b158a98dfdf09656f7/registry/components/input/input.tsx
// 来源提交 8302b52ed9dc79ae7ca699b158a98dfdf09656f7 · MIT License · Copyright (c) 2026 Elia Kuratli
import { Input as InputPrimitive } from '@base-ui/react/input';
import { cn } from 'cn';
import type { ComponentProps } from 'react';
import { RollingNumber } from '@/components/rolling-number';
import styles from './input.module.css';

export function Input({
  className,
  rollingNumber,
  value,
  ...props
}: ComponentProps<'input'> & { rollingNumber?: boolean }) {
  const field = (
    <InputPrimitive
      {...props}
      value={value}
      data-slot="input"
      className={cn(styles.input, className)}
    />
  );
  if (!rollingNumber || value === undefined || value === '' || Array.isArray(value)) return field;
  return (
    <span className={styles.numberField}>
      {field}
      <span aria-hidden className={styles.number}>
        <RollingNumber value={String(value)} />
      </span>
    </span>
  );
}
