import type { Transcript } from '@wevir/client-sdk';
import type { TodoItem } from '@wevir/protocol';
import { cn } from 'cn';
import { ChevronRight, CircleCheck, CircleDashed, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { Collapse } from '@/components/collapse';
import { t } from '@/i18n';
import {
  latestTodos,
  type TurnTodos,
  todoCollapsedByDefault,
  todoProgress,
  todoStatus,
  turnRecap,
} from './todo-model';

/**
 * 输入框上方的实时清单（U20，desktop-tokens.md §25；截图 05–07）：会话最近一个回合有清单时显示，回合结束且全部完成、或
 * 会话在等用户时收成一行。
 */
export function TodoDock({ transcript }: { transcript: Transcript }) {
  const todos = latestTodos(transcript);
  if (!todos) return null;
  const waiting = transcript.pendingApprovals.length > 0 || transcript.pendingQuestions.length > 0;
  const running = transcript.subagents.filter((summary) => summary.status === 'running').length;
  // 换回合时重建：用户点开或收起过的只对这一个回合有效。
  return <TodoCard key={todos.turnId} todos={todos} waiting={waiting} running={running} />;
}

function TodoCard({
  todos,
  waiting,
  running,
}: {
  todos: TurnTodos;
  waiting: boolean;
  running: number;
}) {
  const [choice, setChoice] = useState<boolean>();
  const open = choice ?? !todoCollapsedByDefault(todos, waiting);
  const { done, total } = todoProgress(todos.items);
  return (
    <section
      aria-label={t('todo.title')}
      data-testid="todo-card"
      className="mb-2 rounded-xl border border-border bg-background animate-in fade-in slide-in-from-bottom-1 duration-200 ease-smooth"
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setChoice(!open)}
        className={cn(
          'flex w-full items-center gap-1 rounded-xl px-3 text-left text-xs text-muted-foreground outline-none transition-[height] focus-visible:ring-2 focus-visible:ring-ring/50',
          open ? 'h-7' : 'h-9',
        )}
      >
        <span className="font-medium">{t('todo.title')}</span>
        <span className="tabular-nums">
          ·{' '}
          {done === total
            ? t('todo.allDone', { done, total })
            : t('todo.progress', { done, total })}
        </span>
        <ChevronRight
          aria-hidden
          className={cn(
            'size-3.5 transition-transform duration-200 ease-smooth',
            open && 'rotate-90',
          )}
        />
      </button>
      <Collapse open={open}>
        <ul className="max-h-40 overflow-y-auto px-3 pb-2">
          {todos.items.map((item, index) => (
            <TodoRow
              // biome-ignore lint/suspicious/noArrayIndexKey: 清单整体替换，没有稳定 ID。
              key={index}
              item={item}
              running={todos.active ? running : 0}
            />
          ))}
        </ul>
      </Collapse>
    </section>
  );
}

function TodoRow({ item, running }: { item: TodoItem; running: number }) {
  const status = todoStatus(item);
  return (
    <li data-todo-status={status} className="text-sm">
      <div className="flex min-h-6 items-start gap-2 py-0.5">
        <span className="mt-0.5 shrink-0" aria-hidden>
          {status === 'completed' ? (
            <CircleCheck className="size-4 fill-foreground text-background" />
          ) : status === 'in_progress' ? (
            <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
          ) : (
            <CircleDashed className="size-4 text-muted-foreground" />
          )}
        </span>
        <span className={cn('min-w-0', status === 'completed' && 'text-soft-foreground')}>
          <span className="sr-only">{t(`todo.status.${status}`)}：</span>
          {item.content}
        </span>
      </div>
      {status === 'in_progress' && running > 0 && (
        <p className="pb-0.5 pl-6 text-xs text-muted-foreground">
          {t('todo.runningTasks', { count: running })}
        </p>
      )}
    </li>
  );
}

/**
 * 审批与提问卡片最上面的“这一轮”回顾（U20，D8）：有清单时写进度，没有时写最近一个工作组的摘要，都没有时不显示。不额外调
 * 模型。
 */
export function TurnRecap({ transcript }: { transcript: Transcript }) {
  const recap = turnRecap(transcript);
  if (!recap) return null;
  let text: string;
  if (recap.kind === 'work') {
    text = t('recap.work', { summary: recap.summary });
  } else {
    const { done, total, current } = recap.progress;
    const left = total - done - (current ? 1 : 0);
    text = [
      t('recap.done', { done, total }),
      current && t('recap.current', { step: current.content }),
      left > 0 && t('recap.left', { count: left }),
    ]
      .filter(Boolean)
      .join(t('recap.separator'));
  }
  return (
    <p
      title={text}
      data-testid="turn-recap"
      className="truncate border-b border-border px-4 py-2 text-xs text-muted-foreground"
    >
      {text}
    </p>
  );
}
