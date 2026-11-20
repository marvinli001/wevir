// 来源 https://github.com/kuratlielia/arc-library/blob/8302b52ed9dc79ae7ca699b158a98dfdf09656f7/registry/components/textarea/textarea.tsx
// 来源提交 8302b52ed9dc79ae7ca699b158a98dfdf09656f7 · MIT License · Copyright (c) 2026 Elia Kuratli
import { cn } from 'cn';
import type { ComponentProps } from 'react';
import field from './input.module.css';
import styles from './textarea.module.css';

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      {...props}
      data-slot="textarea"
      className={cn(field.input, styles.textarea, className)}
    />
  );
}
