import type { ChatPartOf } from '@wevir/client-sdk';
import type { Session, SessionId, SuggestedTask, TurnOutcome } from '@wevir/protocol';
import { cn } from 'cn';
import { ChevronRight, CircleCheck, CircleX } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { useWorkbenchData, useWorkbenchStore } from '@/data/workbench-data';
import { Orb } from '@/fx/orb';
import { turnOrb } from '@/fx/orb-state';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { paths } from '@/routes/paths';
import { useTranscriptSessionId } from './fold-state';
import { sendText, usePermissionModes } from './start-session';

/**
 * Agent 建议的后续任务（U23，desktop-layout.md §17、desktop-tokens.md §29）：提出建议的回合里一张卡片，每项一行标题与理由，
 * 右边“开始”；开始之后换成那个会话的状态，点它打开那个会话。
 */
export function SuggestedTasksCard({ part }: { part: ChatPartOf<'tasks'> }) {
  const sessions = useSessions();
  const parent = sessions.get(useTranscriptSessionId() as SessionId);
  const started = part.tasks.filter((task) => task.status !== 'suggested').length;
  return (
    <section
      aria-label={t('suggest.title', { count: part.tasks.length })}
      data-testid="suggested-tasks"
      className="my-3 rounded-xl border border-border bg-background"
    >
      <p className="flex h-8 items-center gap-1 px-3 text-xs text-muted-foreground">
        <span className="font-medium">{t('suggest.title', { count: part.tasks.length })}</span>
        {started > 0 && (
          <span className="tabular-nums">· {t('suggest.startedCount', { count: started })}</span>
        )}
      </p>
      <ul className="divide-y divide-border border-t border-border">
        {part.tasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            parent={parent}
            child={task.sessionId ? sessions.get(task.sessionId) : undefined}
          />
        ))}
      </ul>
    </section>
  );
}

function TaskRow({
  task,
  parent,
  child,
}: {
  task: SuggestedTask;
  parent: Session | undefined;
  child: Session | undefined;
}) {
  const start = useStartTask(parent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const onStart = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await start(task);
    } catch (reason) {
      setError(t('suggest.startFailed', { error: describe(reason) }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="flex min-h-11 items-center gap-3 px-3 py-1.5" data-task={task.status}>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground">{task.title}</p>
        {(error ?? task.reason) && (
          <p
            className={cn('truncate text-xs', error ? 'text-destructive' : 'text-muted-foreground')}
            title={error ?? task.reason}
          >
            {error ?? task.reason}
          </p>
        )}
      </div>
      {task.status === 'suggested' ? (
        <Button
          size="xs"
          variant="secondary"
          disabled={busy || parent === undefined}
          onClick={() => void onStart()}
        >
          {busy ? t('suggest.starting') : t('suggest.start')}
        </Button>
      ) : (
        <TaskStatus task={task} child={child} workspaceId={parent?.workspaceId} />
      )}
    </li>
  );
}

/** 开始之后的状态：进行中（orb）、已完成 ›、出错 ›、已停止 ›，点它打开那个会话。 */
function TaskStatus({
  task,
  child,
  workspaceId,
}: {
  task: SuggestedTask;
  child: Session | undefined;
  workspaceId: string | undefined;
}) {
  const outcome = task.status === 'reported' ? task.outcome : undefined;
  const failed = outcome === 'failed' || outcome === 'interrupted';
  const content =
    outcome === undefined ? (
      <>
        {child?.activeTurn && (
          <Orb state={turnOrb(child.id, child.activeTurn.turnId)} className="shrink-0" />
        )}
        {t('suggest.running')}
      </>
    ) : (
      <>
        {t(
          failed
            ? 'suggest.failed'
            : outcome === 'cancelled'
              ? 'suggest.cancelled'
              : 'suggest.completed',
        )}
        <ChevronRight aria-hidden className="size-3.5" />
      </>
    );
  const className = cn(
    'inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50',
    failed ? 'text-destructive' : 'text-muted-foreground hover:text-foreground',
  );
  if (!workspaceId || !task.sessionId) return <span className={className}>{content}</span>;
  return (
    <Link
      to={paths.session(workspaceId, task.sessionId)}
      title={t('suggest.open')}
      className={className}
    >
      {content}
    </Link>
  );
}

/**
 * 消息流里的回报（`task_report`）：同子智能体的“已完成”小标签，对勾加“〈任务〉已完成”，失败与停止用失败色；点它打开那个
 * 会话。
 */
export function TaskReportMarker({ part }: { part: ChatPartOf<'task_report'> }) {
  const parent = useSessions().get(useTranscriptSessionId() as SessionId);
  const { task } = part;
  const outcome: TurnOutcome = task.outcome ?? 'completed';
  const ok = outcome === 'completed';
  const key =
    outcome === 'completed'
      ? 'suggest.report.completed'
      : outcome === 'cancelled'
        ? 'suggest.report.cancelled'
        : 'suggest.report.failed';
  const Icon = ok ? CircleCheck : CircleX;
  const className = cn(
    'inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-border bg-card pr-3 pl-2 text-sm outline-none',
    ok ? 'text-soft-foreground' : 'text-destructive',
  );
  const content = (
    <>
      <Icon aria-hidden className="size-4 shrink-0" />
      <span className="truncate">{t(key, { title: task.title })}</span>
    </>
  );
  return (
    <div className="my-2 flex" data-task-report={outcome}>
      {parent && task.sessionId ? (
        <Link
          to={paths.session(parent.workspaceId, task.sessionId)}
          title={part.summary}
          className={cn(
            className,
            'hover:border-border-strong focus-visible:ring-2 focus-visible:ring-ring/50',
            ok && 'hover:text-foreground',
          )}
        >
          {content}
        </Link>
      ) : (
        <span className={className}>{content}</span>
      )}
    </div>
  );
}

/** 列表里的全部会话，按 ID。 */
function useSessions(): ReadonlyMap<SessionId, Session> {
  const data = useWorkbenchData();
  const map = new Map<SessionId, Session>();
  if (data.status === 'ready') {
    for (const entry of data.workspaces) {
      for (const session of entry.sessions) map.set(session.id, session);
    }
  }
  return map;
}

/**
 * 开始一项建议：在提出建议的会话的项目里新建会话（模型、推理档位、权限模式沿用它），`session.create` 带 `origin`，再把建议的
 * `prompt` 作为第一条消息发出。不离开当前会话，新会话出现在左栏“进行中”。
 */
function useStartTask(parent: Session | undefined) {
  const { client } = useHostConnection();
  const store = useWorkbenchStore();
  const permissions = usePermissionModes();
  return async (task: SuggestedTask) => {
    if (!client || !parent) return;
    const { session } = await client.request('session.create', {
      workspaceId: parent.workspaceId,
      providerId: parent.providerId,
      modelId: parent.modelId,
      ...(parent.reasoningEffort !== undefined && { reasoningEffort: parent.reasoningEffort }),
      ...(permissions &&
        parent.permissionMode !== undefined && { permissionMode: parent.permissionMode }),
      origin: { kind: 'suggested_task', sessionId: parent.id, taskId: task.id },
    });
    store?.upsertSession(session);
    await sendText(client, session.id, task.prompt);
  };
}
