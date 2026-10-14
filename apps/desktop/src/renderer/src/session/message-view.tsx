import type { ChatPart, ChatPartOf, SystemChatMessage, UserChatMessage } from '@wevir/client-sdk';
import type { ClientIdentity } from '@wevir/protocol';
import { cn } from 'cn';
import { CircleAlert, Info } from 'lucide-react';
import { memo } from 'react';
import { t } from '@/i18n';
import { clientLabel } from './approval-model';
import type { LiveState } from './live-indicator';
import { MarkdownView } from './markdown/markdown-view';
import { SubagentRow } from './subagent-marker';
import { groupWork } from './tool-model';
import { WorkGroup } from './work-group';

// 消息流里的一条消息（T5.3；U2 起由回合 turn-view.tsx 组织：助手消息里连续的思考与工具调用合成工作组，子智能体标记
// 并成一行，回合结束后的折叠也在那里决定）。

export function UserMessage({
  message,
  self,
}: {
  message: UserChatMessage;
  self: ClientIdentity | undefined;
}) {
  const text = message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
  // 本桌面端发的消息不标来源；别的客户端（CLI、另一台设备）发的标出来。子会话里父 agent 给的输入没有 sentBy
  // （R4），标成“父 agent 派给它的任务”（R5）。
  const { sentBy } = message;
  const fromElsewhere = sentBy !== undefined && (!self || sentBy.clientId !== self.clientId);
  return (
    <div className="flex flex-col items-end" data-message-role="user">
      <div className="max-w-[85%] rounded-xl bg-muted px-3.5 py-2 text-base whitespace-pre-wrap break-words">
        {text}
      </div>
      {fromElsewhere && (
        <span className="mt-1 text-xs text-muted-foreground">
          {t('transcript.from', { who: clientLabel(sentBy, self) })}
        </span>
      )}
      {message.fromParentAgent && (
        <span className="mt-1 text-xs text-muted-foreground">
          {t('transcript.fromParentAgent')}
        </span>
      )}
      {message.steered && (
        <span className="mt-1 text-xs text-muted-foreground" data-steered>
          {t('transcript.steered')}
        </span>
      )}
    </div>
  );
}

/**
 * 一条助手消息（或系统消息）的部件：连续的思考与工具调用是一个工作组，连续的子智能体标记是一行小标签，其余照常。
 * `live` 时最后一项若是工作组，它显示当前动作（否则回合在末尾另起“正在思考”那一行，turn-view.tsx）。
 */
export function PartsView({
  parts,
  turnActive,
  live,
  startedAt,
}: {
  parts: readonly ChatPart[];
  /** 所属回合是否仍在进行（决定未收尾的工具算运行中还是状态未知）。 */
  turnActive: boolean;
  /** 这是进行中回合的最后一条消息。 */
  live?: LiveState;
  startedAt?: string;
}) {
  const items = groupWork(parts);
  return (
    <>
      {items.map((item, index) => {
        const tail = index === items.length - 1;
        switch (item.kind) {
          case 'work':
            return (
              <WorkGroup
                key={item.key}
                foldKey={item.key}
                entries={item.entries}
                turnActive={turnActive}
                tail={tail}
                {...(tail && live && { live })}
                {...(startedAt !== undefined && { startedAt })}
              />
            );
          case 'subagents':
            return <SubagentRow key={item.key} parts={item.parts} />;
          default:
            return <PartView key={item.part.key} part={item.part} />;
        }
      })}
    </>
  );
}

/** 不属于回合的提示与错误（恢复、只读、关闭；父会话空闲时才结束的子智能体）。 */
export const SystemMessage = memo(function SystemMessage({
  message,
}: {
  message: SystemChatMessage;
}) {
  return (
    <div data-message-role="system">
      <PartsView parts={message.parts} turnActive={false} />
    </div>
  );
});

/** 工作组与子智能体行之外的部件。 */
const PartView = memo(function PartView({ part }: { part: ChatPart }) {
  switch (part.type) {
    case 'text':
      return <MarkdownView text={part.text} streaming={part.state === 'streaming'} />;
    case 'todo':
      return <TodoList part={part} />;
    case 'error':
      return <ErrorPart part={part} />;
    case 'notice':
      return <NoticePart part={part} />;
    // 思考、工具、调试信息与子智能体由 groupWork 收进工作组与子智能体行。
    case 'reasoning':
    case 'tool':
    case 'raw':
    case 'subagent':
      return null;
  }
});

const TODO_MARKS: Record<string, string> = { completed: '☑', in_progress: '◐' };

function TodoList({ part }: { part: ChatPartOf<'todo'> }) {
  return (
    <div className="my-2 rounded-xl border border-border bg-card px-3 py-2 text-sm">
      <h4 className="mb-1 text-xs font-medium text-muted-foreground">{t('todo.title')}</h4>
      <ul className="space-y-0.5">
        {part.items.map((item, index) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: 待办列表整体替换，没有稳定 ID。
            key={index}
            className={cn(
              'flex gap-2',
              item.status === 'completed' && 'text-muted-foreground line-through',
            )}
          >
            <span aria-hidden>{TODO_MARKS[item.status] ?? '☐'}</span>
            {item.content}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ErrorPart({ part }: { part: ChatPartOf<'error'> }) {
  return (
    <div
      role="note"
      className="my-2 flex gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm"
    >
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0">
        <p className="font-medium text-destructive">{t(`engineError.category.${part.category}`)}</p>
        <p className="mt-0.5 font-mono text-xs break-words whitespace-pre-wrap">{part.message}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t(`engineError.hint.${part.category}`)}
        </p>
      </div>
    </div>
  );
}

function NoticePart({ part }: { part: ChatPartOf<'notice'> }) {
  const { notice } = part;
  const text =
    notice.kind === 'resumed'
      ? notice.engineVersion
        ? t('notice.resumedVersion', { version: notice.engineVersion })
        : t('notice.resumed')
      : notice.kind === 'read_only'
        ? t('notice.readOnly', { reason: t(`readOnly.${notice.reason}`) })
        : t('notice.closed');
  return (
    <p className="my-2 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
      <Info aria-hidden className="size-3.5" />
      {text}
    </p>
  );
}
