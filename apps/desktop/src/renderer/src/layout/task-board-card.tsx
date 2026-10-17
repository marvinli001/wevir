// 会话侧栏的“任务清单”卡片（0.52.0，desktop-layout.md §12）：agent 用 wevir_tasks 系列工具维护的共享任务清单（task-board-model.ts），
// 按状态分组，每项有认领的会话（点它去那个会话）、“可开始”“等待 t1”的标记，点一项展开说明与备注。清单属于会话树的根会话，
// 只在根会话的侧栏里；界面只读。

import type { BoardTaskStatus } from '@wevir/protocol';
import { cn } from 'cn';
import { ChevronRight, Circle, CircleCheck, CircleDot, CircleSlash } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Collapse } from '@/components/collapse';
import { useTranscript, useWorkbenchData } from '@/data/workbench-data';
import { t } from '@/i18n';
import { type RailContext, registerRailCard } from './session-rail';
import {
  type BoardGroup,
  type BoardRow,
  boardGroups,
  boardProgress,
  type SessionRef,
} from './task-board-model';

const STATUS_ICONS: Record<BoardTaskStatus, typeof Circle> = {
  in_progress: CircleDot,
  pending: Circle,
  completed: CircleCheck,
  cancelled: CircleSlash,
};

function refLabel(ref: SessionRef): string {
  switch (ref.kind) {
    case 'self':
      return t('rail.taskBoard.owner.self');
    case 'unknown':
      return t('rail.taskBoard.owner.other');
    default:
      return ref.title;
  }
}

function Owner({ owner }: { owner: SessionRef }) {
  if (owner.kind === 'subagent' || owner.kind === 'session') {
    return (
      <Link
        to={owner.to}
        data-testid="task-owner"
        className="truncate rounded-sm underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        {owner.title}
      </Link>
    );
  }
  return <span data-testid="task-owner">{refLabel(owner)}</span>;
}

function TaskRow({ row, open, onToggle }: { row: BoardRow; open: boolean; onToggle: () => void }) {
  const { task } = row;
  const Icon = STATUS_ICONS[task.status];
  const resolved = task.status === 'completed' || task.status === 'cancelled';
  const content = (
    <>
      <Icon
        aria-hidden
        className={cn(
          'size-4 shrink-0 text-muted-foreground',
          task.status === 'in_progress' && 'text-running',
          task.status === 'completed' && 'text-success',
        )}
      />
      <span
        title={task.subject}
        className={cn(
          'min-w-0 flex-1 truncate',
          resolved && 'text-muted-foreground',
          task.status === 'cancelled' && 'line-through',
        )}
      >
        {task.subject}
      </span>
      {row.ready && (
        <span className="shrink-0 text-xs text-success">{t('rail.taskBoard.ready')}</span>
      )}
      {row.waitingFor.length > 0 && (
        <span className="shrink-0 text-xs text-muted-foreground">
          {t('rail.taskBoard.waiting', { ids: row.waitingFor.join(', ') })}
        </span>
      )}
      {row.expandable && (
        <ChevronRight
          aria-hidden
          className={cn(
            'size-3.5 shrink-0 text-muted-foreground transition-transform duration-200 ease-smooth',
            open && 'rotate-90',
          )}
        />
      )}
    </>
  );
  const line = 'flex min-h-7 w-full min-w-0 items-center gap-2 text-left';
  return (
    <li data-testid={`task-${task.id}`}>
      {row.expandable ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className={cn(
            line,
            '-mx-1.5 w-[calc(100%+0.75rem)] rounded-md px-1.5 outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50',
          )}
        >
          {content}
        </button>
      ) : (
        <div className={line}>{content}</div>
      )}
      {row.owner && (
        <div className="flex min-w-0 pb-1 pl-6 text-xs text-muted-foreground">
          <Owner owner={row.owner} />
        </div>
      )}
      {row.expandable && (
        <Collapse open={open}>
          <div className="space-y-1 pb-1.5 pl-6 text-xs">
            {task.description !== undefined && (
              <p className="break-words whitespace-pre-wrap text-soft-foreground">
                {task.description}
              </p>
            )}
            {row.notes.length > 0 && (
              <ul className="space-y-0.5">
                {row.notes.map((note) => (
                  <li key={`${note.at}:${note.text}`} className="break-words">
                    <span className="text-muted-foreground">{refLabel(note.author)}</span>{' '}
                    <span className="text-soft-foreground">{note.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Collapse>
      )}
    </li>
  );
}

function TaskBoardDetails({ groups }: { groups: readonly BoardGroup[] }) {
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpenIds((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return (
    <div data-testid="rail-task-board" className="max-h-80 overflow-x-hidden overflow-y-auto">
      {groups.map((group) => (
        <section key={group.status} className="mb-2 last:mb-0">
          <h3 className="mb-0.5 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            {t(`rail.taskBoard.status.${group.status}`)}
            <span className="tabular-nums">{group.rows.length}</span>
          </h3>
          <ul>
            {group.rows.map((row) => (
              <TaskRow
                key={row.task.id}
                row={row}
                open={openIds.has(row.task.id)}
                onToggle={() => toggle(row.task.id)}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

const NO_SESSIONS: never[] = [];

function useTaskBoardCard({ sessionId, entry }: RailContext) {
  const state = useTranscript(sessionId);
  const data = useWorkbenchData();
  const board = state?.transcript.taskBoard;
  const subagents = state?.transcript.subagents;
  const sessions = useMemo(
    () =>
      data.status === 'ready' ? data.workspaces.flatMap((item) => item.sessions) : NO_SESSIONS,
    [data],
  );
  const workspaceId = entry.workspace.id;
  const groups = useMemo(
    () =>
      board === undefined || board.length === 0
        ? []
        : boardGroups(board, {
            rootId: sessionId,
            workspaceId,
            subagents: subagents ?? [],
            sessions,
            untitled: t('session.untitled'),
          }),
    [board, subagents, sessions, sessionId, workspaceId],
  );
  if (board === undefined || groups.length === 0) return null;
  const { done, total } = boardProgress(board);
  return {
    ...(total > 0 && { summary: <span className="tabular-nums">{`${done}/${total}`}</span> }),
    details: <TaskBoardDetails groups={groups} />,
  };
}

registerRailCard({
  id: 'task-board',
  order: 37,
  title: () => t('rail.taskBoard'),
  useCard: useTaskBoardCard,
});
