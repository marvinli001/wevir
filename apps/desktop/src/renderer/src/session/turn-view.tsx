import type { ChatMessage } from '@wevir/client-sdk';
import type { PendingMessage, TurnId, TurnOutcome } from '@wevir/protocol';
import { cn } from 'cn';
import { ChevronRight, CircleAlert, CircleCheck, CircleX, LoaderCircle } from 'lucide-react';
import { Fragment, memo, useContext, useEffect, useId, useRef } from 'react';
import type { OrbState } from 'thinking-orbs';
import { Collapse } from '@/components/collapse';
import { t } from '@/i18n';
import { CopyButton } from './copy-button';
import { Elapsed } from './elapsed';
import { useFold, useFoldSetter } from './fold-state';
import { AWAITING_PILL, LiveIndicator, type LiveState, TurnOrb } from './live-indicator';
import { BranchButton, useMessageActions } from './message-actions';
import { PartsView, PendingSteerMessage, UserMessage } from './message-view';
import { visibleParts } from './subagent-model';
import { editStats, groupWork } from './tool-model';
import { OpenTurnChanges } from './turn-changes';
import { foldSegments, foldTurn, type TurnFold, turnHeaderText } from './turn-model';
import { type ChecksSummary, TURN_CHECK_LABELS } from './verification-model';
import { DiffStat, IssueFlags } from './work-group';

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
    hideTodos = false,
    lastTurn = false,
    steers = NO_STEERS,
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
    /** 这个回合的清单停在输入框上方（U20，todo-card.tsx），消息里不再画。 */
    hideTodos?: boolean;
    /** 会话最后一个回合：回答下面的操作行一直显示（照 Codex 桌面端），别的回合悬停时才出现。 */
    lastTurn?: boolean;
    /** 进行中的回合：交给模型、还没插进来的插话，画在末尾（当前动作那一行之前）。 */
    steers?: readonly PendingMessage[];
    /** 这个回合触发的最近一轮检查（0.65.0）。 */
    checks?: ChecksSummary;
  }) {
    const fold = foldTurn(messages, hasSubagents, turnActive);
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
        (live === 'running' &&
          tail?.kind === 'part' &&
          tail.part.type === 'compaction' &&
          tail.part.status === 'running'));
    const first = messages[0];
    const compacting = first?.role === 'user' && first.command?.kind === 'compact';
    // 计划写到一半（0.37.0）：那一行写“正在写计划”。
    const writingPlan =
      tail?.kind === 'part' && tail.part.type === 'plan' && tail.part.state === 'streaming';
    // 回合结束后的回答（最后一条助手消息的正文），悬停时下面出现“复制”（U36）。
    const answer =
      fold.finished && last?.role === 'assistant'
        ? last.parts
            .flatMap((part) => (part.type === 'text' ? [part.text] : []))
            .join('\n\n')
            .trim()
        : '';
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
          {fold.showHeader && fold.finished && (
            <TurnHeader
              controls={id}
              outcome={fold.finished.outcome}
              text={turnHeaderText(fold.finished)}
              open={open}
              issues={folded ? fold.issues : undefined}
              onToggle={() => setOpen(!open)}
            />
          )}
          <div id={id}>
            {messages.slice(lead).map((message) => {
              if (message.role === 'user') {
                return (
                  <div key={message.id} className="mt-3" data-chat-message={message.id}>
                    <UserMessage message={message} />
                  </div>
                );
              }
              if (message.role !== 'assistant') return null;
              const visible = visibleParts(message.parts, hasSubagents);
              const parts = hideTodos ? visible.filter((part) => part.type !== 'todo') : visible;
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
                  <Collapse key={message.id} open={!folded} fromOpen={justFolded}>
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
                      <Collapse key={segment.key} open={!folded} fromOpen={justFolded}>
                        {view(segment.parts)}
                      </Collapse>
                    ),
                  )}
                </div>
              );
            })}
          </div>
          {steers.map((message) => (
            <div key={message.id} className="mt-3">
              <PendingSteerMessage message={message} />
            </div>
          ))}
          {live && !liveTail && (
            <LiveLine
              live={live}
              startedAt={fold.startedAt}
              {...(compacting && { label: t('compaction.running') })}
              {...(writingPlan && { label: t('plan.writing') })}
            />
          )}
          {fold.finished && (fold.changes.files > 0 || checks) && (
            // 两颗药丸放进同一行 flex 居中：各自 inline-flex 时按基线对齐，“检查”以图标开头，基线落在图标底边，会比“已更改”高。
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {fold.changes.files > 0 && (
                <ChangesChip
                  turnId={turnId}
                  messages={messages}
                  hasSubagents={hasSubagents}
                  fold={fold}
                />
              )}
              {checks && <ChecksChip checks={checks} />}
            </div>
          )}
          {fold.finished && (answer !== '' || branch !== undefined) && (
            // 回答下面的“复制”（U36）与“分支到新会话”（0.38.0）：最后一个回合的一直显示，别的悬停时出现。占一行高度：消息流的
            // 每一块有 `content-visibility: auto`（绘制裁在块里），叠到块外面的按钮既看不见也点不着。
            <div
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
            </div>
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
    prev.lastTurn === next.lastTurn &&
    sameItems(prev.steers ?? NO_STEERS, next.steers ?? NO_STEERS) &&
    prev.checks?.key === next.checks?.key &&
    prev.messages.length === next.messages.length &&
    prev.messages.every((message, index) => message === next.messages[index]),
);

/**
 * “已处理 2 分 31 秒 ›”，下面一条横线把它与回答隔开（照 Codex 桌面端）：点它展开或收起整个过程。收起时标出过程里的失败、
 * 被拒绝、状态未知。
 */
function TurnHeader({
  controls,
  outcome,
  text,
  open,
  issues,
  onToggle,
}: {
  controls: string;
  outcome: TurnOutcome;
  text: string;
  open: boolean;
  issues?: TurnFold['issues'];
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
        {issues && <IssueFlags issues={issues} />}
        <ChevronRight
          aria-hidden
          className={cn('size-3.5 shrink-0 opacity-75 transition-transform', open && 'rotate-90')}
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
  fold,
}: {
  turnId: TurnId;
  messages: readonly ChatMessage[];
  hasSubagents: boolean;
  fold: TurnFold;
}) {
  const setFolds = useFoldSetter();
  const openTurn = useContext(OpenTurnChanges);
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
      {t('turn.changes', { count: fold.changes.files })}
      <DiffStat stats={fold.changes} />
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
