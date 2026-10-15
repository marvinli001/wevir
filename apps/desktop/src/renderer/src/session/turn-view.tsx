import type { ChatMessage } from '@wevir/client-sdk';
import type { TurnId, TurnOutcome } from '@wevir/protocol';
import { cn } from 'cn';
import { ChevronRight } from 'lucide-react';
import { memo, useContext, useId } from 'react';
import type { OrbState } from 'thinking-orbs';
import { t } from '@/i18n';
import { CopyButton } from './copy-button';
import { Elapsed } from './elapsed';
import { useFold, useFoldSetter } from './fold-state';
import { AWAITING_PILL, LiveIndicator, type LiveState, TurnOrb } from './live-indicator';
import { PartsView, UserMessage } from './message-view';
import { visibleParts } from './subagent-model';
import { editStats, groupWork } from './tool-model';
import { OpenTurnChanges } from './turn-changes';
import { foldedParts, foldTurn, type TurnFold, turnHeaderText } from './turn-model';
import { DiffStat, IssueFlags } from './work-group';

const HEADER_TONES: Record<TurnOutcome, string> = {
  completed: '',
  failed: 'text-destructive',
  cancelled: '',
  interrupted: 'text-warning',
};

/**
 * 一个回合（U2，照 Codex 桌面端 design-refs/10–12）：用户消息、助手消息与中间的插话。正常完成的回合默认把过程收进一行
 * “已处理 2 分 31 秒”，只留最后的回答、错误与插话，回答下面是“N 个文件已更改”；出错、被停止、被中断的回合不自动收起，
 * 那一行写“出错 · 用时”等。进行中的回合末尾是当前动作那一行。按消息的对象身份 memo：投影只为改动过的消息换新对象，
 * 流式输出时只有进行中的回合重画。
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
  }) {
    const fold = foldTurn(messages, hasSubagents, turnActive);
    const [open, setOpen] = useFold(`turn:${turnId}`, !fold.defaultFolded);
    const folded = fold.showHeader && !open;
    const id = useId();
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
          {messages
            .slice(0, lead)
            .map((message) =>
              message.role === 'user' ? <UserMessage key={message.id} message={message} /> : null,
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
                  <div key={message.id} className="mt-3">
                    <UserMessage message={message} />
                  </div>
                );
              }
              if (message.role !== 'assistant') return null;
              const shown = folded
                ? foldedParts(message, fold)
                : visibleParts(message.parts, hasSubagents);
              const parts = hideTodos ? shown.filter((part) => part.type !== 'todo') : shown;
              if (parts.length === 0) return null;
              return (
                <div key={message.id} className="mt-3" data-message-role="assistant">
                  <PartsView
                    parts={parts}
                    turnActive={turnActive}
                    {...(message === last && live && { live })}
                    {...(fold.startedAt !== undefined && { startedAt: fold.startedAt })}
                  />
                </div>
              );
            })}
          </div>
          {live && !liveTail && (
            <LiveLine
              live={live}
              startedAt={fold.startedAt}
              {...(compacting && { label: t('compaction.running') })}
              {...(writingPlan && { label: t('plan.writing') })}
            />
          )}
          {fold.finished && fold.changes.files > 0 && (
            <ChangesChip
              turnId={turnId}
              messages={messages}
              hasSubagents={hasSubagents}
              fold={fold}
            />
          )}
          {answer !== '' && (
            // 悬停时出现，不占消息流的高度（叠在下一个回合上方的空隙里）。
            <div className="relative h-0">
              <div className="absolute top-0.5 left-0 flex items-center opacity-0 transition-opacity duration-150 group-hover/turn:opacity-100 focus-within:opacity-100">
                <CopyButton text={answer} className="-ml-1 text-muted-foreground" />
              </div>
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
        className="flex min-h-6 max-w-full items-center gap-1.5 rounded-lg text-left text-sm text-muted-foreground tabular-nums outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
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
      <span className={live === 'awaiting' || live === 'input' ? AWAITING_PILL : 'shimmer'}>
        {text}
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
      className="mt-3 inline-flex h-7 items-center gap-2 rounded-full border border-border bg-card pr-1.5 pl-3 text-sm text-soft-foreground outline-none hover:border-border-strong hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {t('turn.changes', { count: fold.changes.files })}
      <DiffStat stats={fold.changes} />
    </button>
  );
}
