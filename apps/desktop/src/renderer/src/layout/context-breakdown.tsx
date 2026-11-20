import { Button } from '@/components/ui/button';
// 上下文的明细（照 Claude 桌面端的 Context 卡片）：“已用 N%”与 token 数，一条按类别分段的条（引擎不报分布时是普通的用量条），
// 下面是各类别的 token 数与占比、按需载入的几行、MCP 工具等几组细项（点开看每一项），最后一行是离自动压缩还有多少与“压缩
// 上下文”按钮。会话侧栏的“上下文”卡片画全部；输入框底栏用量表的弹层（`compact`）省略刷新时间。数据在
// context-breakdown-model.ts。

import { cn } from 'cn';
import { ChevronRight } from 'lucide-react';
import { useId, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { Collapse } from '@/components/collapse';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { t } from '@/i18n';
import { paths } from '@/routes/paths';
import { formatRelativeTime } from '@/session/subagent-model';
import { useNow } from '@/session/use-now';
import { ContextBar } from './context-bar';
import {
  type BreakdownGroup,
  type BreakdownRow,
  contextBreakdown,
  formatPercent,
} from './context-breakdown-model';
import { type ContextUsage, formatTokens } from './rail-model';

export function ContextDetails({
  usage,
  compact = false,
  busy = false,
  onCompact,
}: {
  usage: ContextUsage;
  /** 省略刷新时间（输入框底栏用量表的弹层）。 */
  compact?: boolean;
  /** 回合进行中：“压缩上下文”不可点。 */
  busy?: boolean;
  onCompact?: () => void;
}) {
  const view = contextBreakdown(usage.breakdown, usage.used, usage.size);
  const size = formatTokens(usage.size);
  const untilAutoCompact =
    usage.autoCompactAt === undefined ? undefined : Math.max(0, usage.autoCompactAt - usage.used);
  return (
    <div data-testid="rail-context">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium">{t('rail.context.used', { percent: usage.percent })}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {formatTokens(usage.used)} /{' '}
          {usage.estimated && usage.breakdown?.precision !== 'estimate'
            ? t('rail.context.approx', { size })
            : size}
        </span>
      </div>
      {view ? (
        <div
          aria-hidden
          className="mt-2 flex h-1.5 gap-px overflow-hidden rounded-full"
          data-testid="rail-context-bar"
        >
          {view.rows.map((row) => (
            <span
              key={row.label}
              className={cn(
                'block h-full min-w-px transition-[width] duration-300 ease-smooth',
                row.swatch,
              )}
              style={{ width: `${row.percent}%` }}
            />
          ))}
        </div>
      ) : (
        <ContextBar usage={usage} className="mt-2" />
      )}
      {view && (
        <div data-testid="rail-context-breakdown">
          <ul className="mt-3">
            {view.rows.map((row) => (
              <CategoryRow
                key={row.name}
                row={row}
                estimated={
                  usage.breakdown?.precision === 'estimate' &&
                  (row.kind === 'used' || row.kind === 'deferred') &&
                  row.name !== 'Since last update'
                }
              />
            ))}
          </ul>
          {view.deferred.length > 0 && (
            <ul className="mt-3" data-testid="rail-context-deferred">
              {view.deferred.map((row) => (
                <CategoryRow
                  key={row.name}
                  row={row}
                  estimated={
                    usage.breakdown?.precision === 'estimate' &&
                    (row.kind === 'used' || row.kind === 'deferred') &&
                    row.name !== 'Since last update'
                  }
                />
              ))}
            </ul>
          )}
          {view.groups.length > 0 && (
            <ul className="mt-3">
              {view.groups.map((group) => (
                <GroupRow key={group.id} group={group} />
              ))}
            </ul>
          )}
        </div>
      )}
      {view && !compact && usage.breakdown?.measuredAt && (
        <MeasurementTime at={usage.breakdown.measuredAt} />
      )}
      {compact && usage.total !== undefined && (
        <div className="mt-2 flex justify-between gap-2 text-xs text-muted-foreground">
          <span>{t('rail.context.total')}</span>
          <span className="tabular-nums">{formatTokens(usage.total)}</span>
        </div>
      )}
      {(untilAutoCompact !== undefined || onCompact) && (
        <div className="mt-3 flex min-h-7 items-center gap-2">
          <span
            className="min-w-0 flex-1 truncate text-xs text-muted-foreground tabular-nums"
            data-testid="context-until-auto-compact"
          >
            {untilAutoCompact !== undefined &&
              t('rail.context.untilAutoCompact', { size: formatTokens(untilAutoCompact) })}
          </span>
          {onCompact && (
            <Button
              variant="outline"
              size="sm"
              type="button"
              disabled={busy}
              data-testid="context-compact"
              onClick={onCompact}
              className="text-xs"
            >
              {t('command.compact')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function MeasurementTime({ at }: { at: string }) {
  const now = useNow(60_000);
  return (
    <p className="mt-3 text-xs text-muted-foreground">
      <time dateTime={at}>{t('rail.context.updated', { time: formatRelativeTime(at, now) })}</time>
    </p>
  );
}

function CategoryRow({ row, estimated }: { row: BreakdownRow; estimated: boolean }) {
  const location = useLocation();
  const base = row.name.toLowerCase().replace(/ \(deferred\)$/, '');
  const destination: { to: string; label: string } | undefined =
    base === 'mcp tools' || base === 'mcp server instructions'
      ? { to: paths.plugins('connectors'), label: t('rail.context.manageConnectors') }
      : base === 'skills'
        ? { to: paths.plugins('skills'), label: t('rail.context.manageSkills') }
        : base === 'memory files'
          ? { to: paths.settings('memory'), label: t('rail.context.editMemory') }
          : undefined;
  const hint = [destination?.label, estimated ? t('rail.context.estimate') : undefined]
    .filter(Boolean)
    .join(' · ');
  const deferred = row.kind === 'deferred';
  const item = (
    <li
      className={cn(
        'flex h-6 min-w-0 items-center gap-2.5 text-xs',
        deferred && 'text-muted-foreground',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'size-2.5 shrink-0 rounded-xs',
          // 按需载入的不在窗口里，色块只描边；剩余空间的色块同条的底色，深色下与卡片几乎一样，也描一道边。
          deferred ? 'border border-border-strong' : row.swatch,
          row.kind === 'free' && 'border border-border-strong',
        )}
      />
      <span className="min-w-0 flex-1 truncate">
        {destination ? (
          <Link
            className="underline decoration-dotted decoration-muted-foreground underline-offset-2"
            to={destination.to}
            state={{ from: location }}
          >
            {row.label}
          </Link>
        ) : (
          row.label
        )}
      </span>
      <span className="shrink-0 tabular-nums text-muted-foreground">
        {formatTokens(row.tokens)}
      </span>
      <span className="w-11 shrink-0 text-right tabular-nums text-muted-foreground">
        {deferred ? '—' : formatPercent(row.percent)}
      </span>
    </li>
  );
  return hint ? (
    <Tooltip>
      <TooltipTrigger render={item} />
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  ) : (
    item
  );
}

/** 一组细项：收起时一行（名字与项数），点开列出占得最多的几项。 */
function GroupRow({ group }: { group: BreakdownGroup }) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const hidden = group.count - group.items.length;
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen((value) => !value)}
        className="-mx-1.5 flex h-6 w-[calc(100%+0.75rem)] min-w-0 items-center gap-1.5 rounded-md px-1.5 text-xs outline-none transition-colors hover:bg-muted focus-visible:focus-ring"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            'size-3 shrink-0 text-muted-foreground transition-transform duration-200 ease-expand',
            open && 'rotate-90',
          )}
        />
        <span className="min-w-0 flex-1 truncate text-left">{group.label}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{group.count}</span>
      </button>
      <Collapse open={open} id={panel}>
        <ul className="py-0.5 pl-4.5">
          {group.items.map((item) => (
            <li
              key={`${item.source ?? ''}\u0000${item.name}`}
              className="flex h-6 min-w-0 items-center gap-2 text-xs"
              title={item.source === undefined ? item.name : `${item.source} · ${item.name}`}
            >
              <span dir="rtl" className="min-w-0 flex-1 truncate text-left font-mono">
                <bdi dir="ltr">{item.name}</bdi>
              </span>
              {item.source !== undefined && (
                <span className="max-w-[40%] shrink-0 truncate text-muted-foreground">
                  {item.source}
                </span>
              )}
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {formatTokens(item.tokens)}
              </span>
            </li>
          ))}
          {hidden > 0 && (
            <li className="flex h-6 items-center text-xs text-muted-foreground">
              {t('rail.context.more', { count: hidden })}
            </li>
          )}
        </ul>
      </Collapse>
    </li>
  );
}
