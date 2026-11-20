// 来源 https://github.com/kuratlielia/arc-library/blob/8302b52ed9dc79ae7ca699b158a98dfdf09656f7/registry/components/tabs/tabs.tsx
// 来源提交 8302b52ed9dc79ae7ca699b158a98dfdf09656f7 · MIT License · Copyright (c) 2026 Elia Kuratli
import { Tabs as Primitive } from '@base-ui/react/tabs';
import { Toggle } from '@base-ui/react/toggle';
import { ToggleGroup } from '@base-ui/react/toggle-group';
import { cn } from 'cn';
import { type ComponentProps, type ReactNode, useRef } from 'react';
import { useSelectionIndicator } from '@/components/glide';
import { withClasses } from './classes';
import styles from './tabs.module.css';

export function TabList<T extends string | number>({
  value,
  onValueChange,
  children,
  className,
  ...props
}: ComponentProps<'div'> & { value: T | null | undefined; onValueChange: (value: T) => void }) {
  return (
    <Primitive.Root
      value={value ?? null}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next as T);
      }}
      className={styles.root}
    >
      <Primitive.List {...props} data-arc-tabs="" className={cn(styles.list, className)}>
        <Primitive.Indicator className={cn(styles.indicator, styles.tabIndicator)} />
        {children}
      </Primitive.List>
    </Primitive.Root>
  );
}

export function Tab({ className, ...props }: Primitive.Tab.Props) {
  return <Primitive.Tab {...props} className={withClasses(styles.tab, className)} />;
}

type SegmentGroupProps<T extends string> = Omit<
  ComponentProps<'div'>,
  'onChange' | 'defaultValue'
> & {
  value: T | undefined;
  disabled?: boolean | undefined;
  onChange: (value: T) => void;
};

function SegmentRoot<T extends string>({
  value,
  onChange,
  disabled,
  className,
  children,
  ...props
}: SegmentGroupProps<T>) {
  return (
    <ToggleGroup
      {...props}
      value={value === undefined ? [] : [value]}
      disabled={!!disabled}
      onValueChange={(next) => {
        if (next[0] !== undefined) onChange(next[0] as T);
      }}
      data-arc-tabs=""
      className={cn(styles.segmented, className)}
    >
      {children}
    </ToggleGroup>
  );
}

export function SegmentGroup<T extends string>({ children, ...props }: SegmentGroupProps<T>) {
  const root = useRef<HTMLDivElement>(null);
  const mark = useSelectionIndicator(root, props.value);
  return (
    <SegmentRoot {...props} ref={root}>
      <span
        aria-hidden
        ref={mark}
        className={cn('glide-mark', styles.indicator, styles.selection)}
      />
      {children}
    </SegmentRoot>
  );
}

export function Segment({ className, ...props }: Toggle.Props) {
  return (
    <Toggle {...props} data-indicator-target className={withClasses(styles.segment, className)} />
  );
}

export function Segmented<T extends string>({
  value,
  label,
  options,
  onChange,
  disabled,
  className,
  ...props
}: {
  label: string;
  value: T | undefined;
  options: readonly { value: T; label: ReactNode; icon?: ReactNode }[];
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
} & Record<`data-${string}`, string | boolean | undefined>) {
  const column = options.findIndex((option) => option.value === value);
  return (
    <SegmentRoot
      {...props}
      value={value}
      onChange={onChange}
      disabled={disabled}
      aria-label={label}
      className={className}
    >
      {column >= 0 && (
        <span
          aria-hidden
          className={cn(styles.indicator, styles.columnIndicator)}
          style={{ translate: `calc(${column} * var(--column-step)) 0` }}
        />
      )}
      {options.map((option) => (
        <Segment key={option.value} value={option.value} data-segment={option.value}>
          {option.icon}
          {option.label}
        </Segment>
      ))}
    </SegmentRoot>
  );
}
