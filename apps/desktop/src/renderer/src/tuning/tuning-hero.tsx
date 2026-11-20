// 调优页顶上的主卡（版式照设备页的远程访问卡）：左边标题与“自动调优”开关、状态一行、试用中的改动，下面一排范围、每月上限与撤销；
// 右边是一叠配置层的插画，试用中时最上面一层描品牌色。

import { cn } from 'cn';
import type { ReactNode } from 'react';
import { BrandMark } from '@/components/brand-mark';

export type HeroTone = 'trial' | 'stable' | 'idle';

export function TuningHero({
  title,
  control,
  status,
  tone,
  detail,
  children,
}: {
  title: string;
  /** 标题右边的开关。 */
  control?: ReactNode;
  status: string;
  tone: HeroTone;
  /** 状态下面的一段（试用中的改动）。 */
  detail?: ReactNode;
  /** 下面一排控件。 */
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby="tuning-hero-title"
      className="@container relative isolate mb-7 overflow-hidden rounded-xl border border-border bg-card"
      data-testid="tuning-hero"
    >
      <div className="relative z-10 flex min-h-44 flex-col items-start justify-center gap-4 p-5 @min-[26rem]:pr-36 @min-[32rem]:py-6 @min-[32rem]:pr-52 @min-[32rem]:pl-6">
        <div className="min-w-0 max-w-full">
          <div className="flex items-center gap-3">
            <h2 id="tuning-hero-title" className="text-lg font-semibold tracking-tight">
              {title}
            </h2>
            {control}
          </div>
          <p
            role="status"
            className="mt-1.5 flex min-w-0 items-center gap-2 text-sm text-muted-foreground"
            data-testid="tuning-trial-title"
          >
            <span
              aria-hidden
              className={cn(
                'size-1.5 shrink-0 rounded-full',
                tone === 'trial'
                  ? 'bg-brand'
                  : tone === 'stable'
                    ? 'bg-success'
                    : 'bg-muted-foreground',
              )}
            />
            <span className="truncate">{status}</span>
          </p>
          {detail}
        </div>
        <div className="flex flex-wrap items-center gap-2">{children}</div>
      </div>
      <LayerStack active={tone === 'trial'} />
    </section>
  );
}

/** 五层叠起来的等轴测薄板：最下面的最淡，最上面一层印着品牌标。 */
const SLABS = [
  { top: 'top-12', slab: 'border-foreground/12 bg-background' },
  { top: 'top-9', slab: 'border-foreground/16 bg-background' },
  { top: 'top-6', slab: 'border-foreground/20 bg-background' },
  { top: 'top-3', slab: 'border-foreground/25 bg-card' },
] as const;

function LayerStack({ active }: { active: boolean }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-y-0 right-0 hidden w-36 items-center justify-center @min-[26rem]:flex @min-[32rem]:w-52"
    >
      <div className="absolute inset-0 [background-image:radial-gradient(var(--border-strong)_0.8px,transparent_0.8px)] bg-size-[9px_9px] [mask-image:radial-gradient(ellipse_at_center,black_12%,transparent_72%)]" />
      <div className="relative h-28 w-32 shrink-0 scale-75 @min-[32rem]:scale-100">
        {SLABS.map(({ top, slab }) => (
          <div key={top} className={cn('absolute inset-x-0 flex justify-center', top)}>
            <div
              className={cn(
                'size-16 rounded-xl border shadow-xs [transform:rotateX(60deg)_rotateZ(-45deg)]',
                slab,
              )}
            />
          </div>
        ))}
        <div className="absolute inset-x-0 top-0 flex justify-center">
          <div
            className={cn(
              'flex size-16 items-center justify-center rounded-xl border bg-card shadow-sm [transform:rotateX(60deg)_rotateZ(-45deg)]',
              active ? 'border-brand/60' : 'border-foreground/35',
            )}
          >
            <span className="flex size-12 items-center justify-center rounded-lg bg-brand/8">
              <BrandMark className="size-6 rotate-45 text-brand" />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
