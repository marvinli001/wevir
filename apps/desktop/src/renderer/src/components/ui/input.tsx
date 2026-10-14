// 由 shadcn CLI 4.21.4 从官方 registry 生成（components.json：base-nova，Base UI，lucide）。
// MIT License，Copyright (c) 2023 shadcn。
// Wevir 的改动：U4 起底色在浅色、深色都是表面色 bg-card，禁用时是次表面色 bg-muted（方向稿 A 的控件），去掉
// dark:bg-input/30 这类按主题另算的底色。

import { Input as InputPrimitive } from '@base-ui/react/input';
import { cn } from 'cn';
import type * as React from 'react';

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        'h-8 w-full min-w-0 rounded-lg border border-input bg-card px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40',
        className,
      )}
      {...props}
    />
  );
}

export { Input };
