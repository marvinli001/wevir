import type { ChatPartOf } from '@wevir/client-sdk';
import { cn } from 'cn';
import { Link, useParams } from 'react-router';
import { t } from '@/i18n';
import { paths } from '@/routes/paths';
import { SubagentAvatar } from './subagent-avatar';
import { markerText } from './subagent-model';

/**
 * 父会话消息流里子会话的一行（R5，截图 01）：头像 +“〈标题〉开始工作”，结束的位置另有一行“〈标题〉已完成”（投影的
 * “结束”部件）。点它进入子 agent 视图（`/workspace/:wid/session/:sid/agent/:childId`）。
 */
export function SubagentMarker({ part }: { part: ChatPartOf<'subagent'> }) {
  const { workspaceId, sessionId } = useParams();
  const { subagent, ended } = part;
  const running = ended === undefined && subagent.status === 'running';
  const waiting = running && subagent.pendingApprovals.length > 0;
  const className =
    'my-1.5 flex w-fit max-w-full items-center gap-2 rounded-md text-sm text-muted-foreground';
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
    return <p className={className}>{content}</p>;
  }
  return (
    <Link
      to={paths.agent(workspaceId, sessionId, subagent.sessionId)}
      data-subagent-marker={ended ?? 'started'}
      className={cn(
        className,
        'outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50',
      )}
    >
      {content}
    </Link>
  );
}
