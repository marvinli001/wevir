import type {
  ChatPart,
  ChatPartOf,
  SystemChatMessage,
  UserChatMessage,
  UserTextSegment,
} from '@wevir/client-sdk';
import type { MessageFrom, PendingMessage, TurnCommand } from '@wevir/protocol';
import { cn } from 'cn';
import {
  ArrowLeftRight,
  ChevronRight,
  CircleAlert,
  ClipboardList,
  FoldVertical,
  Info,
  Reply,
  ScanSearch,
  SquareTerminal,
  Wrench,
} from 'lucide-react';
import { memo, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { GoalIcon } from '@/components/command-icons';
import { ProviderLogo } from '@/components/provider-logo';
import { sourceOf } from '@/data/sources';
import { useAccounts, useWorkbenchData } from '@/data/workbench-data';
import { phalaErrorPresentation } from '@/host/phala-error';
import { currentLocale, t } from '@/i18n';
import { paths } from '@/routes/paths';
import { providerLogo } from '@/settings/provider-catalog';
import { lineCount } from './composer-pastes';
import { CopyButton } from './copy-button';
import { FindingsCard } from './findings-card';
import { formatMessageTime } from './format';
import { GeneratedImage } from './generated-image';
import { GuardrailPart } from './guardrail-part';
import { HandoffDetailDialog } from './handoff-detail';
import { type HandoffNoticeOf, modelLabel } from './handoff-model';
import { MessageImages } from './image-attachments';
import type { LiveState } from './live-indicator';
import { MarkdownView } from './markdown/markdown-view';
import { EditButton, UserMessageEditor, useMessageActions } from './message-actions';
import { OpinionCard, OpinionQuote } from './opinion-card';
import { pendingText, processNoticeLabel } from './pending-model';
import { PlanCard } from './plan-card';
import { SharedFilesCard } from './shared-files-card';
import { SubagentRow } from './subagent-marker';
import { SuggestedTasksCard, TaskReportMarker, useSessions } from './suggested-tasks';
import { groupWork, isImageTool } from './tool-model';
import { RetryRow, UsageLimitCard } from './usage-limit-card';
import { WorkGroup } from './work-group';

// 消息流里的一条消息（T5.3；U2 起由回合 turn-view.tsx 组织：助手消息里连续的思考与工具调用合成工作组，子智能体标记
// 并成一行，回合结束后的折叠也在那里决定）。

export function UserMessage({ message }: { message: UserChatMessage }) {
  if (message.command) return <CommandMessage command={message.command} />;
  return <PlainUserMessage message={message} />;
}

function PlainUserMessage({ message }: { message: UserChatMessage }) {
  const actions = useMessageActions();
  const [editing, setEditing] = useState(false);
  if (message.from?.process !== undefined) return <ProcessReport message={message} />;
  if (message.from?.repair !== undefined) return <RepairReport message={message} />;
  if (message.from?.opinion !== undefined) return <OpinionQuote message={message} />;
  // 额度恢复后 Host 替用户发的继续消息（0.119.0）不显示：额度卡片上写着已自动继续。
  if (message.from?.usageLimit !== undefined) return null;
  if (message.from?.kind === 'report') return <SessionReport message={message} />;
  // 引擎自己开的目标回合（0.35.0）没有用户消息：用户一侧写“继续目标”。
  if (message.trigger === 'goal' && message.parts.length === 0) return <GoalContinuation />;
  const texts = message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : []));
  const text = texts.join('\n');
  // 粘贴的段落（0.90.0）在气泡里折叠显示；复制与编辑仍用全文。
  const segments = message.parts.find((part) => part.type === 'text')?.segments;
  const images = message.parts.flatMap((part) => (part.type === 'image' ? [part.image] : []));
  // 编辑（0.38.0）：只有会话最后一个完成的回合的用户消息，插话不算。
  const editable =
    actions.editTurnId === message.turnId &&
    actions.submitEdit !== undefined &&
    !message.steered &&
    message.trigger === undefined &&
    message.from === undefined;
  if (editing && editable) {
    return (
      <div className="flex flex-col items-end" data-message-role="user">
        {images.length > 0 && <MessageImages images={images} className="mb-1.5" />}
        <UserMessageEditor message={message} initialText={text} onDone={() => setEditing(false)} />
      </div>
    );
  }
  // 子会话里父 agent 给的输入标成“父 agent 派给它的任务”（R5）。别的客户端发的不标来源。
  return (
    <div className="group/user flex flex-col items-end" data-message-role="user">
      {/* 图片（0.28.0）在文字上方，同 Codex 与 Claude Code 桌面端。 */}
      {images.length > 0 && (
        <MessageImages images={images} className={texts.length > 0 ? 'mb-1.5' : undefined} />
      )}
      {texts.length > 0 && <UserBubble text={text} {...(segments && { segments })} />}
      {message.fromParentAgent && (
        <span className="mt-1 text-xs text-muted-foreground">
          {t('transcript.fromParentAgent')}
        </span>
      )}
      {message.from?.kind === 'message' && <FromSession from={message.from} />}
      {message.trigger === 'goal' && (
        <span className="mt-1 text-xs text-muted-foreground" data-goal>
          {t('command.goal')}
        </span>
      )}
      {message.steered && (
        <span className="mt-1 text-xs text-muted-foreground" data-steered>
          {t('transcript.steered')}
        </span>
      )}
      {message.collaborationMode === 'plan' && (
        <span className="mt-1 text-xs text-muted-foreground" data-plan-mode>
          {t('command.plan')}
        </span>
      )}
      {/* 悬停时消息下方靠右出现时间、“复制”（U36）与最后一条消息的“编辑”（0.38.0），照 Codex 桌面端。 */}
      {texts.length > 0 && (
        <div className="mt-1 flex h-6 items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/user:opacity-100 focus-within:opacity-100">
          <MessageTime ts={message.ts} />
          <CopyButton text={text} className="text-muted-foreground" />
          {editable && (
            <EditButton onClick={() => setEditing(true)} className="text-muted-foreground" />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 交给模型、还没插进回合的插话（R11），照 Claude 桌面端画在进行中的回合末尾：同用户消息的气泡，下面一直显示“复制”与“已提交”。
 * 插进回合后由那条 `steered` 的用户消息接替；回合结束前没插成的转为排队，回到输入框上方的待发区。
 */
export function PendingSteerMessage({ message }: { message: PendingMessage }) {
  const text = pendingText(message);
  const images = message.content.flatMap((part) => (part.type === 'image' ? [part] : []));
  return (
    <div
      className="flex flex-col items-end animate-in fade-in slide-in-from-bottom-1 duration-200 ease-smooth"
      data-message-role="user"
      data-pending-steer={message.id}
    >
      {images.length > 0 && (
        <MessageImages images={images} className={text !== '' ? 'mb-1.5' : undefined} />
      )}
      {text !== '' && <UserBubble text={text} />}
      <div className="mt-1 flex h-6 items-center gap-0.5">
        {text !== '' && <CopyButton text={text} className="text-muted-foreground" />}
        <span className="px-1 text-xs text-muted-foreground">{t('pending.steerLocked')}</span>
      </div>
    </div>
  );
}

/** 长消息收起的高度（§55，照 Claude 桌面端：超过 300 px 收起，底部 3rem 渐隐）。 */
const USER_FOLD_PX = 300;
/** 只比收起高度多出这么一点的不收：收起省不了多少，反倒多一次点击。 */
const USER_FOLD_SLACK_PX = 96;

/** 用户消息的气泡：很长时收起到 300 px，底部渐隐，下面是“展开 / 收起”，展开收起有高度过渡。 */
function UserBubble({ text, segments }: { text: string; segments?: readonly UserTextSegment[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number>();
  const [expanded, setExpanded] = useState(false);
  // 量内容的全高（scrollHeight 不受 max-height 影响）；宽度变了重新量。
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setHeight(element.scrollHeight);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // 有粘贴块（0.90.0）时不再整条折叠：粘贴的部分本来就收着，展开后自己限高滚动。
  const foldable =
    segments === undefined && height !== undefined && height > USER_FOLD_PX + USER_FOLD_SLACK_PX;
  const folded = foldable && !expanded;
  return (
    <>
      <div
        ref={ref}
        className={cn(
          'max-w-[85%] min-w-0 rounded-xl bg-muted px-3.5 py-2 text-base whitespace-pre-wrap break-words',
          foldable && 'overflow-hidden transition-[max-height] duration-300 ease-expand',
          folded && '[mask-image:linear-gradient(to_bottom,black_calc(100%-3rem),transparent)]',
        )}
        style={foldable ? { maxHeight: folded ? USER_FOLD_PX : height } : undefined}
        data-user-bubble={foldable ? (folded ? 'folded' : 'expanded') : undefined}
        data-quotable=""
      >
        {segments
          ? segments.map((segment, index) =>
              segment.pasted ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: 段落的顺序与内容不变
                <PastedBlock key={index} text={segment.text} />
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: 段落的顺序与内容不变
                <div key={index}>{segment.text}</div>
              ),
            )
          : text}
      </div>
      {foldable && (
        <button
          type="button"
          aria-expanded={!folded}
          onClick={() => setExpanded(!expanded)}
          className="mt-1 rounded-md px-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:focus-ring"
        >
          {t(folded ? 'message.expand' : 'message.collapse')}
        </button>
      )}
    </>
  );
}

/** 用户消息里粘贴的一段（0.90.0）：默认收起成一行“粘贴的文本 · 42 行”，点开看原文。 */
function PastedBlock({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1 rounded-lg border border-border bg-card text-sm" data-pasted-block="">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-left text-soft-foreground outline-none hover:text-foreground focus-visible:focus-ring"
      >
        <ClipboardList aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {t('transcript.pastedText', { lines: lineCount(text) })}
        </span>
        <ChevronRight
          aria-hidden
          className={cn('size-4 shrink-0 transition-transform duration-150', open && 'rotate-90')}
        />
      </button>
      {open && (
        <pre className="max-h-80 overflow-auto border-t border-border px-2.5 py-2 font-mono text-xs whitespace-pre-wrap break-words">
          {text}
        </pre>
      )}
    </div>
  );
}

/** 消息的时间（0.38.0）：悬停时出现在操作行里，提示里是完整的日期与时刻。 */
function MessageTime({ ts }: { ts: string }) {
  const label = formatMessageTime(ts, currentLocale());
  if (label === '') return null;
  const full = new Intl.DateTimeFormat(currentLocale(), {
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(new Date(ts));
  return (
    <time dateTime={ts} title={full} className="mr-1 text-xs text-muted-foreground tabular-nums">
      {label}
    </time>
  );
}

/** 别的会话里的 agent 发来的消息（0.30.0）：气泡下方注明来自哪个会话，点它打开那个会话。 */
function FromSession({ from }: { from: MessageFrom }) {
  const sessions = useSessions();
  const source = sessions.get(from.sessionId);
  const label = t('transcript.fromSession', {
    title: source?.title || t('session.untitled'),
  });
  return (
    <span className="mt-1 text-xs text-muted-foreground" data-from-session={from.sessionId}>
      {source ? (
        <Link
          to={paths.session(source.workspaceId, source.id)}
          className="rounded-sm outline-none hover:text-foreground focus-visible:focus-ring"
        >
          {label}
        </Link>
      ) : (
        label
      )}
    </span>
  );
}

/**
 * 别的会话回报的结果（0.30.0）：Host 发给模型的回报正文不显示成用户气泡，同建议任务的回报标记一行“〈会话〉的回报”，悬停看
 * 全文，点它打开那个会话。
 */
function SessionReport({ message }: { message: UserChatMessage }) {
  const sessions = useSessions();
  const sessionId = message.from?.sessionId;
  const source = sessionId === undefined ? undefined : sessions.get(sessionId);
  const text = message.parts
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n');
  const className =
    'inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-border bg-card pr-3 pl-2 text-sm text-soft-foreground outline-none';
  const content = (
    <>
      <Reply aria-hidden className="size-4 shrink-0" />
      <span className="truncate">
        {t('transcript.reportFrom', { title: source?.title || t('session.untitled') })}
      </span>
    </>
  );
  return (
    <div className="my-2 flex" data-message-role="user" data-session-report={sessionId}>
      {source ? (
        <Link
          to={paths.session(source.workspaceId, source.id)}
          title={text}
          className={cn(
            className,
            'hover:border-border-strong hover:text-foreground focus-visible:focus-field',
          )}
        >
          {content}
        </Link>
      ) : (
        <span className={className} title={text}>
          {content}
        </span>
      )}
    </div>
  );
}

/**
 * 自动修复的回合（0.65.0）：Host 把检查失败的输出交给模型，正文不显示成用户气泡，标记一行“自动修复 · 第 1/2 次”，悬停看全文。
 */
function RepairReport({ message }: { message: UserChatMessage }) {
  const repair = message.from?.repair;
  if (repair === undefined) return null;
  const text = message.parts
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n');
  return (
    <div className="my-2 flex" data-message-role="user" data-repair-report={repair.repairId}>
      <span
        className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-border bg-card pr-3 pl-2 text-sm text-soft-foreground"
        title={text}
      >
        <Wrench aria-hidden className="size-4 shrink-0" />
        <span className="truncate">
          {t('transcript.repair', { attempt: repair.attempt, max: repair.maxAttempts })}
        </span>
      </span>
    </div>
  );
}

/**
 * 后台进程的通知（0.47.0）：agent 用 `wevir_process_start` 起的进程退出或输出匹配时 Host 发回的消息。同回报一行标记，悬停看
 * 发给模型的全文（最后几行与日志路径）。
 */
function ProcessReport({ message }: { message: UserChatMessage }) {
  const process = message.from?.process;
  if (process === undefined) return null;
  const text = message.parts
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n');
  const label = processNoticeLabel(process);
  return (
    <div className="my-2 flex" data-message-role="user" data-process-report={process.id}>
      <span
        className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full border border-border bg-card pr-3 pl-2 text-sm text-soft-foreground"
        title={text}
      >
        <SquareTerminal aria-hidden className="size-4 shrink-0" />
        <span className="truncate">{label}</span>
      </span>
    </div>
  );
}

/** 由命令开始的回合（0.24.0）：用户一侧是命令本身，“压缩上下文”“代码审查 · 未提交的改动”。 */
function CommandMessage({ command }: { command: TurnCommand }) {
  const Icon = command.kind === 'compact' ? FoldVertical : ScanSearch;
  const label =
    command.kind === 'compact'
      ? t('command.compact')
      : `${t('command.review')} · ${
          command.target === 'branch' && command.baseBranch !== undefined
            ? t('review.branch', { branch: command.baseBranch })
            : t('review.uncommitted')
        }`;
  return (
    <div className="flex flex-col items-end" data-message-role="user" data-command={command.kind}>
      <div className="flex max-w-[85%] min-w-0 items-center gap-2 rounded-xl bg-muted px-3.5 py-2 text-base">
        <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{label}</span>
      </div>
    </div>
  );
}

/** 引擎为进行中的目标自己开的回合（0.35.0）：用户一侧是“继续目标”，样式同命令回合。 */
function GoalContinuation() {
  return (
    <div className="flex flex-col items-end" data-message-role="user" data-goal-continuation>
      <div className="flex max-w-[85%] min-w-0 items-center gap-2 rounded-xl bg-muted px-3.5 py-2 text-base text-muted-foreground">
        <GoalIcon aria-hidden className="size-4 shrink-0" />
        <span className="min-w-0 truncate">{t('goal.continuation')}</span>
      </div>
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
            if (item.part.type === 'retry') {
              return (
                <RetryRow
                  key={item.part.key}
                  part={item.part}
                  active={tail && live !== undefined}
                />
              );
            }
            return item.part.type === 'tool' && isImageTool(item.part) ? (
              <GeneratedImage key={item.part.key} part={item.part} turnActive={turnActive} />
            ) : (
              <PartView key={item.part.key} part={item.part} />
            );
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
      return <MarkdownView text={part.text} streaming={part.state === 'streaming'} quotable />;
    case 'todo':
      return <TodoList part={part} />;
    case 'error':
      return <ErrorPart part={part} />;
    case 'notice':
      return <NoticePart part={part} />;
    case 'question':
      return <QuestionPart part={part} />;
    case 'tasks':
      return <SuggestedTasksCard part={part} />;
    case 'task_report':
      return <TaskReportMarker part={part} />;
    case 'files':
      return <SharedFilesCard part={part} />;
    case 'compaction':
      return <CompactionPart part={part} />;
    case 'chapter':
      return <ChapterDivider part={part} />;
    case 'plan':
      return <PlanCard part={part} />;
    case 'opinion':
      return <OpinionCard part={part} />;
    case 'findings':
      return <FindingsCard part={part} />;
    case 'guardrail':
      return <GuardrailPart part={part} />;
    // 思考、工具、调试信息与子智能体由 groupWork 收进工作组与子智能体行；生成图片的工具由 PartsView 画成 GeneratedImage。
    case 'reasoning':
    case 'tool':
    case 'raw':
    case 'subagent':
    case 'retry':
      return null;
  }
});

/**
 * 消息流里的一组提问（0.10.0）：等回答时不显示（卡片在输入框上方），回答后每题一行“题目 → 回答”，取消时一行说明。超时由
 * Host 按推荐回答的（0.72.0）最后多一行说明。
 */
function QuestionPart({ part }: { part: ChatPartOf<'question'> }) {
  const { question } = part;
  if (question.status === 'pending') return null;
  if (question.status === 'cancelled') {
    return <p className="text-sm text-muted-foreground">{t('question.cancelled')}</p>;
  }
  const answers = question.resolution?.answers ?? {};
  return (
    <ul className="space-y-1 border-l-2 border-border pl-3 text-sm" data-question={question.id}>
      {question.questions.map((item) => {
        const answer = answers[item.id]?.answers ?? [];
        return (
          <li key={item.id} className="min-w-0">
            <span className="text-muted-foreground">{item.header ?? item.question}</span>
            <span className="mx-1.5 text-muted-foreground">→</span>
            <span className={cn(answer.length === 0 && 'text-muted-foreground')}>
              {answer.length === 0
                ? t('question.skipped')
                : item.secret
                  ? '••••'
                  : answer.join('、')}
            </span>
          </li>
        );
      })}
      {question.resolution?.reason === 'timeout' && (
        <li className="text-xs text-muted-foreground">{t('question.timedOut')}</li>
      )}
    </ul>
  );
}

/**
 * 上下文压缩（0.24.0）：消息流里的一条分隔线，进行中时文字闪动。引擎自己压缩的写“自动”，收起的回合里也在。
 */
function CompactionPart({ part }: { part: ChatPartOf<'compaction'> }) {
  const running = part.status === 'running';
  const auto = part.trigger === 'auto';
  const label = running
    ? t(auto ? 'compaction.autoRunning' : 'compaction.running')
    : t(auto ? 'compaction.autoDone' : 'compaction.done');
  return (
    <div
      className="my-3 flex items-center gap-3 text-sm text-muted-foreground"
      data-compaction={part.status}
      data-compaction-trigger={part.trigger}
    >
      <span aria-hidden className="h-px min-w-6 flex-1 bg-border" />
      <span className="flex shrink-0 items-center gap-1.5">
        <FoldVertical aria-hidden className="size-3.5" />
        <span className={cn(running && 'shimmer')}>{label}</span>
      </span>
      <span aria-hidden className="h-px min-w-6 flex-1 bg-border" />
    </div>
  );
}

/**
 * 章节的开始（0.82.0，`wevir_mark_chapter`）：标题在左、横线向右。说明放在悬停提示里；目录（chapter-nav.tsx）按
 * `data-chapter-anchor` 找到它滚过去。
 */
function ChapterDivider({ part }: { part: ChatPartOf<'chapter'> }) {
  return (
    <div
      className="mt-6 mb-3 flex scroll-mt-4 items-center gap-3"
      data-chapter-anchor={part.key}
      title={part.summary}
    >
      <h3 className="min-w-0 shrink truncate text-sm font-medium text-foreground">{part.title}</h3>
      <span aria-hidden className="h-px min-w-6 flex-1 bg-border" />
    </div>
  );
}

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
  if (part.usageLimit !== undefined) return <UsageLimitCard part={part} />;
  const phala = part.category === 'provider' ? phalaErrorPresentation(part) : undefined;
  return (
    <div
      role="note"
      className="my-2 flex gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm"
    >
      <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0">
        <p className="font-medium text-destructive">
          {phala?.title ?? t(`engineError.category.${part.category}`)}
        </p>
        <p className="mt-0.5 font-mono text-xs break-words whitespace-pre-wrap">{part.message}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {phala?.hint ?? t(`engineError.hint.${part.category}`)}
        </p>
      </div>
    </div>
  );
}

function NoticePart({ part }: { part: ChatPartOf<'notice'> }) {
  const { notice } = part;
  if (notice.kind === 'handoff') return <HandoffNotice notice={notice} />;
  const text =
    notice.kind === 'moved'
      ? [t(notice.to === 'local' ? 'notice.movedToLocal' : 'notice.movedToWorktree'), notice.branch]
          .filter(Boolean)
          .join(' · ')
      : notice.kind === 'resumed'
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

/**
 * 换了来源的那一行（0.25.0）：新来源的标志与“已切换到 来源 · 模型”，点开是这次接力的详情。换目录（0.81.0）时同一来源新开的引擎
 * 会话写“已转到新的引擎会话”。
 */
function HandoffNotice({ notice }: { notice: HandoffNoticeOf }) {
  const data = useWorkbenchData();
  const accounts = useAccounts();
  const [open, setOpen] = useState(false);
  const providers = data.status === 'ready' ? data.providers : [];
  const provider = providers.find((candidate) => candidate.id === notice.providerId);
  const source = provider && sourceOf(provider);
  const label = modelLabel(providers, notice.providerId, notice.modelId, accounts);
  return (
    <div className="my-3 flex justify-center">
      <button
        type="button"
        className="flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        title={t('handoff.detail.open')}
        onClick={() => setOpen(true)}
        data-testid="handoff-notice"
        data-provider={notice.providerId}
        data-delivery={notice.delivery.status}
      >
        {provider ? (
          <ProviderLogo
            logo={source?.logo ?? providerLogo(provider)}
            fallback={label}
            className="size-3.5"
          />
        ) : (
          <ArrowLeftRight aria-hidden className="size-3.5" />
        )}
        {notice.fromProviderId === notice.providerId
          ? t('notice.handoffSameSource')
          : t('notice.handoff', { model: label })}
      </button>
      <HandoffDetailDialog
        notice={notice}
        target={label}
        from={modelLabel(providers, notice.fromProviderId, notice.fromModelId, accounts)}
        open={open}
        onOpenChange={setOpen}
      />
    </div>
  );
}
