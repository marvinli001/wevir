import type { ChatPart } from '@wevir/client-sdk';
import type { SessionId, SubagentSummary } from '@wevir/protocol';
import { cn } from 'cn';
import { Activity, ChevronRight, Square } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { Collapse } from '@/components/collapse';
import { IconButton } from '@/components/icon-button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useChildTokens, useSubagentStop } from '@/data/subagent-control';
import { useTranscript } from '@/data/workbench-data';
import { t } from '@/i18n';
import { paths } from '@/routes/paths';
import { formatDuration } from '@/session/format';
import { PartsView } from '@/session/message-view';
import { SubagentAvatar } from '@/session/subagent-avatar';
import { groupSubagents, statusLabel, subagentTitle } from '@/session/subagent-model';
import { useNow } from '@/session/subagent-view';
import { WorkspaceRoot } from '@/session/work-group';
import type { PaneContext } from '../pane-registry';
import { formatTokens } from '../rail-model';

const NO_SUBAGENTS: readonly SubagentSummary[] = [];

/**
 * “后台任务”窗格（U21，desktop-layout.md §15；截图 08–09）：当前会话的子会话，按“进行中”“已完成”分组；每项标题、模型、
 * token、用时与停止按钮，点标题展开它最近一个回合的过程。
 */
export function TasksPane({ context }: { context: PaneContext }) {
  const { entry, sessionId } = context;
  if (!entry || sessionId === undefined) {
    return <Note>{t('tasks.noSession')}</Note>;
  }
  return (
    <WorkspaceRoot value={entry.workspace.rootPath}>
      <SessionTasks workspaceId={entry.workspace.id} sessionId={sessionId as SessionId} />
    </WorkspaceRoot>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <Activity aria-hidden className="size-6 stroke-[1.5] text-muted-foreground" />
      <p className="max-w-64 text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

function SessionTasks({ workspaceId, sessionId }: { workspaceId: string; sessionId: SessionId }) {
  const state = useTranscript(sessionId);
  const subagents = state?.transcript.subagents ?? NO_SUBAGENTS;
  const { open, done } = groupSubagents(subagents);
  const now = useNow(open.length > 0 ? 1000 : undefined);
  const [showDone, setShowDone] = useState(false);
  const stop = useSubagentStop();
  const [error, setError] = useState<string>();

  if (subagents.length === 0) return <Note>{t('tasks.empty')}</Note>;
  const item = (summary: SubagentSummary, framed: boolean) => (
    <TaskItem
      key={summary.sessionId}
      summary={summary}
      framed={framed}
      now={now}
      href={paths.agent(workspaceId, sessionId, summary.sessionId)}
      onStop={
        stop.supported && summary.status === 'running'
          ? () => {
              setError(undefined);
              void stop.stop(summary.sessionId).then((failure) => {
                if (failure) setError(t('tasks.stopFailed', { error: failure }));
              });
            }
          : undefined
      }
    />
  );
  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 px-3 pt-1 pb-3" data-testid="tasks-pane">
        {error && (
          <p
            role="alert"
            className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        {open.length > 0 && (
          <section aria-label={t('tasks.running', { count: open.length })}>
            <h3 className="px-1 pb-1.5 text-xs text-muted-foreground">
              {t('tasks.running', { count: open.length })}
            </h3>
            <ul className="space-y-2">{open.map((summary) => item(summary, true))}</ul>
          </section>
        )}
        {done.length > 0 && (
          <section>
            <button
              type="button"
              aria-expanded={showDone}
              onClick={() => setShowDone((value) => !value)}
              className="flex h-6 items-center gap-1 rounded-md px-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              {t('tasks.done', { count: done.length })}
              <ChevronRight
                aria-hidden
                className={cn(
                  'size-3.5 transition-transform duration-200 ease-smooth',
                  showDone && 'rotate-90',
                )}
              />
            </button>
            <Collapse open={showDone}>
              <ul className="space-y-1 pt-1">{done.map((summary) => item(summary, false))}</ul>
            </Collapse>
          </section>
        )}
      </div>
    </ScrollArea>
  );
}

function TaskItem({
  summary,
  framed,
  now,
  href,
  onStop,
}: {
  summary: SubagentSummary;
  /** 进行中的是带框的小卡片，已完成的是不带框的行。 */
  framed: boolean;
  now: number;
  href: string;
  onStop: (() => void) | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const running = summary.status === 'running';
  const tokens = useChildTokens(summary.sessionId, running);
  const end = running ? now : Date.parse(summary.endedAt ?? '') || now;
  const failed = summary.status === 'failed' || summary.status === 'cancelled';
  const meta = [
    summary.modelId,
    tokens !== undefined && t('tasks.tokens', { tokens: formatTokens(tokens) }),
  ].filter(Boolean);
  return (
    <li
      data-testid="task-item"
      data-status={summary.status}
      className={cn(framed ? 'rounded-xl border border-border bg-background' : 'rounded-lg')}
    >
      <div className="flex items-start gap-2 px-3 py-2">
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="-mx-1 min-w-0 flex-1 rounded-md px-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <span className="flex min-w-0 items-center gap-2">
            <SubagentAvatar sessionId={summary.sessionId} status={summary.status} size={16} />
            <span className="truncate text-sm">{subagentTitle(summary)}</span>
          </span>
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {meta.join(' · ')}
            {failed && (
              <span className="text-destructive">
                {meta.length > 0 && ' · '}
                {statusLabel(summary.status)}
              </span>
            )}
          </span>
        </button>
        <span className="mt-0.5 shrink-0 text-xs text-muted-foreground tabular-nums">
          {formatDuration(end - Date.parse(summary.startedAt))}
        </span>
        {onStop && (
          <IconButton
            label={t('tasks.stop')}
            size="icon-xs"
            className="text-muted-foreground hover:text-destructive"
            onClick={onStop}
            data-testid="task-stop"
          >
            <Square />
          </IconButton>
        )}
      </div>
      <Collapse open={expanded}>
        <div className="border-t border-border px-3 py-2">
          <div className="max-h-80 overflow-y-auto">
            {expanded && <ChildSteps childId={summary.sessionId} running={running} />}
          </div>
          <Link
            to={href}
            className="mt-1 inline-flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground"
          >
            {t('tasks.viewTranscript')}
            <ChevronRight aria-hidden className="size-3.5" />
          </Link>
        </div>
      </Collapse>
    </li>
  );
}

/** 子会话最近一个回合的过程（U16 的工作组：做完的折成一行摘要，失败的标红，命令与输出在详情里）。 */
function ChildSteps({ childId, running }: { childId: SessionId; running: boolean }) {
  const state = useTranscript(childId);
  const messages = state?.transcript.messages ?? [];
  const last = messages.findLast((message) => message.role !== 'system');
  const turnId = last?.turnId;
  const parts: ChatPart[] = messages.flatMap((message) =>
    message.role === 'assistant' && message.turnId === turnId ? message.parts : [],
  );
  if (parts.length === 0) {
    return <p className="py-1 text-xs text-muted-foreground">{t('tasks.noSteps')}</p>;
  }
  return (
    <div className="text-sm">
      <PartsView parts={parts} turnActive={running} />
    </div>
  );
}
