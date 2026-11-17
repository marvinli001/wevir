// 接力详情（只读）：时间线里“已切换到 …”那一行打开。内容全部来自 `session.handoff` 与之后的回合（client-sdk 的投影）。

import { cn } from 'cn';
import { useRef } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useAccounts, useWorkbenchProviders } from '@/data/workbench-data';
import { currentLocale, t } from '@/i18n';
import { ContextReceipt } from './context-receipt';
import { CopyButton } from './copy-button';
import { formatMessageTime } from './format';
import {
  type ConfigurationNoticeOf,
  type HandoffNoticeOf,
  handoffDetailRows,
} from './handoff-model';
import { effortLabel } from './model-picker';

const TONE = {
  success: 'text-success',
  warning: 'text-warning',
  muted: 'text-muted-foreground',
} as const;

export function HandoffDetailDialog({
  notice,
  target,
  from,
  open,
  onOpenChange,
}: {
  notice: HandoffNoticeOf | ConfigurationNoticeOf;
  /** “来源 · 模型”。 */
  target: string;
  from: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // 打开时聚焦可滚动的正文，而不是复制按钮（否则一打开就弹出它的提示）。
  const contextRef = useRef<HTMLPreElement>(null);
  const providers = useWorkbenchProviders();
  const accounts = useAccounts();
  const context = notice.kind === 'handoff' ? notice.context : undefined;
  const rows = [
    { key: 'target', label: t('handoff.detail.target'), value: target },
    { key: 'from', label: t('handoff.detail.from'), value: from },
    ...(notice.kind === 'configured'
      ? [
          {
            key: 'effort',
            label: t('model.effort.label'),
            value: effortLabel(notice.to.reasoningEffort),
          },
          {
            key: 'speed',
            label: t('handoff.detail.speed'),
            value: t(notice.to.fast ? 'model.fast.label' : 'model.speed.standard'),
          },
        ]
      : []),
    ...(notice.at
      ? [
          {
            key: 'at',
            label: t('handoff.detail.at'),
            value: formatMessageTime(notice.at, currentLocale()),
          },
        ]
      : []),
    ...handoffDetailRows(notice, providers, accounts),
  ];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="gap-3 sm:max-w-xl"
        data-testid="handoff-detail"
        {...(context !== undefined && { initialFocus: contextRef })}
      >
        <DialogHeader>
          <DialogTitle>{t('handoff.detail.title')}</DialogTitle>
        </DialogHeader>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
          {rows.map((row) => (
            <div key={row.key} className="contents" data-handoff-row={row.key}>
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd
                className={cn(
                  'min-w-0 break-words',
                  'tone' in row && row.tone !== undefined && TONE[row.tone],
                )}
              >
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
        {notice.contextPack && <ContextReceipt receipt={notice.contextPack} inline />}
        {context !== undefined && (
          <div className="grid gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{t('handoff.detail.context')}</span>
              <CopyButton text={context} />
            </div>
            <pre
              ref={contextRef}
              // biome-ignore lint/a11y/noNoninteractiveTabindex: 可滚动的正文要能用键盘滚动。
              tabIndex={0}
              className="max-h-[min(50vh,24rem)] overflow-auto rounded-lg border border-border bg-muted/40 px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap outline-none focus-visible:focus-field"
              data-testid="handoff-context"
            >
              {context}
            </pre>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
