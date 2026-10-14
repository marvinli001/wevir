import type { SubagentSummary } from '@wevir/protocol';
import { ArrowLeft, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { IconButton } from '@/components/icon-button';
import { useTranscript } from '@/data/workbench-data';
import { useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { ApprovalDock } from './approval-card';
import { SubagentAvatar } from './subagent-avatar';
import { elapsedText, modelLine, statusLabel, subagentTitle } from './subagent-model';
import { TranscriptView } from './transcript-view';

/** 每隔 `intervalMs` 刷新一次的“现在”；不给间隔时不刷新。 */
export function useNow(intervalMs: number | undefined): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (intervalMs === undefined) return;
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * 子 agent 视图（R5，截图 04、06）：顶部返回箭头、头像、标题、“模型 · 推理强度”，下面是用时与它自己的消息流（逐字
 * 流式、工具卡片、审批与父会话相同）。只读，没有输入框：子会话由父 agent 驱动（domain-model §3.3.1）。它的审批在这里
 * 也能处理，父会话的输入框上方同样有。
 */
export function SubagentView({
  summary,
  onBack,
}: {
  /** 父会话快照里这个子会话的摘要（标题、模型、状态、起止时间）。 */
  summary: SubagentSummary;
  onBack: () => void;
}) {
  const { client, identity } = useHostConnection();
  const state = useTranscript(summary.sessionId);
  const running = summary.status === 'running';
  const now = useNow(running ? 1000 : undefined);
  const transcript = state?.transcript;
  const title = subagentTitle(summary);

  return (
    <div className="flex h-full min-h-0 flex-col" data-subagent-view={summary.sessionId}>
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border pr-3 pl-1.5">
        <IconButton label={t('subagent.detail.back')} onClick={onBack} tooltipSide="bottom">
          <ArrowLeft />
        </IconButton>
        <SubagentAvatar sessionId={summary.sessionId} className="size-5" />
        <h3 className="min-w-0 flex-1 truncate text-sm font-medium" title={title}>
          {title}
        </h3>
        <span className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">
          {modelLine(summary)}
        </span>
      </header>
      <div className="mx-auto w-full max-w-content shrink-0 px-6 pt-4">
        <p className="flex items-center gap-2 border-b border-border pb-2 text-sm text-muted-foreground">
          <span>{elapsedText(summary, now)}</span>
          {summary.status !== 'running' && summary.status !== 'completed' && (
            <span className={summary.status === 'failed' ? 'text-destructive' : undefined}>
              · {statusLabel(summary.status)}
            </span>
          )}
        </p>
      </div>
      {state?.error ? (
        <div className="min-h-0 flex-1">
          <EmptyState
            icon={<TriangleAlert />}
            title={t('subagent.detail.failed', { error: state.error })}
          />
        </div>
      ) : transcript && (state.caughtUp || transcript.lastSeq > 0) ? (
        <TranscriptView sessionId={summary.sessionId} transcript={transcript} self={identity} />
      ) : (
        <p className="min-h-0 flex-1 py-16 text-center text-sm text-muted-foreground">
          {t('subagent.detail.loading')}
        </p>
      )}
      <div className="mx-auto w-full max-w-content shrink-0 px-6 pb-4">
        {transcript && <ApprovalDock transcript={transcript} client={client} self={identity} />}
        <p className="pt-1 text-center text-xs text-muted-foreground">
          {t('subagent.detail.readOnly')}
        </p>
      </div>
    </div>
  );
}
