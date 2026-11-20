// 来源 https://github.com/kuratlielia/arc-library/blob/8302b52ed9dc79ae7ca699b158a98dfdf09656f7/registry/components/slider/slider.tsx
// 来源提交 8302b52ed9dc79ae7ca699b158a98dfdf09656f7 · MIT License · Copyright (c) 2026 Elia Kuratli

import { Slider as SliderPrimitive } from '@base-ui/react/slider';
import { withClasses } from './classes';
import styles from './slider.module.css';

function Slider({
  value,
  onValueChange,
  className,
  'aria-label': ariaLabel,
  ...props
}: Omit<SliderPrimitive.Root.Props, 'value' | 'onValueChange' | 'defaultValue'> & {
  value: number;
  onValueChange: (value: number) => void;
  'aria-label': string;
}) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      value={value}
      onValueChange={(next) => onValueChange(Array.isArray(next) ? (next[0] ?? value) : next)}
      thumbAlignment="edge"
      className={withClasses(styles.root, className)}
      {...props}
    >
      <SliderPrimitive.Control className={styles.control}>
        <SliderPrimitive.Track className={styles.track}>
          <SliderPrimitive.Indicator className={styles.fill} />
          <SliderPrimitive.Thumb aria-label={ariaLabel} className={styles.thumb} />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  );
}

export { Slider };
