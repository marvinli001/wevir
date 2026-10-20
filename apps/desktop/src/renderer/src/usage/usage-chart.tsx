// 使用统计页的趋势图：手写的 SVG 柱状图（不引图表库）。Tokens 是四种 token 叠起来的柱（运行蓝两档 + 墨色两档，不用彩色），
// 请求与成本是单列的柱；纵轴刻度是紧凑写法，横轴按小时 `HH:mm`、按天 `MM/DD`；悬停一桶显示它的准确数值。

import type { UsageAggregate } from '@wevir/protocol';
import { cn } from 'cn';
import { useEffect, useRef, useState } from 'react';
import { type PlainMessageKey, t } from '@/i18n';
import { Segmented } from '@/settings/settings-ui';
import {
  bucketLabel,
  bucketTitle,
  CHART_METRICS,
  type ChartMetric,
  formatAxis,
  formatCost,
  formatCostAxis,
  formatInteger,
  labelStride,
  niceTicks,
  totalTokens,
} from './usage-model';
import type { SummaryData } from './use-usage';

type TokenKind = 'input' | 'output' | 'cacheWrite' | 'cacheRead';

/** 从下往上叠的顺序与颜色。 */
const TOKEN_SERIES: readonly {
  kind: TokenKind;
  label: PlainMessageKey;
  fill: string;
  swatch: string;
}[] = [
  { kind: 'input', label: 'usage.tokens.input', fill: 'fill-running', swatch: 'bg-running' },
  {
    kind: 'output',
    label: 'usage.tokens.output',
    fill: 'fill-running/45',
    swatch: 'bg-running/45',
  },
  {
    kind: 'cacheWrite',
    label: 'usage.tokens.cacheWrite',
    fill: 'fill-foreground/35',
    swatch: 'bg-foreground/35',
  },
  {
    kind: 'cacheRead',
    label: 'usage.tokens.cacheRead',
    fill: 'fill-foreground/15',
    swatch: 'bg-foreground/15',
  },
];

const METRIC_LABEL: Record<ChartMetric, PlainMessageKey> = {
  tokens: 'usage.chart.tokens',
  requests: 'usage.chart.requests',
  cost: 'usage.chart.cost',
};

const HEIGHT = 220;
const PAD_TOP = 8;
const PAD_BOTTOM = 24;
const PAD_LEFT = 52;
const PAD_RIGHT = 4;
const TOOLTIP_HALF = 96;

function metricValue(bucket: UsageAggregate, metric: ChartMetric): number {
  if (metric === 'tokens') return totalTokens(bucket.tokens);
  return metric === 'requests' ? bucket.requests : bucket.cost;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(Math.floor(entry.contentRect.width));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

export function UsageChart({
  data,
  metric,
  onMetric,
  locale,
}: {
  data: SummaryData;
  metric: ChartMetric;
  onMetric: (metric: ChartMetric) => void;
  locale: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hovered, setHovered] = useState<number>();
  const { buckets } = data.result;
  const { edges, range } = data;
  const count = buckets.length;
  const empty = data.result.totals.requests === 0;

  const max = Math.max(0, ...buckets.map((bucket) => metricValue(bucket, metric)));
  const ticks = niceTicks(max);
  const top = ticks.at(-1) ?? 1;
  const plotWidth = Math.max(0, width - PAD_LEFT - PAD_RIGHT);
  const plotHeight = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const slot = count === 0 ? 0 : plotWidth / count;
  const barWidth = Math.max(1, Math.min(slot * 0.68, 28));
  const stride = labelStride(count, plotWidth);
  const y = (value: number) => PAD_TOP + plotHeight - (value / top) * plotHeight;
  const axis = (value: number) =>
    metric === 'cost' ? formatCostAxis(value, locale) : formatAxis(value, locale);

  const hoveredBucket = hovered === undefined ? undefined : buckets[hovered];
  const tooltipLeft =
    hovered === undefined
      ? 0
      : Math.min(
          Math.max(PAD_LEFT + slot * (hovered + 0.5), TOOLTIP_HALF),
          Math.max(TOOLTIP_HALF, width - TOOLTIP_HALF),
        );

  return (
    <section className="rounded-xl border border-border bg-card p-4" data-testid="usage-chart">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <Segmented<ChartMetric>
          label={t('usage.chart')}
          value={metric}
          onChange={onMetric}
          options={CHART_METRICS.map((value) => ({ value, label: t(METRIC_LABEL[value]) }))}
        />
        {metric === 'tokens' && (
          <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {TOKEN_SERIES.map((series) => (
              <li key={series.kind} className="flex items-center gap-1.5">
                <span aria-hidden className={cn('size-2 rounded-xs', series.swatch)} />
                {t(series.label)}
              </li>
            ))}
          </ul>
        )}
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: 悬停只显示数值提示，数值在表格里也有。 */}
      <div
        ref={ref}
        className="relative"
        style={{ height: HEIGHT }}
        onMouseMove={(event) => {
          const x = event.clientX - event.currentTarget.getBoundingClientRect().left - PAD_LEFT;
          const index = slot > 0 ? Math.floor(x / slot) : -1;
          setHovered(index >= 0 && index < count ? index : undefined);
        }}
        onMouseLeave={() => setHovered(undefined)}
      >
        {empty ? (
          <p className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {t('usage.chart.empty')}
          </p>
        ) : (
          width > 0 && (
            <svg
              width={width}
              height={HEIGHT}
              role="img"
              aria-label={t(METRIC_LABEL[metric])}
              className="block overflow-visible"
            >
              {ticks.map((tick) => (
                <g key={tick}>
                  <line
                    x1={PAD_LEFT}
                    x2={width - PAD_RIGHT}
                    y1={y(tick)}
                    y2={y(tick)}
                    className={tick === 0 ? 'stroke-border-strong' : 'stroke-border'}
                    strokeDasharray={tick === 0 ? undefined : '2 3'}
                  />
                  <text
                    x={PAD_LEFT - 8}
                    y={y(tick)}
                    dy="0.32em"
                    textAnchor="end"
                    className="fill-muted-foreground text-[11px] tabular-nums"
                  >
                    {axis(tick)}
                  </text>
                </g>
              ))}
              {buckets.map((bucket, index) => {
                const x = PAD_LEFT + slot * index + (slot - barWidth) / 2;
                const start = edges[index] ?? 0;
                return (
                  // biome-ignore lint/suspicious/noArrayIndexKey: 桶按位置对应时间，没有别的标识。
                  <g key={index}>
                    {hovered === index && (
                      <rect
                        x={PAD_LEFT + slot * index}
                        y={PAD_TOP}
                        width={slot}
                        height={plotHeight}
                        className="fill-foreground/5"
                      />
                    )}
                    {metric === 'tokens' ? (
                      <TokenBar bucket={bucket} x={x} width={barWidth} y={y} />
                    ) : (
                      <rect
                        x={x}
                        y={y(metricValue(bucket, metric))}
                        width={barWidth}
                        height={Math.max(0, y(0) - y(metricValue(bucket, metric)))}
                        className="fill-running/80"
                      />
                    )}
                    {index % stride === 0 && (
                      <text
                        x={PAD_LEFT + slot * (index + 0.5)}
                        y={HEIGHT - 6}
                        textAnchor="middle"
                        className="fill-muted-foreground text-[11px] tabular-nums"
                      >
                        {bucketLabel(start, range, locale)}
                      </text>
                    )}
                  </g>
                );
              })}
            </svg>
          )
        )}
        {!empty && hoveredBucket !== undefined && hovered !== undefined && (
          <div
            className="pointer-events-none absolute top-2 z-10 w-48 -translate-x-1/2 rounded-lg bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md ring-1 ring-foreground/10"
            style={{ left: tooltipLeft }}
            data-testid="usage-chart-tooltip"
          >
            <p className="mb-1.5 font-medium">
              {bucketTitle(edges[hovered] ?? 0, edges[hovered + 1] ?? 0, range, locale)}
            </p>
            <BucketValues bucket={hoveredBucket} metric={metric} locale={locale} />
          </div>
        )}
      </div>
    </section>
  );
}

function TokenBar({
  bucket,
  x,
  width,
  y,
}: {
  bucket: UsageAggregate;
  x: number;
  width: number;
  y: (value: number) => number;
}) {
  let base = 0;
  return (
    <>
      {TOKEN_SERIES.map((series) => {
        const value = bucket.tokens[series.kind];
        const bottom = base;
        base += value;
        if (value === 0) return null;
        return (
          <rect
            key={series.kind}
            x={x}
            y={y(base)}
            width={width}
            height={Math.max(0, y(bottom) - y(base))}
            className={series.fill}
          />
        );
      })}
    </>
  );
}

function ValueRow({ label, value, swatch }: { label: string; value: string; swatch?: string }) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      {swatch !== undefined && (
        <span aria-hidden className={cn('size-2 shrink-0 rounded-xs', swatch)} />
      )}
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

function BucketValues({
  bucket,
  metric,
  locale,
}: {
  bucket: UsageAggregate;
  metric: ChartMetric;
  locale: string;
}) {
  if (metric === 'tokens') {
    return (
      <>
        {[...TOKEN_SERIES].reverse().map((series) => (
          <ValueRow
            key={series.kind}
            label={t(series.label)}
            value={formatInteger(bucket.tokens[series.kind], locale)}
            swatch={series.swatch}
          />
        ))}
        <div className="mt-1 border-t border-border pt-1">
          <ValueRow
            label={t('usage.tokens.total')}
            value={formatInteger(totalTokens(bucket.tokens), locale)}
          />
        </div>
      </>
    );
  }
  if (metric === 'requests') {
    return <ValueRow label={t('usage.requests')} value={formatInteger(bucket.requests, locale)} />;
  }
  return (
    <>
      <ValueRow label={t('usage.cost')} value={formatCost(bucket.cost, locale)} />
      {bucket.unpriced > 0 && (
        <p className="mt-1 text-muted-foreground">
          {t('usage.cost.unpriced', { count: bucket.unpriced })}
        </p>
      )}
    </>
  );
}
