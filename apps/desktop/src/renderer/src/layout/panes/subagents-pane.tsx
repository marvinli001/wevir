import type { SessionId, SubagentSummary } from '@wevir/protocol';
import { cn } from 'cn';
import { Bot, SearchX } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useTranscript } from '@/data/workbench-data';
import { t } from '@/i18n';
import { paths } from '@/routes/paths';
import { SubagentAvatar } from '@/session/subagent-avatar';
import {
  formatRelativeTime,
  groupSubagents,
  lastActivity,
  statusLabel,
  subagentCounts,
  subagentTitle,
} from '@/session/subagent-model';
import { SubagentView, useNow } from '@/session/subagent-view';
import { usePanes } from '../pane-controller';
import type { PaneContext } from '../pane-registry';
import { registerSummarySection } from '../summary-card';

/**
 * “子智能体”窗格（R5，desktop-layout.md §2.1、§5.2；截图 03、04）：URL 没有 `agent/:childId` 时是当前会话的子会话
 * 列表，按“已开启 · N”“完成 · N”分组；有的话是那个子会话的视图，返回箭头回到列表。
 */
export function SubagentsPane({ context }: { context: PaneContext }) {
  const { entry, sessionId, childId } = context;
  if (!entry || sessionId === undefined) {
    return <PaneNote icon={<Bot />}>{t('subagent.list.noSession')}</PaneNote>;
  }
  return (
    <SessionSubagents
      workspaceId={entry.workspace.id}
      sessionId={sessionId as SessionId}
      childId={childId}
    />
  );
}

function SessionSubagents({
  workspaceId,
  sessionId,
  childId,
}: {
  workspaceId: string;
  sessionId: SessionId;
  childId: string | undefined;
}) {
  const state = useTranscript(sessionId);
  const navigate = useNavigate();
  const subagents = state?.transcript.subagents ?? [];
  const loaded = state !== undefined && (state.caughtUp || state.transcript.lastSeq > 0);

  if (childId !== undefined) {
    const summary = subagents.find((item) => item.sessionId === childId);
    const back = () => navigate(paths.session(workspaceId, sessionId));
    if (summary) return <SubagentView key={summary.sessionId} summary={summary} onBack={back} />;
    // 回放还没追平时它可能还没出现；追平之后还没有就是“未找到”，只在这个窗格里说（§5.2 第 4 条）。
    if (!state?.caughtUp) return <PaneNote>{t('subagent.list.loading')}</PaneNote>;
    return (
      <EmptyState
        icon={<SearchX />}
        title={t('subagent.detail.notFoundTitle')}
        action={
          <Button variant="outline" size="sm" onClick={back}>
            {t('subagent.detail.back')}
          </Button>
        }
      >
        {t('subagent.detail.notFound', { id: childId })}
      </EmptyState>
    );
  }
  if (!loaded) return <PaneNote>{t('subagent.list.loading')}</PaneNote>;
  return (
    <SubagentList
      subagents={subagents}
      hrefFor={(summary) => paths.agent(workspaceId, sessionId, summary.sessionId)}
    />
  );
}

/** 两组列表（截图 03）：每项头像、标题、相对时间；已开启的组没有时说“没有已开启的子智能体”。 */
function SubagentList({
  subagents,
  hrefFor,
}: {
  subagents: readonly SubagentSummary[];
  hrefFor: (summary: SubagentSummary) => string;
}) {
  const now = useNow(30_000);
  const { open, done } = groupSubagents(subagents);
  return (
    <ScrollArea className="h-full">
      <div className="space-y-5 px-4 pt-2 pb-4" data-testid="subagent-list">
        <section>
          <h3 className="mb-1 text-xs text-muted-foreground">
            {t('subagent.list.open', { count: open.length })}
          </h3>
          {open.length === 0 ? (
            <p className="py-1.5 text-sm text-muted-foreground">{t('subagent.list.openEmpty')}</p>
          ) : (
            <SubagentItems items={open} hrefFor={hrefFor} now={now} />
          )}
        </section>
        {done.length > 0 && (
          <section>
            <h3 className="mb-1 text-xs text-muted-foreground">
              {t('subagent.list.done', { count: done.length })}
            </h3>
            <SubagentItems items={done} hrefFor={hrefFor} now={now} />
          </section>
        )}
      </div>
    </ScrollArea>
  );
}

function SubagentItems({
  items,
  hrefFor,
  now,
}: {
  items: readonly SubagentSummary[];
  hrefFor: (summary: SubagentSummary) => string;
  now: number;
}) {
  return (
    <ul className="-mx-2">
      {items.map((summary) => {
        const waiting = summary.status === 'running' && summary.pendingApprovals.length > 0;
        const notable = summary.status === 'failed' || summary.status === 'cancelled';
        return (
          <li key={summary.sessionId}>
            <Link
              to={hrefFor(summary)}
              data-subagent-item={summary.sessionId}
              className="flex h-10 items-center gap-3 rounded-lg px-2 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
            >
              <SubagentAvatar sessionId={summary.sessionId} className="size-5" />
              <span className="min-w-0 flex-1 truncate">{subagentTitle(summary)}</span>
              {waiting && (
                <span className="shrink-0 rounded-sm bg-warning/10 px-1.5 text-xs leading-5 font-medium text-warning">
                  {t('subagent.awaitingApproval')}
                </span>
              )}
              {notable && (
                <span
                  className={cn(
                    'shrink-0 text-xs',
                    summary.status === 'failed' ? 'text-destructive' : 'text-muted-foreground',
                  )}
                >
                  {statusLabel(summary.status)}
                </span>
              )}
              <span className="shrink-0 text-xs text-faint-foreground">
                {formatRelativeTime(lastActivity(summary), now)}
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function PaneNote({ icon, children }: { icon?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      {icon && (
        <span className="text-faint-foreground [&_svg]:size-6 [&_svg]:stroke-[1.5]" aria-hidden>
          {icon}
        </span>
      )}
      <p className="max-w-64 text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

// ── 置顶摘要的“子智能体”一节（截图 02） ─────────────────────────────

const NO_SUBAGENTS: readonly SubagentSummary[] = [];
/** 摘要里最多显示几个头像（最近派出的）。 */
const SUMMARY_AVATARS = 5;

function useSubagentsSummary(sessionId: string): ReactNode | null {
  const panes = usePanes();
  const state = useTranscript(sessionId === '' ? undefined : (sessionId as SessionId));
  const subagents = state?.transcript.subagents ?? NO_SUBAGENTS;
  if (subagents.length === 0) return null;
  const { running, done } = subagentCounts(subagents);
  const counts = [
    running > 0 && t('subagent.summary.running', { count: running }),
    done > 0 && t('subagent.summary.done', { count: done }),
  ].filter(Boolean);
  return (
    <section key="subagents" data-testid="summary-subagents">
      <h4 className="pl-1 text-sm text-muted-foreground">{t('subagent.summary.title')}</h4>
      <button
        type="button"
        aria-label={t('subagent.summary.open')}
        onClick={() => panes?.open({ kind: 'subagents' })}
        className="mt-1 flex w-full items-center gap-2 rounded-md px-1 py-1 text-left text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className="flex shrink-0 items-center gap-1">
          {subagents.slice(-SUMMARY_AVATARS).map((summary) => (
            <SubagentAvatar key={summary.sessionId} sessionId={summary.sessionId} />
          ))}
        </span>
        <span className="truncate">{counts.join(' · ')}</span>
      </button>
    </section>
  );
}

registerSummarySection({ id: 'subagents', order: 20, useContent: useSubagentsSummary });
