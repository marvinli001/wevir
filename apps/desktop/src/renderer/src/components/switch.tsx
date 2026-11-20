// 来源 https://github.com/kuratlielia/arc-library/blob/8302b52ed9dc79ae7ca699b158a98dfdf09656f7/registry/components/switch/switch.tsx
// 来源提交 8302b52ed9dc79ae7ca699b158a98dfdf09656f7 · MIT License · Copyright (c) 2026 Elia Kuratli
import { Switch as SwitchPrimitive } from '@base-ui/react/switch';
import { cn } from 'cn';
import { motion } from 'motion/react';
import { useReducedMotion } from '@/fx/motion';
import { useReducedGpuEffects } from '@/lib/gpu-effects';
import { motionTokens } from '@/lib/motion-tokens';
import styles from './ui/switch.module.css';

export function Switch({
  checked,
  label,
  disabled,
  onChange,
  className,
  ...rest
}: {
  checked: boolean;
  label: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  className?: string;
  'data-action'?: string;
}) {
  const reduced = useReducedMotion();
  const lowGpu = useReducedGpuEffects();
  return (
    <SwitchPrimitive.Root
      {...rest}
      nativeButton
      render={<button type="button" />}
      data-slot="switch"
      aria-label={label}
      checked={checked}
      disabled={disabled ?? false}
      onCheckedChange={onChange}
      className={cn(styles.track, className)}
    >
      <SwitchPrimitive.Thumb
        className={styles.thumb}
        render={
          <motion.span
            initial={false}
            animate={{ x: checked ? 14 : 0 }}
            transition={
              reduced || lowGpu ? { duration: 0 } : { type: 'spring', ...motionTokens.spring.press }
            }
          />
        }
      />
    </SwitchPrimitive.Root>
  );
}
