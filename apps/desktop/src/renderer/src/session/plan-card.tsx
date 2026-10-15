// 计划卡片（0.36.0，desktop-tokens §49）：改写自 T3 Code apps/web/src/components/chat/ProposedPlanCard.tsx（MIT，ec1313c）——
// 角标“计划”与标题、长计划折叠成前十行的预览、复制与下载 Markdown。T3 的“保存到工作区”没有搬：计划模式不写文件。

import type { ChatPartOf } from '@wevir/client-sdk';
import { cn } from 'cn';
import { Check, Copy, Download, ListChecks } from 'lucide-react';
import { memo, useEffect, useState } from 'react';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { MarkdownView } from './markdown/markdown-view';
import {
  collapsedPlanPreview,
  downloadPlan,
  planCollapsible,
  planFileContents,
  proposedPlanTitle,
  stripDisplayedPlanMarkdown,
} from './proposed-plan';

export const PlanCard = memo(function PlanCard({ part }: { part: ChatPartOf<'plan'> }) {
  const { text } = part;
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const title = proposedPlanTitle(text);
  const collapsible = planCollapsible(text);
  const collapsed = collapsible && !expanded;
  const body = collapsed ? collapsedPlanPreview(text) : stripDisplayedPlanMarkdown(text);
  return (
    <section
      aria-label={title ?? t('plan.badge')}
      data-testid="plan-card"
      data-plan={part.planId}
      className="my-3 rounded-2xl border border-border bg-card px-4 py-3"
    >
      <header className="flex min-w-0 items-center gap-2">
        <span className="flex shrink-0 items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
          <ListChecks aria-hidden className="size-3.5" />
          {t('plan.badge')}
        </span>
        {title && <h3 className="min-w-0 flex-1 truncate text-base font-semibold">{title}</h3>}
        <span className={cn('flex shrink-0 items-center gap-0.5', !title && 'ml-auto')}>
          <IconButton
            label={copied ? t('plan.copied') : t('plan.copy')}
            size="icon-xs"
            className="text-muted-foreground"
            data-action="copy-plan"
            onClick={() =>
              void window.wevir.copyText(planFileContents(text)).then(() => setCopied(true))
            }
          >
            {copied ? <Check /> : <Copy />}
          </IconButton>
          <IconButton
            label={t('plan.download')}
            size="icon-xs"
            className="text-muted-foreground"
            data-action="download-plan"
            onClick={() => downloadPlan(text)}
          >
            <Download />
          </IconButton>
        </span>
      </header>
      <div className={cn('relative mt-2', collapsed && 'max-h-96 overflow-hidden')}>
        {/* 计划里的小节标题不比卡片的标题大。 */}
        <MarkdownView text={body} streaming={false} className="[&_:is(h1,h2)]:text-base" />
        {collapsed && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-t from-card to-transparent"
          />
        )}
      </div>
      {collapsible && (
        <div className="mt-2 flex justify-center">
          <Button
            size="sm"
            variant="outline"
            data-action="toggle-plan"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? t('plan.collapse') : t('plan.expand')}
          </Button>
        </div>
      )}
    </section>
  );
});
