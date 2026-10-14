import type {
  AssistantChatMessage,
  ChatMessage,
  ChatPart,
  ChatPartOf,
  SystemChatMessage,
  UserChatMessage,
} from '@wevir/client-sdk';
import type { ClientIdentity } from '@wevir/protocol';
import { cn } from 'cn';
import { Bug, CircleAlert, Info } from 'lucide-react';
import { memo } from 'react';
import { t } from '@/i18n';
import { clientLabel } from './approval-model';
import { Disclosure } from './disclosure';
import { formatDuration, formatJson } from './format';
import { MarkdownView } from './markdown/markdown-view';
import { Thought } from './thought';
import { AggregateToolCard, ToolCard } from './tool-card';
import { groupParts } from './tool-model';

/**
 * 消息流里的一条消息。按对象身份 memo：投影只为改动过的消息生成新对象（client-sdk projection.ts），其余
 * 消息在流式输出时不重新渲染。
 */
export const MessageView = memo(function MessageView({
  message,
  turnActive,
  self,
}: {
  message: ChatMessage;
  /** 这条消息所属的回合是否仍在进行（决定未收尾的工具算运行中还是状态未知）。 */
  turnActive: boolean;
  self: ClientIdentity | undefined;
}) {
  switch (message.role) {
    case 'user':
      return <UserMessage message={message} self={self} />;
    case 'assistant':
      return <AssistantMessage message={message} turnActive={turnActive} />;
    case 'system':
      return <SystemMessage message={message} />;
  }
});

function UserMessage({
  message,
  self,
}: {
  message: UserChatMessage;
  self: ClientIdentity | undefined;
}) {
  const text = message.parts.map((part) => (part.type === 'text' ? part.text : '')).join('\n');
  // 本桌面端发的消息不标来源；别的客户端（CLI、另一台设备）发的标出来。子会话里父 agent 给的输入没有 sentBy
  // （R4），怎样标注留给子智能体界面（R5）。
  const { sentBy } = message;
  const fromElsewhere = sentBy !== undefined && (!self || sentBy.clientId !== self.clientId);
  return (
    <div className="mt-6 flex flex-col items-end first:mt-0" data-message-role="user">
      <div className="max-w-[85%] rounded-xl bg-muted px-3.5 py-2 text-base whitespace-pre-wrap break-words">
        {text}
      </div>
      {fromElsewhere && (
        <span className="mt-1 text-xs text-faint-foreground">
          {t('transcript.from', { who: clientLabel(sentBy, self) })}
        </span>
      )}
    </div>
  );
}

function AssistantMessage({
  message,
  turnActive,
}: {
  message: AssistantChatMessage;
  turnActive: boolean;
}) {
  const items = groupParts(message.parts);
  const { finished } = message;
  return (
    <div className="mt-4" data-message-role="assistant">
      {items.map((item, index) =>
        item.kind === 'aggregate' ? (
          <AggregateToolCard
            key={item.key}
            tools={item.tools}
            entries={item.entries}
            turnActive={turnActive}
          />
        ) : (
          <PartView
            key={item.part.key}
            part={item.part}
            turnActive={turnActive}
            // 后面已经有内容时，增量里的思考其实已经结束（已提交的思考稍后才替换它）。
            settled={index < items.length - 1}
          />
        ),
      )}
      {turnActive && items.length === 0 && (
        <p className="animate-pulse text-sm text-faint-foreground">{t('transcript.waiting')}</p>
      )}
      {finished && (
        <p
          className={cn(
            'mt-2 text-xs',
            finished.outcome === 'completed' ? 'text-faint-foreground' : 'text-warning',
          )}
        >
          {t('transcript.turnFooter', {
            outcome: t(`turn.outcome.${finished.outcome}`),
            duration: formatDuration(finished.durationMs),
          })}
        </p>
      )}
    </div>
  );
}

function SystemMessage({ message }: { message: SystemChatMessage }) {
  return (
    <div className="mt-4" data-message-role="system">
      {message.parts.map((part) => (
        <PartView key={part.key} part={part} turnActive={false} />
      ))}
    </div>
  );
}

const PartView = memo(function PartView({
  part,
  turnActive,
  settled = false,
}: {
  part: ChatPart;
  turnActive: boolean;
  /** 后面已有别的部件：思考不再显示“正在思考”。 */
  settled?: boolean;
}) {
  switch (part.type) {
    case 'text':
      return <MarkdownView text={part.text} streaming={part.state === 'streaming'} />;
    case 'reasoning':
      return <Thought part={part} settled={settled} />;
    case 'tool':
      return <ToolCard part={part} turnActive={turnActive} />;
    case 'todo':
      return <TodoList part={part} />;
    case 'error':
      return <ErrorPart part={part} />;
    case 'notice':
      return <NoticePart part={part} />;
    case 'raw':
      return <RawPart part={part} />;
    case 'subagent':
      // 子会话的“开始工作 / 已完成”两行由子智能体界面（R5）来画。
      return null;
  }
});

const TODO_MARKS: Record<string, string> = { completed: '☑', in_progress: '◐' };

function TodoList({ part }: { part: ChatPartOf<'todo'> }) {
  return (
    <div className="my-2 rounded-lg border border-border bg-card px-3 py-2 text-sm">
      <h4 className="mb-1 text-xs font-medium text-muted-foreground">{t('todo.title')}</h4>
      <ul className="space-y-0.5">
        {part.items.map((item, index) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: 待办列表整体替换，没有稳定 ID。
            key={index}
            className={cn(
              'flex gap-2',
              item.status === 'completed' && 'text-faint-foreground line-through',
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
      className="my-2 flex gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm"
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
    <p className="my-2 flex items-center justify-center gap-1.5 text-xs text-faint-foreground">
      <Info aria-hidden className="size-3.5" />
      {text}
    </p>
  );
}

/** 未识别的引擎消息：低调的调试样式，只在开发模式投影（transcript-store.ts 的 INCLUDE_RAW）。 */
function RawPart({ part }: { part: ChatPartOf<'raw'> }) {
  return (
    <Disclosure
      className="my-1 rounded-md border border-dashed border-border px-2 py-1"
      summaryClassName="gap-1.5 font-mono text-xs text-faint-foreground"
      summary={
        <>
          <Bug aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">
            {t('raw.label')} · {part.method}
            {part.kind ? ` · ${part.kind}` : ''}
          </span>
        </>
      }
    >
      <pre className="mt-1 max-h-60 overflow-auto font-mono text-xs whitespace-pre-wrap text-faint-foreground">
        {formatJson(part.params).text}
      </pre>
    </Disclosure>
  );
}
