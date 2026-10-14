import type { ChatPartOf } from '@wevir/client-sdk';
import { cn } from 'cn';
import { Link, useParams } from 'react-router';
import { t } from '@/i18n';
import { paths } from '@/routes/paths';
import { SubagentAvatar } from './subagent-avatar';
import { markerText } from './subagent-model';

/**
 * 一串连续的子智能体标记并成一行小标签（U2，方向稿 A 静器）：多个子 agent 同时派出、或先后结束时不再各占一行。
 */
export function SubagentRow({ parts }: { parts: readonly ChatPartOf<'subagent'>[] }) {
  return (
    <div className="my-2 flex flex-wrap gap-1.5" data-subagent-row>
      {parts.map((part) => (
        <SubagentMarker key={part.key} part={part} />
      ))}
    </div>
  );
}

/**
 * 父会话消息流里子会话的一个标记（R5，截图 01；U2 起是小标签）：头像 +“〈标题〉开始工作”，结束的位置另有一个
 * “〈标题〉已完成”（投影的“结束”部件）。点它进入子 agent 视图（`/workspace/:wid/session/:sid/agent/:childId`）。
 */
export function SubagentMarker({ part }: { part: ChatPartOf<'subagent'> }) {
  const { workspaceId, sessionId } = useParams();
  const { subagent, ended } = part;
  const running = ended === undefined && subagent.status === 'running';
  const waiting = running && subagent.pendingApprovals.length > 0;
  const className =
    'inline-flex h-7 max-w-full items-center gap-2 rounded-full border border-border bg-card pr-3 pl-1.5 text-sm text-soft-foreground';
  const content = (
    <>
      <SubagentAvatar
        sessionId={subagent.sessionId}
        className={cn(running && 'motion-safe:animate-pulse')}
      />
      <span className="truncate">{markerText(subagent, ended)}</span>
      {waiting && (
        <span className="shrink-0 rounded-sm bg-warning/10 px-1.5 text-xs leading-5 font-medium text-warning">
          {t('subagent.awaitingApproval')}
        </span>
      )}
    </>
  );
  if (workspaceId === undefined || sessionId === undefined) {
    return <span className={className}>{content}</span>;
  }
  return (
    <Link
      to={paths.agent(workspaceId, sessionId, subagent.sessionId)}
      data-subagent-marker={ended ?? 'started'}
      className={cn(
        className,
        'outline-none hover:border-border-strong hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
      )}
    >
      {content}
    </Link>
  );
}
