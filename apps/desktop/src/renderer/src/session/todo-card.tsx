import type { Transcript } from '@wevir/client-sdk';
import type { TodoItem } from '@wevir/protocol';
import { cn } from 'cn';
import { CircleCheck, CircleDashed, CircleDot, LoaderCircle } from 'lucide-react';
import { Hint } from '@/components/hint';
import { t } from '@/i18n';
import { type TurnTodos, todoRowState, turnRecap } from './todo-model';

/**
 * 回合的实时清单（U20，desktop-tokens.md §25；截图 05–07）：2026-11-02 起照 Claude Code 画在消息流里回合末尾（当前动作那一行
 * 之前），不再停在输入框上方。2026-11-05 起也照 Claude Code 去掉标题行与折叠，只列各项；回合结束后没标完的项不再转圈，回合自己做完收了尾的，没标完的按做完显示。
 * `running` 是进行中的子会话数，写在进行中那一项下面。
 */
export function TurnTodoCard({ todos, running }: { todos: TurnTodos; running: number }) {
  return <TodoCard key={todos.turnId} todos={todos} running={todos.active ? running : 0} />;
}

function TodoCard({ todos, running }: { todos: TurnTodos; running: number }) {
  return (
    <section
      aria-label={t('todo.title')}
      data-testid="todo-card"
      className="mt-3 rounded-xl border border-border bg-background px-3 py-2 animate-in fade-in slide-in-from-bottom-1 duration-200 ease-smooth"
    >
      <ul>
        {todos.items.map((item, index) => (
          <TodoRow
            // biome-ignore lint/suspicious/noArrayIndexKey: 清单整体替换，没有稳定 ID。
            key={index}
            item={item}
            turnActive={todos.active}
            finishedWell={todos.finishedWell}
            running={running}
          />
        ))}
      </ul>
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
