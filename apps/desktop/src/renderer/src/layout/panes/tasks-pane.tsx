import type { ChatMessage, WevirClient } from '@wevir/client-sdk';
import type { HostProcess, SessionId, SubagentSummary, WorkspaceId } from '@wevir/protocol';
import { cn } from 'cn';
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  SearchX,
  Square,
  Terminal,
  Trash2,
} from 'lucide-react';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useParams } from 'react-router';
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
import { CopyButton } from '@/session/copy-button';
import { formatDuration, formatElapsedShort } from '@/session/format';
import { LiveIndicator, type LiveState } from '@/session/live-indicator';
import { PartsView } from '@/session/message-view';
import { SubagentAvatar } from '@/session/subagent-avatar';
import { modelLine, statusLabel, subagentTitle } from '@/session/subagent-model';
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
import { type PaneController, usePanes } from '../pane-controller';
import { PaneHeaderPortal, usePaneHeaderSlots } from '../pane-header';
import type { PaneContext } from '../pane-registry';
import { processKey } from '../process-model';
import { formatTokens } from '../rail-model';
import { type RailContext, registerRailCard } from '../session-rail';
import {
  clearFinishedTasks,
  expandTaskPart,
  setOpenProcess,
  useClearMark,
  useExpanded,
  useOpenProcess,
} from '../task-store';
import { groupProcesses, groupTasks, type TaskItem, taskKey, withoutCleared } from '../tasks-model';
import { useProcessList, useSessionProcesses } from '../use-processes';
import { ProcessDetail, ProcessPeek, StopDialog, statusOf } from './process-detail';

const NO_SUBAGENTS: readonly SubagentSummary[] = [];

/** “已完成”一组在 task-store.ts 展开状态里的名字。 */
const DONE_PART = 'done';

const childIds = (subagents: readonly SubagentSummary[]) =>
  subagents.map((summary) => summary.sessionId);

/**
 * “后台任务”窗格（U21，desktop-layout.md §15，照 Claude Code 的后台任务面板）：当前会话的子智能体与 Host 起的后台进程，“进行中”
 * 与默认收起的“已完成”两组，一项一张圆角卡片。子智能体的卡片点标题进入它的详情（URL 的 `agent/:childId`），窗格头换成返回与
 * 标题；它自己起的进程收在卡片下的“N 个任务”里。进程点一下在行内展开命令与输出的末尾，“完整输出”进入详情（task-store.ts）。
 * 窗格头另有“清除已完成”，只是不再列出，记录还在。
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

/**
 * 打开一个任务的详情：子智能体导航到它的 `agent/:childId`；进程记进 task-store.ts，正在看子智能体详情时先回到会话的地址。
 * 侧栏卡片与预览卡片里打开时另外显示“后台任务”窗格（`panes`）。
 */
export function useOpenTask(workspaceId: string, sessionId: string, panes?: PaneController) {
  const navigate = useNavigate();
  const { childId } = useParams();
  return {
    subagent: (summary: SubagentSummary) => {
      setOpenProcess(sessionId, undefined);
      navigate(paths.agent(workspaceId, sessionId, summary.sessionId));
    },
    process: (process: HostProcess) => {
      setOpenProcess(sessionId, processKey(process));
      if (childId !== undefined) navigate(paths.session(workspaceId, sessionId));
      panes?.open({ kind: 'tasks' });
    },
  };
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
  const openProcess = useOpenProcess(sessionId);
  const subagents = state?.transcript.subagents ?? NO_SUBAGENTS;
  const processes = useSessionProcesses(workspaceId, sessionId, true, childIds(subagents));
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
  if (openProcess !== undefined) {
    return (
      <ProcessTaskDetail
        key={openProcess}
        workspaceId={workspaceId}
        processKey={openProcess}
        onBack={() => setOpenProcess(sessionId, undefined)}
      />
    );
  }
  if (!loaded) return <Note>{t('common.loading')}</Note>;
  return (
    <TaskList
      workspaceId={workspaceId}
      sessionId={sessionId}
      subagents={subagents}
      processes={processes}
    />
  );
}

function TaskList({
  workspaceId,
  sessionId,
  subagents,
  processes,
}: {
  workspaceId: string;
  sessionId: SessionId;
  subagents: readonly SubagentSummary[];
  processes: readonly HostProcess[];
}) {
  const { open, done } = withoutCleared(groupTasks(subagents, processes), useClearMark(sessionId));
  const now = useNow(open.length > 0 ? 1000 : undefined);
  const [showDone, toggleDone] = useExpanded(sessionId, DONE_PART);
  const slots = usePaneHeaderSlots();
  const openTask = useOpenTask(workspaceId, sessionId);
  const stopSubagent = useSubagentStop();
  const { client } = useHostConnection();
  const [stopping, setStopping] = useState<HostProcess>();
  const [error, setError] = useState<string>();

  const clear = done.length > 0 && (
    <IconButton
      label={t('tasks.clearDone')}
      size="icon-xs"
      tooltipSide="bottom"
      onClick={() => clearFinishedTasks(sessionId, [...open, ...done])}
      data-testid="tasks-clear-done"
    >
      <Trash2 />
    </IconButton>
  );
  if (open.length === 0 && done.length === 0) return <Note>{t('tasks.empty')}</Note>;
  const list: ListContext = {
    sessionId,
    now,
    client,
    stopProcess: (process) => (canStop(process) ? () => setStopping(process) : undefined),
    openProcess: openTask.process,
  };
  const card = (item: TaskItem) =>
    item.kind === 'subagent' ? (
      <SubagentCard
        key={taskKey(item)}
        item={item}
        list={list}
        onOpen={() => openTask.subagent(item.summary)}
        onStop={
          stopSubagent.supported && item.summary.status === 'running'
            ? () => {
                setError(undefined);
                void stopSubagent.stop(item.summary.sessionId).then((failure) => {
                  if (failure) setError(t('tasks.stopFailed', { error: failure }));
                });
              }
            : undefined
        }
      />
    ) : (
      <li
        key={taskKey(item)}
        data-testid="task-item"
        data-kind="process"
        data-status={item.process.status}
        className={CARD}
      >
        <ProcessLine process={item.process} list={list} card />
      </li>
    );
  return (
    <ScrollArea className="h-full">
      {clear && <PaneHeaderPortal slot="actions">{clear}</PaneHeaderPortal>}
      <div className="space-y-5 px-3 pt-1 pb-3" data-testid="tasks-pane">
        {error && (
          <p
            role="alert"
            className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        {open.length > 0 && (
          <section aria-label={t('tasks.running', { count: open.length })}>
            <h3 className="flex h-7 items-center px-1 text-xs text-muted-foreground">
              {t('tasks.running', { count: open.length })}
            </h3>
            <ul className="space-y-2">{open.map(card)}</ul>
          </section>
        )}
        {done.length > 0 && (
          <section>
            <div className="flex h-7 items-center">
              <button
                type="button"
                aria-expanded={showDone}
                onClick={toggleDone}
                className="flex h-7 items-center gap-2 rounded-md px-1 text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:focus-ring"
                data-testid="tasks-done-toggle"
              >
                <Caret open={showDone} />
                {t('tasks.done', { count: done.length })}
              </button>
              <span className="flex-1" />
              {/* 窗格头是标签条时没有放按钮的地方，放在这一行。 */}
              {!slots.actions && clear}
            </div>
            <Collapse open={showDone}>
              <ul className="space-y-2 pt-1">{done.map(card)}</ul>
            </Collapse>
          </section>
        )}
      </div>
      {stopping && client && (
        <StopDialog
          client={client}
          process={processes.find((item) => processKey(item) === processKey(stopping)) ?? stopping}
          onClose={() => setStopping(undefined)}
        />
      )}
    </ScrollArea>
  );
}

function canStop(process: HostProcess): boolean {
  return process.status === 'running' && process.stopSignals.length > 0;
}

/** 列表里各层共用的：展开状态按会话记，用时每秒走，进程的停止与打开完整输出。 */
interface ListContext {
  sessionId: string;
  now: number;
  client: WevirClient | undefined;
  stopProcess: (process: HostProcess) => (() => void) | undefined;
  openProcess: (process: HostProcess) => void;
}

/** 一项一张浅灰底的圆角卡片（照 Claude Code），卡片里的几行之间隔一道底色的细缝。 */
const CARD = 'overflow-hidden rounded-xl bg-muted/60 dark:bg-muted';

/** 卡片里一行的悬停底色：比卡片深一档（深色时卡片已是 muted，再叠一层前景色）。 */
const ROW_HOVER = 'hover:bg-muted dark:hover:bg-foreground/[0.08]';

/** 卡片里的行贴着卡片边缘，外圈的焦点光会被裁掉，用内嵌的细线（theme.css 的 focus-ring 说明）。 */
const ROW_FOCUS =
  'outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring-soft focus-visible:ring-inset';

/** 展开收起的实心小三角，展开时朝下。 */
function Caret({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 8 8"
      className={cn(
        'size-2 shrink-0 fill-current transition-transform duration-200 ease-smooth',
        open && 'rotate-90',
      )}
    >
      <path d="M2 0.75 6.5 4 2 7.25Z" />
    </svg>
  );
}

/** 停止：浅灰底里的实心小方块、正文色，停止不是破坏性操作，悬停只加深底色。 */
function TaskStop({
  onStop,
  className,
  testId = 'task-stop',
}: {
  onStop: () => void;
  className?: string;
  testId?: string;
}) {
  return (
    <IconButton
      label={t('tasks.stop')}
      size="icon-xs"
      className={cn('bg-foreground/[0.06] hover:bg-foreground/10', className)}
      onClick={onStop}
      data-testid={testId}
    >
      <Square className="size-2.5 fill-current" />
    </IconButton>
  );
}

function Elapsed({ ms }: { ms: number }) {
  return (
    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
      {formatDuration(ms)}
    </span>
  );
}

/**
 * 子智能体的卡片：一行标题与 ›（点它进入详情），右边用时，进行中的有停止；失败与取消写出状态，在等审批的标出来。它自己起的
 * 后台进程在下面一行“N 个任务”，展开后分“进行中”“已完成”两组。
 */
function SubagentCard({
  item,
  list,
  onOpen,
  onStop,
}: {
  item: Extract<TaskItem, { kind: 'subagent' }>;
  list: ListContext;
  onOpen: () => void;
  onStop: (() => void) | undefined;
}) {
  const { summary, processes } = item;
  const running = summary.status === 'running';
  const end = running ? list.now : Date.parse(summary.endedAt ?? '') || list.now;
  const failed = summary.status === 'failed' || summary.status === 'cancelled';
  return (
    <li data-testid="task-item" data-kind="subagent" data-status={summary.status} className={CARD}>
      <div className="relative">
        <button
          type="button"
          onClick={onOpen}
          className={cn(
            'flex h-10 w-full min-w-0 items-center gap-1 px-3 text-left text-sm',
            ROW_HOVER,
            ROW_FOCUS,
          )}
        >
          <TruncatedText text={subagentTitle(summary)} className="min-w-0" />
          <ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-2 flex-1" />
          {running && summary.pendingApprovals.length > 0 && (
            <span className="mr-1 shrink-0 rounded-sm bg-warning/10 px-1.5 text-xs leading-5 font-medium text-warning">
              {t('subagent.awaitingApproval')}
            </span>
          )}
          {failed && (
            <span
              className={cn(
                'mr-1 shrink-0 text-xs',
                summary.status === 'failed' ? 'text-destructive' : 'text-muted-foreground',
              )}
            >
              {statusLabel(summary.status)}
            </span>
          )}
          <Elapsed ms={end - Date.parse(summary.startedAt)} />
          {onStop && <span aria-hidden className="w-7 shrink-0" />}
        </button>
        {onStop && <TaskStop onStop={onStop} className="absolute top-2 right-2.5" />}
      </div>
      {processes.length > 0 && (
        <ChildTasks owner={summary.sessionId} processes={processes} list={list} />
      )}
    </li>
  );
}

/** 卡片下的“▸ N 个任务”：展开后是“N 个进行中”“N 个已完成”两组，每组同样可展开。 */
function ChildTasks({
  owner,
  processes,
  list,
}: {
  owner: string;
  processes: readonly HostProcess[];
  list: ListContext;
}) {
  const [open, toggle] = useExpanded(list.sessionId, `children:${owner}`);
  const groups = groupProcesses(processes);
  return (
    <div className="border-t-2 border-background" data-testid="task-children">
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className={cn(
          'flex h-9 w-full items-center gap-2 px-3 text-left text-sm text-muted-foreground hover:text-foreground',
          ROW_HOVER,
          ROW_FOCUS,
        )}
      >
        <Caret open={open} />
        {t('tasks.children', { count: processes.length })}
      </button>
      <Collapse open={open}>
        <div className="pb-1.5 pl-3">
          {groups.open.length > 0 && (
            <ChildGroup
              part={`children:${owner}:open`}
              label={t('rail.tasks.running', { count: groups.open.length })}
              processes={groups.open}
              list={list}
            />
          )}
          {groups.done.length > 0 && (
            <ChildGroup
              part={`children:${owner}:done`}
              label={t('rail.tasks.done', { count: groups.done.length })}
              processes={groups.done}
              list={list}
            />
          )}
        </div>
      </Collapse>
    </div>
  );
}

function ChildGroup({
  part,
  label,
  processes,
  list,
}: {
  part: string;
  label: string;
  processes: readonly HostProcess[];
  list: ListContext;
}) {
  const [open, toggle] = useExpanded(list.sessionId, part);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="flex h-8 items-center gap-2 rounded-md px-3 text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:focus-ring"
      >
        <Caret open={open} />
        {label}
      </button>
      <Collapse open={open}>
        <ul className="pl-3">
          {processes.map((process) => (
            <li key={processKey(process)}>
              <ProcessLine process={process} list={list} />
            </li>
          ))}
        </ul>
      </Collapse>
    </div>
  );
}

/**
 * 一个后台进程：▸、名字，右边用时（非零退出与起不来的写出状态），在跑的有停止；点一下在行内展开 `$ 命令` 与输出的末尾（照
 * Claude Code），下面“完整输出”进入详情。`card` 是列表里单独成卡片的（这个会话自己的进程），否则是子智能体卡片下的一行。
 */
function ProcessLine({
  process,
  list,
  card = false,
}: {
  process: HostProcess;
  list: ListContext;
  card?: boolean;
}) {
  const [open, toggle] = useExpanded(list.sessionId, `process:${processKey(process)}`);
  const running = process.status === 'running';
  const status = statusOf(process);
  const end = process.endedAt === undefined ? list.now : Date.parse(process.endedAt);
  const onStop = list.stopProcess(process);
  return (
    <div data-testid="task-process" data-status={process.status}>
      <div className="relative">
        <button
          type="button"
          aria-expanded={open}
          onClick={toggle}
          className={cn(
            'flex w-full min-w-0 items-center gap-2 text-left text-sm',
            card ? 'h-10 px-3' : 'h-8 rounded-md px-3',
            ROW_HOVER,
            ROW_FOCUS,
          )}
        >
          <span className="flex text-muted-foreground">
            <Caret open={open} />
          </span>
          <TruncatedText text={process.name} className="min-w-0" />
          <span className="min-w-2 flex-1" />
          {!running && status.tone === 'danger' && (
            <span className="mr-1 shrink-0 text-xs text-destructive">{status.label}</span>
          )}
          <Elapsed ms={end - Date.parse(process.startedAt)} />
          {onStop && <span aria-hidden className="w-7 shrink-0" />}
        </button>
        {onStop && (
          <TaskStop
            onStop={onStop}
            className={cn('absolute right-2.5', card ? 'top-2' : 'top-1')}
          />
        )}
      </div>
      <Collapse open={open}>
        <div className="pr-3 pb-2 pl-7">
          {list.client && <ProcessPeek client={list.client} process={process} />}
          <button
            type="button"
            onClick={() => list.openProcess(process)}
            className="mt-1.5 flex items-center gap-0.5 rounded-sm text-xs text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:focus-ring"
            data-testid="task-process-open"
          >
            {t('tasks.fullOutput')}
            <ChevronRight aria-hidden className="size-3" />
          </button>
        </div>
      </Collapse>
    </div>
  );
}

// ── 详情 ────────────────────────────────────────────────────────────

/** 详情的窗格头：‹ 返回与标题（窗格头是标签条时画在内容顶上），“⋯”左边可以另放按钮。 */
function DetailHeader({
  title,
  onBack,
  actions,
}: {
  title: string;
  onBack: () => void;
  actions?: ReactNode;
}) {
  const slots = usePaneHeaderSlots();
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
    <>
      {slots.title ? (
        createPortal(header, slots.title)
      ) : (
        <div className="flex h-9 shrink-0 items-center gap-1 px-1.5 text-sm">
          {header}
          <span className="flex-1" />
          {!slots.actions && actions}
        </div>
      )}
      {actions && <PaneHeaderPortal slot="actions">{actions}</PaneHeaderPortal>}
    </>
  );
}

function StopButton({ onStop }: { onStop: () => void }) {
  return (
    <IconButton
      label={t('tasks.stop')}
      size="icon-xs"
      tooltipSide="bottom"
      onClick={onStop}
      data-testid="task-detail-stop"
    >
      <Square className="size-2.5 fill-current" />
    </IconButton>
  );
}

/**
 * 一个子智能体（照 Claude Code 的任务详情）：窗格头是返回与标题（进行中的另有停止）；正文先是交给它的任务描述（父 agent 给的
 * 第一条输入，灰底块，过长时“显示更多”）与模型，然后是它的过程（工作组折成一行摘要，夹着叙述与回答），父 agent 后来发给它的
 * 消息同样是灰底块；运行中末尾是状态圈。它的审批在底部也能处理，父会话的输入框上方同样有。
 */
function TaskDetail({ summary, onBack }: { summary: SubagentSummary; onBack: () => void }) {
  const { client, identity } = useHostConnection();
  const state = useTranscript(summary.sessionId);
  const stop = useSubagentStop();
  const transcript = state?.transcript;
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
  return (
    <div className="flex h-full min-h-0 flex-col" data-task-detail={summary.sessionId}>
      <DetailHeader
        title={subagentTitle(summary)}
        onBack={onBack}
        actions={
          stop.supported &&
          summary.status === 'running' && (
            <StopButton onStop={() => void stop.stop(summary.sessionId)} />
          )
        }
      />
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

/**
 * 一个后台进程：窗格头是返回与进程名（在跑的另有停止，打开停止对话框选信号）；正文是命令、目录、来源与输出。按工作区读进程，
 * 预览卡片打开的别的会话的预览进程也找得到。
 */
function ProcessTaskDetail({
  workspaceId,
  processKey: key,
  onBack,
}: {
  workspaceId: string;
  processKey: string;
  onBack: () => void;
}) {
  const { client } = useHostConnection();
  const usable = client?.supports('process_output') ? client : undefined;
  const { processes } = useProcessList(usable, { workspaceId: workspaceId as WorkspaceId });
  const process = processes?.find((item) => processKey(item) === key);
  const [stopping, setStopping] = useState(false);
  if (!usable || !process) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <DetailHeader title={t('pane.kind.processes')} onBack={onBack} />
        <div className="min-h-0 flex-1">
          <Note>{t(processes === undefined && usable ? 'common.loading' : 'processes.gone')}</Note>
        </div>
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col" data-task-detail={key}>
      <DetailHeader
        title={process.name}
        onBack={onBack}
        actions={canStop(process) && <StopButton onStop={() => setStopping(true)} />}
      />
      <ProcessDetail client={usable} process={process} sessionTitle={undefined} />
      {stopping && (
        <StopDialog client={usable} process={process} onClose={() => setStopping(false)} />
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
  const tokens = useChildTokens(summary.sessionId, running);
  return (
    <div className="space-y-3 text-sm">
      {promptMessage && prompt && (
        <div>
          <PromptBlock id={promptMessage.id} text={prompt} />
          <CopyButton text={prompt} className="mt-1 -ml-1 text-muted-foreground" />
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {t('tasks.detail.model', { model: modelLine(summary) })}
        {!running && tokens !== undefined && (
          <>
            {' · '}
            {t('tasks.tokens', { tokens: formatTokens(tokens) })}
          </>
        )}
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

const RAIL_ROW =
  '-mx-1.5 flex h-7 w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 text-left outline-none transition-colors focus-visible:focus-ring';

function taskIcon(item: TaskItem): ReactNode {
  return item.kind === 'subagent' ? (
    <SubagentAvatar sessionId={item.summary.sessionId} status={item.summary.status} size={16} />
  ) : (
    <Terminal aria-hidden className="size-4 shrink-0 text-muted-foreground" />
  );
}

/**
 * 进行中的子智能体与后台进程各一行（各自的图标、标题、只到分钟的用时、停止），整行点开它的详情；下面一行“N 个已完成”打开“后台
 * 任务”窗格并展开“已完成”。标题被截断时悬停显示全文。
 */
function useTasksCard({ sessionId, entry, visible }: RailContext) {
  const panes = usePanes();
  const state = useTranscript(sessionId);
  const subagents = state?.transcript.subagents ?? NO_SUBAGENTS;
  const processes = useSessionProcesses(
    entry.workspace.id,
    sessionId,
    visible,
    childIds(subagents),
  );
  const { open, done } = withoutCleared(groupTasks(subagents, processes), useClearMark(sessionId));
  const now = useNow(open.length > 0 ? 1000 : undefined);
  const stopSubagent = useSubagentStop();
  const openTask = useOpenTask(entry.workspace.id, sessionId, panes);
  const { client } = useHostConnection();
  const [stopping, setStopping] = useState<HostProcess>();
  if (open.length === 0 && done.length === 0) return null;
  const counts = [
    open.length > 0 && t('rail.tasks.running', { count: open.length }),
    done.length > 0 && t('rail.tasks.done', { count: done.length }),
  ].filter(Boolean);
  const latestDone = done[0];
  return {
    summary: counts.join(' · '),
    details: (
      <ul data-testid="rail-tasks">
        {open.map((item) => {
          const onStop =
            item.kind === 'subagent'
              ? stopSubagent.supported && item.summary.status === 'running'
                ? () => void stopSubagent.stop(item.summary.sessionId)
                : undefined
              : canStop(item.process)
                ? () => setStopping(item.process)
                : undefined;
          const title = item.kind === 'subagent' ? subagentTitle(item.summary) : item.process.name;
          const startedAt =
            item.kind === 'subagent' ? item.summary.startedAt : item.process.startedAt;
          return (
            <li key={taskKey(item)} className="group/task relative" data-kind={item.kind}>
              <button
                type="button"
                onClick={() =>
                  item.kind === 'subagent'
                    ? openTask.subagent(item.summary)
                    : openTask.process(item.process)
                }
                className={cn(RAIL_ROW, 'group-hover/task:bg-muted')}
              >
                {taskIcon(item)}
                <TruncatedText text={title} className="min-w-0 flex-1" />
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {formatElapsedShort(now - Date.parse(startedAt))}
                </span>
                {onStop && <span aria-hidden className="w-5 shrink-0" />}
              </button>
              {onStop && (
                <IconButton
                  label={t('tasks.stop')}
                  size="icon-xs"
                  className="absolute top-0.5 -right-1"
                  onClick={onStop}
                  data-testid="rail-task-stop"
                >
                  <Square className="size-2.5 fill-current" />
                </IconButton>
              )}
            </li>
          );
        })}
        {latestDone && (
          <li>
            <button
              type="button"
              onClick={() => {
                expandTaskPart(sessionId, DONE_PART);
                panes?.open({ kind: 'tasks' });
              }}
              className={cn(RAIL_ROW, 'text-muted-foreground hover:bg-muted hover:text-foreground')}
              data-testid="rail-tasks-done"
            >
              {taskIcon(latestDone)}
              <span className="min-w-0 flex-1 truncate">
                {t('rail.tasks.done', { count: done.length })}
              </span>
            </button>
          </li>
        )}
        {stopping && client && (
          <StopDialog
            client={client}
            process={
              processes.find((item) => processKey(item) === processKey(stopping)) ?? stopping
            }
            onClose={() => setStopping(undefined)}
          />
        )}
      </ul>
    ),
  };
}

registerRailCard({ id: 'tasks', order: 40, title: () => t('rail.tasks'), useCard: useTasksCard });
