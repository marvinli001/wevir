// 来源 https://github.com/kuratlielia/arc-library/blob/8302b52ed9dc79ae7ca699b158a98dfdf09656f7/registry/components/radio-group/radio-group.tsx
// 来源提交 8302b52ed9dc79ae7ca699b158a98dfdf09656f7 · MIT License · Copyright (c) 2026 Elia Kuratli

import { Radio as RadioPrimitive } from '@base-ui/react/radio';
import { RadioGroup as RadioGroupPrimitive } from '@base-ui/react/radio-group';
import { withClasses } from './classes';
import styles from './radio-group.module.css';

function RadioGroup({ className, ...props }: RadioGroupPrimitive.Props) {
  return <RadioGroupPrimitive data-slot="radio-group" className={className} {...props} />;
}

function Radio({ className, ...props }: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      data-slot="radio"
      className={withClasses(styles.radio, className)}
      {...props}
    >
      <RadioPrimitive.Indicator className={styles.dot} />
    </RadioPrimitive.Root>
  );
}

export { Radio, RadioGroup };
