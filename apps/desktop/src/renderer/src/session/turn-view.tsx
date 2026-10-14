import type { ChatMessage } from '@wevir/client-sdk';
import type { ClientIdentity, TurnId, TurnOutcome } from '@wevir/protocol';
import { cn } from 'cn';
import { ChevronRight } from 'lucide-react';
import { memo, useId } from 'react';
import { t } from '@/i18n';
import { Elapsed } from './elapsed';
import { useFold, useFoldSetter } from './fold-state';
import { LiveIndicator, type LiveState } from './live-indicator';
import { PartsView, UserMessage } from './message-view';
import { visibleParts } from './subagent-model';
import { editStats, groupWork } from './tool-model';
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
    hasSubagents,
    self,
  }: {
    turnId: TurnId;
    messages: readonly ChatMessage[];
    turnActive: boolean;
    /** 会话正在进行这个回合时的状态。 */
    live?: LiveState;
    /** 会话派出过子会话：collab 工具调用不显示（subagent-model.ts 的 visibleParts）。 */
    hasSubagents: boolean;
    self: ClientIdentity | undefined;
  }) {
    const fold = foldTurn(messages, hasSubagents, turnActive);
    const [open, setOpen] = useFold(`turn:${turnId}`, !fold.defaultFolded);
    const folded = fold.showHeader && !open;
    const id = useId();
    const lead = messages[0]?.role === 'user' && !messages[0].steered ? 1 : 0;
    const last = messages.at(-1);
    // 进行中：最后一项是工作组时它显示当前动作，否则末尾另起“正在思考”一行。
    const liveTail =
      live !== undefined &&
      last?.role === 'assistant' &&
      groupWork(visibleParts(last.parts, hasSubagents)).at(-1)?.kind === 'work';
    return (
      <div data-turn={turnId} data-turn-folded={folded || undefined}>
        {messages
          .slice(0, lead)
          .map((message) =>
            message.role === 'user' ? (
              <UserMessage key={message.id} message={message} self={self} />
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
                <div key={message.id} className="mt-3">
                  <UserMessage message={message} self={self} />
                </div>
              );
            }
            if (message.role !== 'assistant') return null;
            const parts = folded
              ? foldedParts(message, fold)
              : visibleParts(message.parts, hasSubagents);
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
        {live && !liveTail && <LiveLine live={live} startedAt={fold.startedAt} />}
        {fold.finished && fold.changes.files > 0 && (
          <ChangesChip
            turnId={turnId}
            messages={messages}
            hasSubagents={hasSubagents}
            fold={fold}
          />
        )}
      </div>
    );
  },
  (prev, next) =>
    prev.turnId === next.turnId &&
    prev.turnActive === next.turnActive &&
    prev.live === next.live &&
    prev.hasSubagents === next.hasSubagents &&
    prev.self === next.self &&
    prev.messages.length === next.messages.length &&
    prev.messages.every((message, index) => message === next.messages[index]),
);

/** “已处理 2 分 31 秒 ›────”：点它展开或收起整个过程。收起时标出过程里的失败、被拒绝、状态未知。 */
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
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      data-turn-header={outcome}
      onClick={onToggle}
      className="mt-3 flex min-h-6 w-full items-center gap-1.5 rounded-lg text-left text-sm text-muted-foreground tabular-nums outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      <span className={cn('shrink-0', HEADER_TONES[outcome])}>{text}</span>
      {issues && <IssueFlags issues={issues} />}
      <ChevronRight
        aria-hidden
        className={cn('size-3.5 shrink-0 opacity-75 transition-transform', open && 'rotate-90')}
      />
      <span aria-hidden className="ml-1.5 h-px min-w-6 flex-1 bg-border" />
    </button>
  );
}

/** 进行中的回合末尾：状态图标位 +“正在思考 / 等待审批 / 正在停止” + 已用时间。 */
function LiveLine({ live, startedAt }: { live: LiveState; startedAt: string | undefined }) {
  const text =
    live === 'stopping'
      ? t('work.stopping')
      : live === 'awaiting'
        ? t('work.awaiting')
        : t('work.thinking');
  return (
    <div
      className="mt-3 flex min-h-6 items-center gap-2 text-sm text-muted-foreground"
      data-live-line={live}
    >
      <LiveIndicator state={live} />
      <span className={live === 'awaiting' ? 'text-warning' : 'shimmer'}>{text}</span>
      <Elapsed since={startedAt} className="tabular-nums" />
    </div>
  );
}

/**
 * 回答下面的“N 个文件已更改 +a −d”。点它展开这个回合的过程，连同其中有修改的工作组：改动窗格（`changes`）还没有实现
 * （pane-kinds.ts 里 available: false，正式构建打不开），展开过程就能看到每个修改的 diff。
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
  const expand = () => {
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
