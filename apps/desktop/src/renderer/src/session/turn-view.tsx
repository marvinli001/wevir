import type { ChatMessage } from '@wevir/client-sdk';
import type { PendingMessage, TurnId, TurnOutcome } from '@wevir/protocol';
import { cn } from 'cn';
import { ChevronRight, CircleAlert, CircleCheck, CircleX, LoaderCircle } from 'lucide-react';
import { Fragment, memo, useContext, useEffect, useId, useRef } from 'react';
import type { OrbState } from 'thinking-orbs';
import { turnChangeStats } from '@/changes/changes-model';
import { Collapse } from '@/components/collapse';
import { GlideGroup } from '@/components/glide';
import { t } from '@/i18n';
import { CopyButton } from './copy-button';
import { Elapsed } from './elapsed';
import { useFold, useFoldSetter } from './fold-state';
import { AWAITING_PILL, LiveIndicator, type LiveState, TurnOrb } from './live-indicator';
import { BranchButton, useMessageActions } from './message-actions';
import { PartsView, PendingSteerMessage, RelativeTime, UserMessage } from './message-view';
import { PendingNoticeLine } from './pending-area';
import { visibleParts } from './subagent-model';
import { TurnTodoCard } from './todo-card';
import { turnTodos } from './todo-model';
import { editStats, groupWork } from './tool-model';
import { OpenTurnChanges } from './turn-changes';
import {
  filesAfterAnswer,
  finalAnswer,
  foldSegments,
  foldTurn,
  type TurnFold,
  turnHeaderText,
} from './turn-model';
import { type ChecksSummary, TURN_CHECK_LABELS } from './verification-model';
import { DiffStat } from './work-group';
import { WrapUpCard } from './wrap-up-card';
import { turnWrapUp } from './wrap-up-model';

const NO_STEERS: readonly PendingMessage[] = [];

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

const HEADER_TONES: Record<TurnOutcome, string> = {
  completed: '',
  failed: 'text-destructive',
  cancelled: '',
  interrupted: 'text-warning',
};

/**
 * 一个回合（U2，照 Codex 桌面端 design-refs/10–12）：用户消息、助手消息与中间的插话。正常完成的回合默认把过程收进一行
 * “已处理 2 分 31 秒”，只留最后的回答、错误与插话，回答下面是“N 个文件已更改”；出错、被停止、被中断的回合不自动收起，
 * 那一行写“出错 · 用时”等。有那一行时过程按段（turn-model.ts 的 foldSegments）放进 Collapse，点开、收起与回合结束时的
 * 自动收起都有高度过渡，留下的回答不动。进行中的回合末尾是当前动作那一行。按消息的对象身份 memo：投影只为改动过的消息
 * 换新对象，流式输出时只有进行中的回合重画。
 */
export const TurnView = memo(
  function TurnView({
    turnId,
    messages,
    turnActive,
    live,
    orb = 'working',
    hasSubagents,
    runningSubagents = 0,
    lastTurn = false,
    laterTurn = false,
    steers = NO_STEERS,
    notices = NO_STEERS,
    checks,
  }: {
    turnId: TurnId;
    messages: readonly ChatMessage[];
    turnActive: boolean;
    /** 会话正在进行这个回合时的状态。 */
    live?: LiveState;
    /** 进行中的回合的 thinking orb（fx/orb-state.ts 的 turnOrb）。 */
    orb?: OrbState;
    /** 会话派出过子会话：collab 工具调用不显示（subagent-model.ts 的 visibleParts）。 */
    hasSubagents: boolean;
    /** 进行中的子会话数：写在清单进行中那一项下面（todo-card.tsx）。 */
    runningSubagents?: number;
    /** 会话最后一个回合：回答下面的操作行一直显示（照 Codex 桌面端），别的回合悬停时才出现。 */
    lastTurn?: boolean;
    /** 后面还有回合（用户在这之后发过消息）：回合末的下一步卡片不再画。 */
    laterTurn?: boolean;
    /** 进行中的回合：交给模型、还没插进来的插话，画在末尾（当前动作那一行之前）。 */
    steers?: readonly PendingMessage[];
    /** 进行中的回合：别的会话与后台进程发来、等回合结束再交给模型的消息，画在插话之后（pending-area.tsx）。 */
    notices?: readonly PendingMessage[];
    /** 这个回合触发的最近一轮检查（0.65.0）。 */
    checks?: ChecksSummary;
  }) {
    const fold = foldTurn(messages, hasSubagents, turnActive);
    // 回合的清单画在回合末尾、当前动作那一行之前（照 Claude Code）；回合结束收起过程时一起收起。
    const todos = turnTodos(messages, turnId, turnActive);
    const { checkpoints } = useContext(OpenTurnChanges);
    const changes = turnChangeStats(
      checkpoints?.find((turn) => turn.turnId === turnId),
      fold.changes,
    );
    const { branch } = useMessageActions();
    const [open, setOpen] = useFold(`turn:${turnId}`, !fold.defaultFolded);
    const folded = fold.showHeader && !open;
    const id = useId();
    // 这个回合在本视图里刚结束（上一次画的时候还没有那一行）：过程先以展开的样子挂进分段，再收起，有收起的过渡。
    const hadHeader = useRef(fold.showHeader);
    const justFolded = !hadHeader.current && fold.showHeader;
    useEffect(() => {
      hadHeader.current = fold.showHeader;
    });
    const lead = messages[0]?.role === 'user' && !messages[0].steered ? 1 : 0;
    const last = messages.at(-1);
    // 进行中：最后一项是工作组（或进行中的压缩，0.24.0）时它显示当前动作，否则末尾另起“正在思考”一行；压缩上下文的回合
    // 在压缩开始之前那一行就写“正在压缩上下文”，计划写到一半时写“正在写计划”。
    const tail =
      last?.role === 'assistant'
        ? groupWork(visibleParts(last.parts, hasSubagents)).at(-1)
        : undefined;
    const liveTail =
      live !== undefined &&
      (tail?.kind === 'work' ||
        // 正在重新连接（0.119.0）：那一行就是当前动作。
        (tail?.kind === 'part' && tail.part.type === 'retry') ||
        (live === 'running' &&
          tail?.kind === 'part' &&
          tail.part.type === 'compaction' &&
          tail.part.status === 'running'));
    const first = messages[0];
    const compacting = first?.role === 'user' && first.command?.kind === 'compact';
    // 计划写到一半（0.37.0）：那一行写“正在写计划”。
    const writingPlan =
      tail?.kind === 'part' && tail.part.type === 'plan' && tail.part.state === 'streaming';
    // 回合结束后的回答（收起时留下的那段正文），悬停时下面出现“复制”（U36）。
    const answer = fold.finished ? finalAnswer(messages, fold) : '';
    const liveLine =
      live && !liveTail
        ? {
            live,
            startedAt: fold.startedAt,
            ...(compacting && { label: t('compaction.running') }),
            ...(writingPlan && { label: t('plan.writing') }),
          }
        : undefined;
    // 上一次画出的当前动作那一行；回合不再进行（live 没了）时它还在，就拿它收起。回合中途换成工作组时直接换掉。
    const lastLive = useRef(liveLine);
    const leavingLive = useRef<typeof liveLine>(undefined);
    if (liveLine) {
      lastLive.current = liveLine;
      leavingLive.current = undefined;
    } else if (lastLive.current) {
      if (live === undefined) leavingLive.current = lastLive.current;
      lastLive.current = undefined;
    }
    // 回合末的下一步卡片（0.128.0）：agent 收尾时带了问题与按钮，画在回答与操作行下面。
    const wrapUp = turnWrapUp(messages);
    // 回答的时刻：回合开始加用时（插话分出的每条助手消息都带回合的开始与用时）。
    const answeredAt =
      fold.finished && last?.role === 'assistant' && last.startedAt && last.finished
        ? new Date(Date.parse(last.startedAt) + last.finished.durationMs).toISOString()
        : undefined;
    return (
      <TurnOrb value={orb}>
        <div data-turn={turnId} data-turn-folded={folded || undefined} className="group/turn">
          {messages.slice(0, lead).map((message) =>
            message.role === 'user' ? (
              // 搜索结果跳到这条（transcript-focus.ts）：只作标记，不占盒子。
              <div key={message.id} className="contents" data-chat-message={message.id}>
                <UserMessage message={message} />
              </div>
            ) : null,
          )}
          {/* 回合在眼前结束时“已处理”一行展开进来，与过程收起、操作行出现同时过渡，消息流的总高不在结束那一帧跳。 */}
          <Collapse open={fold.showHeader && fold.finished !== undefined} flow>
            {fold.finished && (
              <TurnHeader
                controls={id}
                outcome={fold.finished.outcome}
                text={turnHeaderText(fold.finished)}
                open={open}
                onToggle={() => setOpen(!open)}
              />
            )}
          </Collapse>
          <div id={id}>
            {messages.slice(lead).map((message) => {
              if (message.role === 'user') {
                // 回合中途插进来的后台进程通知属于过程：随过程一起收进“已处理”，不留在回答上面。
                if (fold.showHeader && message.from?.process !== undefined) {
                  return (
                    <Collapse key={message.id} open={!folded} fromOpen={justFolded} flow>
                      <div className="mt-3" data-chat-message={message.id}>
                        <UserMessage message={message} />
                      </div>
                    </Collapse>
                  );
                }
                return (
                  <div key={message.id} className="mt-3" data-chat-message={message.id}>
                    <UserMessage message={message} />
                  </div>
                );
              }
              if (message.role !== 'assistant') return null;
              const visible = visibleParts(message.parts, hasSubagents);
              // 清单不在它第一次出现的位置画，统一画在回合末尾（todo-card.tsx）。
              const parts = filesAfterAnswer<(typeof visible)[number]>(
                message.id,
                visible.filter((part) => part.type !== 'todo'),
                fold,
              );
              if (parts.length === 0) return null;
              const view = (shown: typeof parts) => (
                <PartsView
                  parts={shown}
                  turnActive={turnActive}
                  {...(message === last && live && { live })}
                  {...(fold.startedAt !== undefined && { startedAt: fold.startedAt })}
                />
              );
              if (!fold.showHeader) {
                return (
                  <div
                    key={message.id}
                    className="mt-3"
                    data-message-role="assistant"
                    data-chat-message={message.id}
                  >
                    {view(parts)}
                  </div>
                );
              }
              const segments = foldSegments(message.id, parts, fold);
              // 整条都是过程：连同上边距一起收起。
              if (segments.every((segment) => !segment.kept)) {
                return (
                  <Collapse key={message.id} open={!folded} fromOpen={justFolded} flow>
                    <div
                      className="mt-3"
                      data-message-role="assistant"
                      data-chat-message={message.id}
                    >
                      {view(parts)}
                    </div>
                  </Collapse>
                );
              }
              return (
                <div
                  key={message.id}
                  className="mt-3"
                  data-message-role="assistant"
                  data-chat-message={message.id}
                >
                  {segments.map((segment) =>
                    segment.kept ? (
                      <Fragment key={segment.key}>{view(segment.parts)}</Fragment>
                    ) : (
                      <Collapse key={segment.key} open={!folded} fromOpen={justFolded} flow>
                        {view(segment.parts)}
                      </Collapse>
                    ),
                  )}
                </div>
              );
            })}
          </div>
          {todos &&
            (fold.showHeader ? (
              <Collapse open={!folded} fromOpen={justFolded} flow>
                <TurnTodoCard todos={todos} running={runningSubagents} />
              </Collapse>
            ) : (
              <TurnTodoCard todos={todos} running={runningSubagents} />
            ))}
          {steers.map((message) => (
            <div key={message.id} className="mt-3">
              <PendingSteerMessage message={message} />
            </div>
          ))}
          {notices.map((message) => (
            <div key={message.id} className="mt-3">
              <PendingNoticeLine message={message} />
            </div>
          ))}
          {liveLine ? (
            <LiveLine {...liveLine} />
          ) : (
            // 回合在眼前结束：当前动作那一行随过程一起收起，不在结束那一帧消失（回合中途换成工作组时照旧直接换）。
            leavingLive.current && (
              <Collapse open={false} fromOpen flow>
                <LiveLine {...leavingLive.current} />
              </Collapse>
            )
          )}
          {/* 回合结束时出现的药丸与操作行展开进来；打开会话时已经结束的回合直接是展开的。 */}
          <Collapse
            open={fold.finished !== undefined && (changes.files > 0 || checks !== undefined)}
            flow
          >
            {/* 两颗药丸放进同一行 flex 居中：各自 inline-flex 时按基线对齐，“检查”以图标开头，基线落在图标底边，会比“已更改”高。 */}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {changes.files > 0 && (
                <ChangesChip
                  turnId={turnId}
                  messages={messages}
                  hasSubagents={hasSubagents}
                  changes={changes}
                />
              )}
              {checks && <ChecksChip checks={checks} />}
            </div>
          </Collapse>
          <Collapse
            open={fold.finished !== undefined && (answer !== '' || branch !== undefined)}
            flow
          >
            {/* 回答下面的“复制”（U36）与“分支到新会话”（0.38.0）：最后一个回合的一直显示，别的悬停时出现。占一行高度：消息流的
                每一块有 `content-visibility: auto`（绘制裁在块里），叠到块外面的按钮既看不见也点不着。 */}
            <GlideGroup
              className={cn(
                'mt-1 flex h-6 items-center gap-0.5',
                !lastTurn &&
                  'opacity-0 transition-opacity duration-150 group-hover/turn:opacity-100 focus-within:opacity-100',
              )}
              data-message-actions
            >
              {answer !== '' && (
                <CopyButton text={answer} className="-ml-1 text-muted-foreground" />
              )}
              <BranchButton
                turnId={turnId}
                className={cn('text-muted-foreground', answer === '' && '-ml-1')}
              />
              {answeredAt !== undefined && <RelativeTime ts={answeredAt} />}
            </GlideGroup>
          </Collapse>
          {fold.finished && !laterTurn && wrapUp !== undefined && (
            <WrapUpCard turnId={turnId} wrapUp={wrapUp} />
          )}
        </div>
      </TurnOrb>
    );
  },
  (prev, next) =>
    prev.turnId === next.turnId &&
    prev.turnActive === next.turnActive &&
    prev.live === next.live &&
    prev.orb === next.orb &&
    prev.hasSubagents === next.hasSubagents &&
    prev.runningSubagents === next.runningSubagents &&
    prev.lastTurn === next.lastTurn &&
    prev.laterTurn === next.laterTurn &&
    sameItems(prev.steers ?? NO_STEERS, next.steers ?? NO_STEERS) &&
    sameItems(prev.notices ?? NO_STEERS, next.notices ?? NO_STEERS) &&
    prev.checks?.key === next.checks?.key &&
    prev.messages.length === next.messages.length &&
    prev.messages.every((message, index) => message === next.messages[index]),
);

/**
 * “已处理 2 分 31 秒 ›”，下面一条横线把它与回答隔开（照 Codex 桌面端）：点它展开或收起整个过程。不标失败、被拒绝等计数
 * （失败的那一行在过程里自己用失败色）。
 */
function TurnHeader({
  controls,
  outcome,
  text,
  open,
  onToggle,
}: {
  controls: string;
  outcome: TurnOutcome;
  text: string;
  open: boolean;
  onToggle(): void;
}) {
  return (
    <div className="mt-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={controls}
        data-turn-header={outcome}
        onClick={onToggle}
        className="flex min-h-6 max-w-full items-center gap-1.5 rounded-lg text-left text-sm text-muted-foreground tabular-nums outline-none hover:text-foreground focus-visible:focus-ring"
      >
        <span className={cn('shrink-0', HEADER_TONES[outcome])}>{text}</span>
        <ChevronRight
          aria-hidden
          className={cn(
            'size-3.5 shrink-0 opacity-75 transition-transform duration-200 ease-expand',
            open && 'rotate-90',
          )}
        />
      </button>
      <div aria-hidden className="mt-1.5 h-px bg-border" />
    </div>
  );
}

/** 进行中的回合末尾：状态图标位 +“正在思考 / 等待审批 / 正在停止” + 已用时间。`label` 换掉“正在思考”。 */
function LiveLine({
  live,
  startedAt,
  label,
}: {
  live: LiveState;
  startedAt: string | undefined;
  label?: string;
}) {
  const text =
    live === 'stopping'
      ? t('work.stopping')
      : live === 'awaiting'
        ? t('work.awaiting')
        : live === 'input'
          ? t('work.awaitingInput')
          : (label ?? t('work.thinking'));
  return (
    <div
      className="mt-3 flex min-h-6 items-center gap-2 text-sm text-muted-foreground"
      data-live-line={live}
    >
      <LiveIndicator state={live} />
      {/* 换了一句时上浮进入（work-group.tsx 的当前动作同样写法）。 */}
      <span key={text} className="rise-in">
        <span className={live === 'awaiting' || live === 'input' ? AWAITING_PILL : 'shimmer'}>
          {text}
        </span>
      </span>
      <Elapsed since={startedAt} className="tabular-nums" />
    </div>
  );
}

/**
 * 回答下面的“N 个文件已更改 +a −d”。0.20.0 起点它打开“变更”窗格到这个回合（turn-changes.ts）；没有这个入口时（子智能体、
 * 支线、旧的 Host）展开这个回合的过程，连同其中有修改的工作组，展开过程就能看到每个修改的 diff。
 */
function ChangesChip({
  turnId,
  messages,
  hasSubagents,
  changes,
}: {
  turnId: TurnId;
  messages: readonly ChatMessage[];
  hasSubagents: boolean;
  changes: TurnFold['changes'];
}) {
  const setFolds = useFoldSetter();
  const { open: openTurn } = useContext(OpenTurnChanges);
  const expand = () => {
    if (openTurn) {
      openTurn(turnId);
      return;
    }
    const keys = [`turn:${turnId}`];
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      for (const item of groupWork(visibleParts(message.parts, hasSubagents))) {
        if (
          item.kind === 'work' &&
          item.entries.some((entry) => entry.type === 'tool' && editStats(entry))
        ) {
          keys.push(item.key);
        }
      }
    }
    setFolds(keys, true);
  };
  return (
    <button
      type="button"
      onClick={expand}
      data-turn-changes
      className="inline-flex h-7 items-center gap-2 rounded-full border border-border bg-card pr-1.5 pl-3 text-sm text-soft-foreground outline-none hover:border-border-strong hover:text-foreground focus-visible:focus-field"
    >
      {t('turn.changes', { count: changes.files })}
      <DiffStat stats={changes} />
    </button>
  );
}

const CHECK_ICONS = {
  running: LoaderCircle,
  passed: CircleCheck,
  failed: CircleX,
  environment_unavailable: CircleAlert,
  unverified: CircleAlert,
} as const;

/** 回答下面的“检查通过 2/2”（0.65.0）：这个回合触发的最近一轮检查；详情在会话侧栏的“检查”卡片里。 */
function ChecksChip({ checks }: { checks: ChecksSummary }) {
  const Icon = CHECK_ICONS[checks.tone];
  const plain = TURN_CHECK_LABELS[checks.tone];
  const label =
    plain !== undefined
      ? t(plain)
      : t(checks.tone === 'passed' ? 'turn.checks.passed' : 'turn.checks.failed', {
          passed: checks.passed,
          total: checks.total,
        });
  return (
    <span
      data-turn-checks={checks.tone}
      className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-card pr-3 pl-2 text-sm text-soft-foreground"
    >
      <Icon
        aria-hidden
        className={cn(
          'size-4 shrink-0',
          checks.tone === 'running' && 'animate-spin text-running',
          checks.tone === 'passed' && 'text-success',
          checks.tone === 'failed' && 'text-destructive',
          checks.tone === 'environment_unavailable' && 'text-warning',
        )}
      />
      {label}
    </span>
  );
}
