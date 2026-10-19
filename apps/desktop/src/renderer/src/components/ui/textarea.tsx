// 由 shadcn CLI 4.21.4 从官方 registry 生成（components.json：base-nova，Base UI，lucide）。
// MIT License，Copyright (c) 2023 shadcn。
// Wevir 的改动：同 input.tsx，底色是表面色 bg-card，禁用时 bg-muted，不按主题另算（U4）。

import { cn } from 'cn';
import type * as React from 'react';

function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        'flex field-sizing-content min-h-16 w-full rounded-lg border border-input bg-card px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring-soft focus-visible:ring-2 focus-visible:ring-ring/12 disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40',
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
