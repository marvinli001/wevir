import type { Transcript } from '@wevir/client-sdk';
import type { TodoItem } from '@wevir/protocol';
import { cn } from 'cn';
import { ChevronRight, CircleCheck, CircleDashed, CircleDot, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { Collapse } from '@/components/collapse';
import { Hint } from '@/components/hint';
import { t } from '@/i18n';
import {
  latestTodos,
  type TurnTodos,
  todoCollapsedByDefault,
  todoProgress,
  todoRowState,
  turnRecap,
} from './todo-model';

/**
 * 输入框上方的实时清单（U20，desktop-tokens.md §25；截图 05–07）：会话最近一个回合有清单时显示，回合结束或会话在等用户时
 * 收成一行；回合结束后没标完的项不再转圈，回合自己做完收了尾的，没标完的按做完显示。
 */
export function TodoDock({ transcript }: { transcript: Transcript }) {
  const todos = latestTodos(transcript);
  // 等审批、等回答时不显示：那张卡片上方已经有本回合的进度（TurnRecap），两张叠着只是重复。
  if (!todos || transcript.pendingApprovals.length > 0 || transcript.pendingQuestions.length > 0)
    return null;
  const running = transcript.subagents.filter((summary) => summary.status === 'running').length;
  // 换回合时重建：用户点开或收起过的只对这一个回合有效。
  return <TodoCard key={todos.turnId} todos={todos} running={running} />;
}

function TodoCard({ todos, running }: { todos: TurnTodos; running: number }) {
  const [choice, setChoice] = useState<boolean>();
  const open = choice ?? !todoCollapsedByDefault(todos);
  const { done, total } = todoProgress(todos.items, todos.finishedWell);
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
          'flex w-full items-center gap-1 rounded-xl px-3 text-left text-xs text-muted-foreground outline-none transition-[height] focus-visible:focus-ring',
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
              turnActive={todos.active}
              finishedWell={todos.finishedWell}
              running={todos.active ? running : 0}
            />
          ))}
        </ul>
      </Collapse>
    </section>
  );
}

function TodoRow({
  item,
  turnActive,
  finishedWell,
  running,
}: {
  item: TodoItem;
  turnActive: boolean;
  finishedWell: boolean;
  running: number;
}) {
  const state = todoRowState(item, turnActive, finishedWell);
  return (
    <li data-todo-status={state} className="text-sm">
      <div className="flex min-h-6 items-start gap-2 py-0.5">
        <span className="mt-0.5 shrink-0" aria-hidden>
          {state === 'completed' ? (
            <CircleCheck className="size-4 fill-foreground text-background" />
          ) : state === 'settled' ? (
            <CircleCheck className="size-4 text-muted-foreground" />
          ) : state === 'in_progress' ? (
            <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
          ) : state === 'stalled' ? (
            <CircleDot className="size-4 text-muted-foreground" />
          ) : (
            <CircleDashed className="size-4 text-muted-foreground" />
          )}
        </span>
        <span
          className={cn(
            'min-w-0',
            (state === 'completed' || state === 'settled') && 'text-soft-foreground',
          )}
        >
          <span className="sr-only">
            {t(`todo.status.${state === 'settled' ? 'completed' : state}`)}
            {t('common.colon')}
          </span>
          {item.content}
        </span>
      </div>
      {state === 'in_progress' && running > 0 && (
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
    <Hint label={text} whenClipped>
      <p
        data-testid="turn-recap"
        className="truncate border-b border-border px-4 py-2 text-xs text-muted-foreground"
      >
        {text}
      </p>
    </Hint>
  );
}
