import type { ChatMessage } from '@wevir/client-sdk';
import type { SessionId, SubagentSummary } from '@wevir/protocol';
import { cn } from 'cn';
import {
  Activity,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  SearchX,
  Square,
  Trash2,
} from 'lucide-react';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router';
import { Collapse } from '@/components/collapse';
import { EmptyState } from '@/components/empty-state';
import { IconButton } from '@/components/icon-button';
import { TruncatedText } from '@/components/truncated-text';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useChildTokens, useSubagentStop } from '@/data/subagent-control';
import { useTranscript } from '@/data/workbench-data';
import { useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { paths } from '@/routes/paths';
import { ApprovalDock } from '@/session/approval-card';
import { clearFinishedTasks, useVisibleSubagents } from '@/session/cleared-tasks';
import { formatDuration } from '@/session/format';
import { LiveIndicator, type LiveState } from '@/session/live-indicator';
import { PartsView } from '@/session/message-view';
import { SubagentAvatar } from '@/session/subagent-avatar';
import { groupSubagents, modelLine, statusLabel, subagentTitle } from '@/session/subagent-model';
import { groupWork } from '@/session/tool-model';
import {
  FOCUS_HIGHLIGHT,
  FOCUS_HIGHLIGHT_MS,
  findTextRange,
  transcriptFocus,
} from '@/session/transcript-focus';
import { messageIndexForSeq } from '@/session/turn-model';
import { useNow } from '@/session/use-now';
import { WorkspaceRoot } from '@/session/work-group';
import { usePanes } from '../pane-controller';
import { PaneHeaderPortal, usePaneHeaderSlots } from '../pane-header';
import type { PaneContext } from '../pane-registry';
import { formatTokens } from '../rail-model';
import { type RailContext, registerRailCard } from '../session-rail';

const NO_SUBAGENTS: readonly SubagentSummary[] = [];

/**
 * “后台任务”窗格（U21，desktop-layout.md §15）：当前会话的子会话，“进行中”与可收起的“已完成”两组平铺的行；点一行在窗格里
 * 进入它的详情（URL 的 `agent/:childId`），窗格头换成返回与任务标题。窗格头另有“清除已完成”，只是不再列出，记录还在。
 */
export function TasksPane({ context }: { context: PaneContext }) {
  const { entry, sessionId, childId } = context;
  if (!entry || sessionId === undefined) {
    return <Note>{t('tasks.noSession')}</Note>;
  }
  return (
    <WorkspaceRoot value={entry.workspace.rootPath}>
      <SessionTasks
        workspaceId={entry.workspace.id}
        sessionId={sessionId as SessionId}
        childId={childId}
      />
    </WorkspaceRoot>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <Activity aria-hidden className="size-6 stroke-[1.5] text-muted-foreground" />
      <p className="max-w-64 text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

function SessionTasks({
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
  const subagents = state?.transcript.subagents ?? NO_SUBAGENTS;
  const loaded = state !== undefined && (state.caughtUp || state.transcript.lastSeq > 0);

  if (childId !== undefined) {
    // 清除过的也能从链接（搜索、用量记录）进来。
    const summary = subagents.find((item) => item.sessionId === childId);
    const back = () => navigate(paths.session(workspaceId, sessionId));
    if (summary) return <TaskDetail key={summary.sessionId} summary={summary} onBack={back} />;
    // 回放还没追平时它可能还没出现；追平之后还没有就是“未找到”，只在这个窗格里说（§5.2 第 4 条）。
    if (!state?.caughtUp) return <Note>{t('common.loading')}</Note>;
    return (
      <EmptyState
        icon={<SearchX />}
        title={t('subagent.detail.notFoundTitle')}
        action={
          <Button variant="outline" size="sm" onClick={back}>
            {t('tasks.detail.back')}
          </Button>
        }
      >
        {t('subagent.detail.notFound', { id: childId })}
      </EmptyState>
    );
  }
  if (!loaded) return <Note>{t('common.loading')}</Note>;
  return (
    <TaskList
      sessionId={sessionId}
      subagents={subagents}
      onOpen={(summary) => navigate(paths.agent(workspaceId, sessionId, summary.sessionId))}
    />
  );
}

function TaskList({
  sessionId,
  subagents,
  onOpen,
}: {
  sessionId: SessionId;
  subagents: readonly SubagentSummary[];
  onOpen: (summary: SubagentSummary) => void;
}) {
  const visible = useVisibleSubagents(sessionId, subagents);
  const { open, done } = groupSubagents(visible);
  const now = useNow(open.length > 0 ? 1000 : undefined);
  const [showDone, setShowDone] = useState(true);
  const slots = usePaneHeaderSlots();
  const stop = useSubagentStop();
  const [error, setError] = useState<string>();

  const clear = done.length > 0 && (
    <IconButton
      label={t('tasks.clearDone')}
      size="icon-xs"
      tooltipSide="bottom"
      onClick={() => clearFinishedTasks(sessionId, visible)}
      data-testid="tasks-clear-done"
    >
      <Trash2 />
    </IconButton>
  );
  if (visible.length === 0) return <Note>{t('tasks.empty')}</Note>;
  const row = (summary: SubagentSummary) => (
    <TaskRow
      key={summary.sessionId}
      summary={summary}
      now={now}
      onOpen={() => onOpen(summary)}
      onStop={
        stop.supported && summary.status === 'running'
          ? () => {
              setError(undefined);
              void stop.stop(summary.sessionId).then((failure) => {
                if (failure) setError(t('tasks.stopFailed', { error: failure }));
              });
            }
          : undefined
      }
    />
  );
  return (
    <ScrollArea className="h-full">
      {clear && <PaneHeaderPortal slot="actions">{clear}</PaneHeaderPortal>}
      <div className="space-y-3 px-2 pt-1 pb-3" data-testid="tasks-pane">
        {error && (
          <p
            role="alert"
            className="mx-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        {open.length > 0 && (
          <section aria-label={t('tasks.running', { count: open.length })}>
            <h3 className="flex h-6 items-center px-2 text-xs text-muted-foreground">
              {t('tasks.running', { count: open.length })}
            </h3>
            <ul className="divide-y divide-border">{open.map(row)}</ul>
          </section>
        )}
        {done.length > 0 && (
          <section>
            <div className="flex h-6 items-center px-1">
              <button
                type="button"
                aria-expanded={showDone}
                onClick={() => setShowDone((value) => !value)}
                className="flex h-6 items-center gap-1 rounded-md px-1 text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:focus-ring"
              >
                {t('tasks.done', { count: done.length })}
                <ChevronDown
                  aria-hidden
                  className={cn(
                    'size-3.5 transition-transform duration-200 ease-smooth',
                    !showDone && '-rotate-90',
                  )}
                />
              </button>
              <span className="flex-1" />
              {/* 窗格头是标签条时没有放按钮的地方，放在这一行。 */}
              {!slots.actions && clear}
            </div>
            <Collapse open={showDone}>
              <ul className="divide-y divide-border">{done.map(row)}</ul>
            </Collapse>
          </section>
        )}
      </div>
    </ScrollArea>
  );
}

/**
 * 一行：标题，下一行模型（已完成的还有 token），右边用时；进行中的有停止（实心方块、正文色，停止不是破坏性操作，悬停只加
 * 底色），已完成的是 ›。
 */
function TaskRow({
  summary,
  now,
  onOpen,
  onStop,
}: {
  summary: SubagentSummary;
  now: number;
  onOpen: () => void;
  onStop: (() => void) | undefined;
}) {
  const running = summary.status === 'running';
  const tokens = useChildTokens(summary.sessionId, running);
  const end = running ? now : Date.parse(summary.endedAt ?? '') || now;
  const failed = summary.status === 'failed' || summary.status === 'cancelled';
  const waiting = running && summary.pendingApprovals.length > 0;
  const meta = [
    summary.modelId,
    !running && tokens !== undefined && t('tasks.tokens', { tokens: formatTokens(tokens) }),
  ].filter(Boolean);
  return (
    <li
      data-testid="task-item"
      data-status={summary.status}
      className="group/task relative flex items-center py-px"
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-1.5 text-left outline-none transition-colors group-hover/task:bg-muted focus-visible:focus-ring"
      >
        <span className="min-w-0 flex-1">
          <TruncatedText text={subagentTitle(summary)} className="block text-sm" />
          <span className="mt-0.5 block truncate text-xs text-muted-foreground">
            {meta.join(' · ')}
            {failed && (
              <span className={summary.status === 'failed' ? 'text-destructive' : undefined}>
                {meta.length > 0 && ' · '}
                {statusLabel(summary.status)}
              </span>
            )}
          </span>
        </span>
        {waiting && (
          <span className="shrink-0 rounded-sm bg-warning/10 px-1.5 text-xs leading-5 font-medium text-warning">
            {t('subagent.awaitingApproval')}
          </span>
        )}
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {formatDuration(end - Date.parse(summary.startedAt))}
        </span>
        {running ? (
          onStop && <span aria-hidden className="w-5 shrink-0" />
        ) : (
          <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        )}
      </button>
      {onStop && (
        <IconButton
          label={t('tasks.stop')}
          size="icon-xs"
          className="absolute right-1.5"
          onClick={onStop}
          data-testid="task-stop"
        >
          <Square className="size-2.5 fill-current" />
        </IconButton>
      )}
    </li>
  );
}

// ── 详情 ────────────────────────────────────────────────────────────

/**
 * 一个后台任务（照 Claude Code 的任务详情）：窗格头是返回与标题；正文先是交给它的任务描述（父 agent 给的第一条输入，灰底块，
 * 过长时“显示更多”）与模型，然后是它的过程（工作组折成一行摘要，夹着叙述与回答），父 agent 后来发给它的消息同样是灰底块；
 * 运行中末尾是状态圈。它的审批在底部也能处理，父会话的输入框上方同样有。
 */
function TaskDetail({ summary, onBack }: { summary: SubagentSummary; onBack: () => void }) {
  const { client, identity } = useHostConnection();
  const state = useTranscript(summary.sessionId);
  const slots = usePaneHeaderSlots();
  const transcript = state?.transcript;
  const title = subagentTitle(summary);
  const body = useRef<HTMLDivElement>(null);
  // 搜索结果（transcript-focus.ts）：子会话的消息流追到那个事件之后滚到那条消息、高亮命中的文字。
  const focus = transcriptFocus.use();
  useEffect(() => {
    if (focus?.sessionId !== summary.sessionId || !transcript || transcript.lastSeq < focus.seq) {
      return;
    }
    transcriptFocus.set(undefined);
    const message = transcript.messages[messageIndexForSeq(transcript.messages, focus.seq)];
    if (!message) return;
    // 不随 effect 清理：认领后 focus 就清掉了，清理会取消这一步。
    window.setTimeout(() => {
      const element = body.current?.querySelector(
        `[data-chat-message="${CSS.escape(message.id)}"]`,
      );
      if (!element) return;
      const range = focus.text === undefined ? undefined : findTextRange(element, focus.text);
      (range?.startContainer.parentElement ?? element).scrollIntoView({ block: 'center' });
      if (range && typeof Highlight !== 'undefined' && CSS.highlights) {
        CSS.highlights.set(FOCUS_HIGHLIGHT, new Highlight(range));
        window.setTimeout(() => CSS.highlights.delete(FOCUS_HIGHLIGHT), FOCUS_HIGHLIGHT_MS);
      }
    }, 50);
  }, [focus, summary.sessionId, transcript]);
  const header = (
    <div className="flex min-w-0 items-center gap-1">
      <IconButton
        label={t('tasks.detail.back')}
        size="icon-xs"
        onClick={onBack}
        tooltipSide="bottom"
      >
        <ChevronLeft />
      </IconButton>
      <h2 className="flex min-w-0 font-medium">
        <TruncatedText text={title} />
      </h2>
    </div>
  );
  return (
    <div className="flex h-full min-h-0 flex-col" data-task-detail={summary.sessionId}>
      {slots.title ? (
        createPortal(header, slots.title)
      ) : (
        <div className="flex h-9 shrink-0 items-center px-1.5 text-sm">{header}</div>
      )}
      <ScrollArea className="min-h-0 flex-1">
        <div ref={body} className="px-4 pt-1 pb-4">
          {state?.error ? (
            <p className="py-8 text-center text-sm text-destructive">
              {t('subagent.detail.failed', { error: state.error })}
            </p>
          ) : transcript && (state.caughtUp || transcript.lastSeq > 0) ? (
            <TaskProcess
              summary={summary}
              messages={transcript.messages}
              activeTurnId={transcript.activeTurnId}
              live={
                transcript.pendingApprovals.length > 0
                  ? 'awaiting'
                  : transcript.pendingQuestions.length > 0
                    ? 'input'
                    : 'running'
              }
            />
          ) : (
            <p className="py-8 text-center text-sm text-muted-foreground">{t('common.loading')}</p>
          )}
        </div>
      </ScrollArea>
      {transcript && transcript.pendingApprovals.length > 0 && (
        <div className="shrink-0 px-3 pb-3">
          <ApprovalDock transcript={transcript} client={client} self={identity} />
        </div>
      )}
    </div>
  );
}

function TaskProcess({
  summary,
  messages,
  activeTurnId,
  live,
}: {
  summary: SubagentSummary;
  messages: readonly ChatMessage[];
  activeTurnId: string | undefined;
  live: LiveState;
}) {
  const running = summary.status === 'running';
  const firstUser = messages.findIndex((message) => message.role === 'user');
  const promptMessage = firstUser >= 0 ? messages[firstUser] : undefined;
  const prompt = messageText(promptMessage);
  const shown = messages.filter(
    (message, index): message is Exclude<ChatMessage, { role: 'system' }> =>
      index !== firstUser && message.role !== 'system',
  );
  const last = shown.at(-1);
  const lastAssistant = shown.findLast((message) => message.role === 'assistant');
  // 进行中：最后一项是工作组时它自己显示当前动作，否则末尾另起状态圈（同 turn-view.tsx）。
  const tailIsWork = last?.role === 'assistant' && groupWork(last.parts).at(-1)?.kind === 'work';
  const failed = summary.status === 'failed' || summary.status === 'cancelled';
  return (
    <div className="space-y-3 text-sm">
      {promptMessage && prompt && <PromptBlock id={promptMessage.id} text={prompt} />}
      <p className="text-xs text-muted-foreground">
        {t('tasks.detail.model', { model: modelLine(summary) })}
        {failed && (
          <span className={summary.status === 'failed' ? 'text-destructive' : undefined}>
            {' · '}
            {statusLabel(summary.status)}
          </span>
        )}
      </p>
      {shown.map((message) =>
        message.role === 'user' ? (
          <PromptBlock key={message.id} id={message.id} text={messageText(message)} />
        ) : (
          <div key={message.id} data-chat-message={message.id}>
            <PartsView
              parts={message.parts}
              turnActive={running && message.turnId === activeTurnId}
              {...(running && message === lastAssistant && message === last && { live })}
            />
          </div>
        ),
      )}
      {running && !tailIsWork && (
        <div className="flex min-h-6 items-center" data-live-line={live}>
          <LiveIndicator state={live} />
        </div>
      )}
    </div>
  );
}

function messageText(message: ChatMessage | undefined): string {
  if (!message) return '';
  return message.parts
    .flatMap((part) => (part.type === 'text' ? [part.text] : []))
    .join('\n\n')
    .trim();
}

/** 交给子智能体的话：灰底圆角块，超过六行收起，“显示更多”展开。 */
function PromptBlock({ id, text }: { id: string; text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || expanded) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded]);
  return (
    <div className="rounded-lg bg-muted px-3 py-2" data-task-prompt data-chat-message={id}>
      <p ref={ref} className={cn('break-words whitespace-pre-wrap', !expanded && 'line-clamp-6')}>
        {text}
      </p>
      {(overflows || expanded) && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 rounded-sm text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:focus-ring"
        >
          {t(expanded ? 'tasks.detail.showLess' : 'tasks.detail.showMore')}
        </button>
      )}
    </div>
  );
}

// ── 会话侧栏的“后台任务”卡片（U18，desktop-layout.md §12） ─────────────────────────────────

/**
 * 进行中的子会话各一行（头像、标题、走动的用时、停止），整行点开它的详情；下面一行“N 个已完成”打开“后台任务”窗格。
 * 标题被截断时悬停显示全文。
 */
function useTasksCard({ sessionId, entry }: RailContext) {
  const panes = usePanes();
  const navigate = useNavigate();
  const state = useTranscript(sessionId);
  const visible = useVisibleSubagents(sessionId, state?.transcript.subagents ?? NO_SUBAGENTS);
  const { open, done } = groupSubagents(visible);
  const now = useNow(open.length > 0 ? 1000 : undefined);
  const stop = useSubagentStop();
  if (visible.length === 0) return null;
  const counts = [
    open.length > 0 && t('rail.tasks.running', { count: open.length }),
    done.length > 0 && t('rail.tasks.done', { count: done.length }),
  ].filter(Boolean);
  const rowClass =
    '-mx-1.5 flex h-7 w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 text-left outline-none transition-colors focus-visible:focus-ring';
  return {
    summary: counts.join(' · '),
    details: (
      <ul data-testid="rail-tasks">
        {open.map((summary) => (
          <li key={summary.sessionId} className="group/task relative">
            <button
              type="button"
              onClick={() =>
                navigate(paths.agent(entry.workspace.id, sessionId, summary.sessionId))
              }
              className={cn(rowClass, 'group-hover/task:bg-muted')}
            >
              <SubagentAvatar sessionId={summary.sessionId} status={summary.status} size={16} />
              <TruncatedText text={subagentTitle(summary)} className="min-w-0 flex-1" />
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {formatDuration(now - Date.parse(summary.startedAt))}
              </span>
              {stop.supported && <span aria-hidden className="w-5 shrink-0" />}
            </button>
            {stop.supported && (
              <IconButton
                label={t('tasks.stop')}
                size="icon-xs"
                className="absolute top-0.5 -right-1"
                onClick={() => void stop.stop(summary.sessionId)}
                data-testid="rail-task-stop"
              >
                <Square className="size-2.5 fill-current" />
              </IconButton>
            )}
          </li>
        ))}
        {done.length > 0 && (
          <li>
            <button
              type="button"
              onClick={() => panes?.open({ kind: 'tasks' })}
              className={cn(rowClass, 'text-muted-foreground hover:bg-muted hover:text-foreground')}
              data-testid="rail-tasks-done"
            >
              <SubagentAvatar
                sessionId={done[0]?.sessionId ?? sessionId}
                status="completed"
                size={16}
              />
              <span className="min-w-0 flex-1 truncate">
                {t('rail.tasks.done', { count: done.length })}
              </span>
            </button>
          </li>
        )}
      </ul>
    ),
  };
}

registerRailCard({ id: 'tasks', order: 40, title: () => t('rail.tasks'), useCard: useTasksCard });
