import type { Transcript } from '@wevir/client-sdk';
import type { Session } from '@wevir/protocol';
import { cn } from 'cn';
import { ChevronDown } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Collapse } from '@/components/collapse';

import { openerOf } from '@/data/session-threads';
import { useSessionActivity, useWorkbenchData } from '@/data/workbench-data';
import { Orb } from '@/fx/orb';
import { turnOrb } from '@/fx/orb-state';
import { t } from '@/i18n';
import { paths } from '@/routes/paths';
import { type AgentActivity, type AgentStep, agentRun, formatClock } from './agent-status-model';
import { useElapsed } from './elapsed';
import { formatDuration } from './format';

// 代理状态（照 Arc 的 Agent status 的排布：live 圈、当前动作、计时，点开是做过的几步）。Arc 的那一件是 Pro 组件，这里没有用它
// 的源码，只按公开的样子用 Wevir 已有的部件重做：圈是会话的 thinking orb，进行中的文字是 session.css 的 shimmer，展开收起是
// Collapse，计时每秒走一次只重画数字。

/** 展开时最多列出最近几步，更早的在消息流里。 */
const RECENT_STEPS = 5;

/** 计时：从 `since` 起，0:07 这样的写法，等宽数字。 */
export function RunClock({ since, className }: { since: string | undefined; className?: string }) {
  const elapsed = useElapsed(since);
  if (elapsed === undefined) return null;
  return <span className={cn('tabular-nums', className)}>{formatClock(elapsed)}</span>;
}

/** 当前动作的一行：进行中的扫光，等用户处理时用待审批色；目标（文件名、命令）等宽。 */
export function ActivityText({
  activity,
  className,
}: {
  activity: AgentActivity;
  className?: string;
}) {
  return (
    <span className={cn('flex min-w-0 items-baseline gap-1.5', className)}>
      <span className={cn('shrink-0', activity.tone === 'awaiting' ? 'text-warning' : 'shimmer')}>
        {activity.label}
      </span>
      {activity.target && (
        <span className="min-w-0 truncate font-mono text-[0.92em] text-muted-foreground">
          {activity.target}
        </span>
      )}
    </span>
  );
}

/**
 * 输入框上方的状态卡：回合进行中时出现。收起时一行（圈、当前动作、做完几步、计时），点开列出最近几步与各自的用时。
 * 消息流滚到上面去看别的时，这里仍看得到 agent 正在做什么。等审批、等回答时不显示（那张卡片在上面）。
 */
export function AgentStatusCard({
  session,
  transcript,
}: {
  session: Session;
  transcript: Transcript;
}) {
  const [open, setOpen] = useState(false);
  const run = useMemo(() => agentRun(transcript, session.cwd), [transcript, session.cwd]);
  // 等审批、等回答时上面就是那张卡片，说的是同一件事。
  if (!run || transcript.pendingApprovals.length > 0 || transcript.pendingQuestions.length > 0)
    return null;
  const awaiting = run.current.tone === 'awaiting';
  const recent = run.steps.slice(-RECENT_STEPS);
  return (
    <section
      aria-label={t('agentStatus.label')}
      data-testid="agent-status"
      className="mb-2 rounded-xl border border-border bg-background animate-in fade-in slide-in-from-bottom-1 duration-200 ease-smooth"
    >
      <button
        type="button"
        aria-expanded={open}
        disabled={run.steps.length === 0}
        onClick={() => setOpen(!open)}
        className="flex h-9 w-full min-w-0 items-center gap-2 rounded-xl px-3 text-left text-sm outline-none focus-visible:focus-ring"
      >
        <span aria-hidden className="flex size-5 shrink-0 items-center justify-center">
          <Orb state={turnOrb(session.id, run.turnId)} paused={awaiting} />
        </span>
        <ActivityText activity={run.current} className="flex-1" />
        <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          {run.steps.length > 0 && (
            <span className="tabular-nums">
              {t('agentStatus.steps', { count: run.steps.length })}
            </span>
          )}
          <RunClock since={run.startedAt ?? session.activeTurn?.startedAt} />
          {run.steps.length > 0 && (
            <ChevronDown
              aria-hidden
              className={cn(
                'size-3.5 transition-transform duration-200 ease-smooth',
                open && 'rotate-180',
              )}
            />
          )}
        </span>
      </button>
      <Collapse open={open && recent.length > 0}>
        <ol className="border-t border-border px-3 py-1.5">
          {recent.map((step) => (
            <StepRow key={step.key} step={step} />
          ))}
        </ol>
      </Collapse>
    </section>
  );
}

function StepRow({ step }: { step: AgentStep }) {
  const failed = step.tone === 'failed' || step.tone === 'unknown';
  return (
    <li className="flex h-7 min-w-0 items-center gap-2 text-sm">
      <span
        aria-hidden
        className={cn(
          'size-1.5 shrink-0 rounded-full',
          failed ? 'bg-destructive' : 'bg-muted-foreground/50',
        )}
      />
      <span className={cn('shrink-0', failed ? 'text-destructive' : 'text-soft-foreground')}>
        {step.label}
      </span>
      {step.target && (
        <span className="min-w-0 flex-1 truncate font-mono text-[0.92em] text-muted-foreground">
          {step.target}
        </span>
      )}
      {step.durationMs !== undefined && (
        <span className="ml-auto shrink-0 pl-2 text-xs tabular-nums text-muted-foreground">
          {formatDuration(step.durationMs)}
        </span>
      )}
    </li>
  );
}

/**
 * 这个会话开出的、还在跑的会话（wevir_session_create 与从建议开出的）：每个一行，圈、标题、当前动作与计时，点了打开它。
 * 跑完的不列，侧栏里照常能找到。
 */
export function OpenedSessionsStatus({ sessionId }: { sessionId: string }) {
  const data = useWorkbenchData();
  const running = useMemo(() => {
    if (data.status !== 'ready') return [];
    const found: Session[] = [];
    for (const workspace of data.workspaces) {
      for (const session of workspace.sessions) {
        if (openerOf(session) !== sessionId) continue;
        if (session.state === 'running' || session.state === 'awaiting_approval')
          found.push(session);
      }
    }
    return found;
  }, [data, sessionId]);
  if (running.length === 0) return null;
  return (
    <ul
      aria-label={t('agentStatus.opened')}
      data-testid="opened-sessions-status"
      className="mb-2 rounded-xl border border-border bg-background py-1 animate-in fade-in slide-in-from-bottom-1 duration-200 ease-smooth"
    >
      {running.map((session) => (
        <OpenedSessionRow key={session.id} session={session} />
      ))}
    </ul>
  );
}

function OpenedSessionRow({ session }: { session: Session }) {
  const activity = useSessionActivity(session.id);
  const awaiting = session.state === 'awaiting_approval' || session.awaitingInput === true;
  return (
    <li>
      <Link
        to={paths.session(session.workspaceId, session.id)}
        className="mx-1 flex h-8 min-w-0 items-center gap-2 rounded-lg px-2 text-sm outline-none transition-colors duration-150 ease-smooth hover:bg-muted focus-visible:focus-ring"
      >
        <span aria-hidden className="flex size-5 shrink-0 items-center justify-center">
          <Orb
            state={turnOrb(session.id, session.activeTurn?.turnId ?? session.id)}
            paused={awaiting}
          />
        </span>
        <span className="max-w-[40%] shrink-0 truncate font-medium">
          {session.title || t('session.untitled')}
        </span>
        {activity ? (
          <ActivityText activity={activity} className="flex-1 text-muted-foreground" />
        ) : (
          <span className="flex-1" />
        )}
        <RunClock
          since={session.activeTurn?.startedAt}
          className="shrink-0 text-xs text-muted-foreground"
        />
      </Link>
    </li>
  );
}
