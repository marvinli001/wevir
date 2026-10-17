// 上下文卡片展开后的分布（0.50.0）：一条按类别分段的条，下面是各类别的 token 数与占比，再下面是 MCP 工具、记忆文件、自定义
// 智能体、技能这几组细项（点开看每一项）。数据在 context-breakdown-model.ts。

import type { UsageBreakdown } from '@wevir/protocol';
import { cn } from 'cn';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Collapse } from '@/components/collapse';
import { t } from '@/i18n';
import {
  type BreakdownGroup,
  type BreakdownRow,
  contextBreakdown,
  formatPercent,
} from './context-breakdown-model';
import { formatTokens } from './rail-model';

export function ContextBreakdown({ breakdown }: { breakdown: UsageBreakdown | undefined }) {
  const view = contextBreakdown(breakdown);
  if (!view) return null;
  return (
    <div className="mt-3 border-t border-border pt-3" data-testid="rail-context-breakdown">
      <div aria-hidden className="flex h-2 gap-px overflow-hidden rounded-full">
        {view.rows.map((row) => (
          <span
            key={row.label}
            className={cn('block h-full min-w-px', row.swatch)}
            style={{ width: `${row.percent}%` }}
          />
        ))}
      </div>
      <ul className="mt-2.5 space-y-0.5">
        {view.rows.map((row) => (
          <CategoryRow key={row.label} row={row} />
        ))}
      </ul>
      {view.deferred.length > 0 && (
        <ul
          className="mt-2 space-y-0.5 border-t border-border pt-2"
          data-testid="rail-context-deferred"
        >
          {view.deferred.map((row) => (
            <CategoryRow key={row.label} row={row} />
          ))}
        </ul>
      )}
      {view.groups.length > 0 && (
        <ul className="mt-2 space-y-0.5 border-t border-border pt-2">
          {view.groups.map((group) => (
            <GroupRow key={group.id} group={group} />
          ))}
        </ul>
      )}
    </div>
  );
}

function CategoryRow({ row }: { row: BreakdownRow }) {
  const deferred = row.kind === 'deferred';
  return (
    <li
      className={cn(
        'flex h-6 min-w-0 items-center gap-2 text-xs',
        (deferred || row.kind === 'free') && 'text-muted-foreground',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'size-2 shrink-0 rounded-xs',
          deferred ? 'border border-border-strong' : row.swatch,
          // 剩余空间的色块同条的底色，深色下与卡片几乎一样，描一道边。
          row.kind === 'free' && 'border border-border-strong',
        )}
      />
      <span className="min-w-0 flex-1 truncate">{row.label}</span>
      <span className="shrink-0 tabular-nums text-muted-foreground">
        {formatTokens(row.tokens)}
      </span>
      <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">
        {deferred ? '—' : formatPercent(row.percent)}
      </span>
    </li>
  );
}

/** 一组细项：收起时一行（名字与项数），点开列出占得最多的几项。 */
function GroupRow({ group }: { group: BreakdownGroup }) {
  const [open, setOpen] = useState(false);
  const panel = `rail-context-group-${group.id}`;
  const hidden = group.count - group.items.length;
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen((value) => !value)}
        className="-mx-1.5 flex h-6 w-[calc(100%+0.75rem)] min-w-0 items-center gap-1 rounded-md px-1.5 text-xs outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ease-smooth',
            open && 'rotate-90',
          )}
        />
        <span className="min-w-0 flex-1 truncate text-left">{group.label}</span>
        <span className="shrink-0 tabular-nums text-muted-foreground">{group.count}</span>
      </button>
      <Collapse open={open} id={panel}>
        <ul className="py-0.5 pl-4">
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
