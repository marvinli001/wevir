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
  type = 'text',
  ...props
}: ComponentProps<'input'> & { rollingNumber?: boolean }) {
  const numericField = rollingNumber && (type === 'number' || type === 'text');
  const showNumber =
    typeof value === 'number' || (typeof value === 'string' && /^[+-]?[\d.,]+$/.test(value));
  const field = (
    <InputPrimitive
      data-slot="input"
      {...props}
      type={type}
      value={value}
      className={cn(styles.input, !numericField && className)}
    />
  );
  if (!numericField) return field;
  return (
    <span
      className={cn(styles.numberField, className)}
      data-rolling-value={showNumber || undefined}
    >
      {field}
      {showNumber && (
        <span aria-hidden className={styles.number}>
          <RollingNumber value={String(value)} />
        </span>
      )}
    </span>
  );
}
