import type { Transcript, TranscriptChapter } from '@wevir/client-sdk';
import { cn } from 'cn';
import { ArrowDown } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useScrollFade } from '@/components/scroll-fade';
import { Button } from '@/components/ui/button';
import { turnOrb } from '@/fx/orb-state';
import { t } from '@/i18n';
import { CHAPTER_NAV_MIN } from './chapter-model';
import { ChapterNav } from './chapter-nav';
import { FoldScopeProvider, setFolds } from './fold-state';
import type { LiveState } from './live-indicator';
import { SystemMessage } from './message-view';
import { groupPending } from './pending-model';
import { useStickToBottom } from './scroll-controller';
import { type QuoteActions, SelectionToolbar } from './selection-toolbar';
import { latestTodos } from './todo-model';
import {
  FOCUS_HIGHLIGHT,
  FOCUS_HIGHLIGHT_MS,
  findTextRange,
  transcriptFocus,
} from './transcript-focus';
import {
  blockSeqRange,
  continuesAgent,
  groupTurns,
  isActiveTurn,
  isReportOnly,
  messageIndexForSeq,
  turnStart,
} from './turn-model';
import { TurnView } from './turn-view';
import { turnChecks } from './verification-model';
import { WorkspaceRoot } from './work-group';

/** 一次渲染的消息条数；往上滚到顶时再多渲染这么多（分段渲染，长会话不一次铺满 DOM）。 */
export const RENDER_WINDOW = 60;

export interface TranscriptViewHandle {
  jumpToLatest(behavior?: ScrollBehavior): void;
  /** 滚到某个事件所在的消息并短暂高亮（任务回顾的出处，0.76.0）。消息流里找不到时返回 false。 */
  revealSeq(seq: number): boolean;
}

/** 跳过去之后，所在的一块闪多久（styles/session.css 的 `seq-reveal`）。 */
const REVEAL_HIGHLIGHT_MS = 1600;

/**
 * 消息流：分段渲染（最后 `RENDER_WINDOW` 条起的一段，滚到顶部附近时向前扩展；起点挪到所在回合的开头），按回合成块
 * （turn-view.tsx：工作组与回合的折叠，U2），每块用 `content-visibility: auto` 跳过视口外的排版与绘制。贴底 / 手动
 * 两种滚动模式，离开底部较远时显示“跳到最新”；点开或收起一处时保持位置（fold-state.tsx）。
 */
export function TranscriptView({
  sessionId,
  transcript,
  cwd,
  onReady,
  compact = false,
  quote,
}: {
  sessionId: string;
  transcript: Transcript;
  /** 会话的工作目录：工具的路径相对它显示。 */
  cwd?: string;
  /** 交出滚动控制（发送消息时回到贴底）。 */
  onReady?: (handle: TranscriptViewHandle) => void;
  /** 窗格里（U23.1 的支线）：左右内边距收成 16 px。 */
  compact?: boolean;
  /** 选中消息里的文字时工具条的操作（只读的会话没有）。 */
  quote?: QuoteActions;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const { sticky, showJump, jumpToLatest, holdPosition, release } = useStickToBottom(
    containerRef,
    contentRef,
    sessionId,
  );
  // 顶部（标题栏下方）与手动阅读时的底部渐隐；贴底时底部不渐隐。
  useScrollFade(containerRef, { bottom: !sticky });
  const { messages } = transcript;
  // 渲染从哪条消息开始。贴底时不固定：只渲染最后 RENDER_WINDOW 条，新消息进来时窗口随之后移，DOM 不随会话
  // 增长；手动阅读时固定在当前第一条，新消息只追加，正在读的内容不会被挪走。向前扩展同样固定。
  const [pinnedStart, setPinnedStart] = useState<string>();
  // 跳到搜索结果（transcript-focus.ts）：那条消息一直在渲染的一段里，直到回到贴底。
  const [focusPin, setFocusPin] = useState<string>();
  const pinnedIndex = pinnedStart ? messages.findIndex((m) => m.id === pinnedStart) : -1;
  const focusIndex = focusPin ? messages.findIndex((m) => m.id === focusPin) : -1;
  const baseIndex = pinnedIndex >= 0 ? pinnedIndex : Math.max(0, messages.length - RENDER_WINDOW);
  const start = turnStart(messages, focusIndex >= 0 ? Math.min(baseIndex, focusIndex) : baseIndex);
  const hidden = start;
  const firstRendered = messages[start]?.id;
  // 停在输入框上方的清单属于哪个回合（U20）：那个回合的消息里不再画它。
  const dockedTodos = latestTodos(transcript)?.turnId;
  // 每个回合触发的检查（0.65.0），画在回答下面。
  const checksByTurn = useMemo(
    () => turnChecks(transcript.verification),
    [transcript.verification],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在切换模式与换会话时固定或放开。
  useEffect(() => setPinnedStart(sticky ? undefined : firstRendered), [sticky, sessionId]);
  useEffect(() => {
    if (sticky) setFocusPin(undefined);
  }, [sticky]);

  // 跳到某个事件（任务回顾的出处 `revealSeq`，0.76.0；搜索结果 transcript-focus.ts，0.77.0）：转为手动阅读、把它所在的消息
  // 放进渲染的一段，下一帧起滚过去（scrollToFocus）。
  const focusTarget = useRef<FocusTarget>(undefined);
  const [focusTick, setFocusTick] = useState(0);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const claim = useMemo(
    () => (index: number, text?: string, anchor?: string) => {
      const message = messagesRef.current[index];
      if (!message) return false;
      release();
      setFocusPin(message.id);
      focusTarget.current = {
        messageId: message.id,
        ...(message.role !== 'system' && { turnId: message.turnId }),
        ...(text !== undefined && { text }),
        ...(anchor !== undefined && { anchor }),
        tries: 0,
      };
      setFocusTick((tick) => tick + 1);
      return true;
    },
    [release],
  );
  const revealSeq = useMemo(
    () => (seq: number) => claim(messageIndexForSeq(messagesRef.current, seq)),
    [claim],
  );
  // 章节目录（0.82.0）：滚到那一章的分隔线。
  const jumpToChapter = useMemo(
    () => (chapter: TranscriptChapter) =>
      claim(messageIndexForSeq(messagesRef.current, chapter.seq), undefined, chapter.key),
    [claim],
  );
  // 搜索结果：消息流追到那个事件之后认领。
  const focus = transcriptFocus.use();
  useEffect(() => {
    if (focus?.sessionId !== sessionId || transcript.lastSeq < focus.seq) return;
    transcriptFocus.set(undefined);
    claim(messageIndexForSeq(messages, focus.seq), focus.text);
  }, [focus, sessionId, messages, transcript.lastSeq, claim]);
  // 每次认领（focusTick）起一个逐帧的循环，直到位置稳定；用户自己滚动就停下。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在认领时开始。
  useEffect(() => {
    const target = focusTarget.current;
    const container = containerRef.current;
    if (!target || !container) return;
    const cancel = () => {
      target.cancelled = true;
    };
    const inputs = ['wheel', 'touchmove', 'pointerdown', 'keydown'] as const;
    for (const type of inputs) container.addEventListener(type, cancel, { passive: true });
    let frame = 0;
    const step = () => {
      if (scrollToFocus(container, sessionId, target) === 'retry') {
        frame = requestAnimationFrame(step);
      } else if (focusTarget.current === target) {
        focusTarget.current = undefined;
      }
    };
    frame = requestAnimationFrame(step);
    return () => {
      cancelAnimationFrame(frame);
      for (const type of inputs) container.removeEventListener(type, cancel);
    };
  }, [focusTick]);
  useEffect(() => onReady?.({ jumpToLatest, revealSeq }), [onReady, jumpToLatest, revealSeq]);
  // 新到的块（U10）：贴底时末尾新出现的块淡入上移；首次渲染、向前展开的旧消息不动。在渲染时记下已见过的块。
  const seen = useRef<{ sessionId: string; keys: Set<string> }>(undefined);
  const firstRender = seen.current?.sessionId !== sessionId;
  if (firstRender) seen.current = { sessionId, keys: new Set() };
  const seenKeys = (seen.current as { keys: Set<string> }).keys;
  const showEarlier = () => setPinnedStart(messages[Math.max(0, start - RENDER_WINDOW)]?.id);
  const showEarlierRef = useRef(showEarlier);
  showEarlierRef.current = showEarlier;

  // 顶部哨兵进入视口附近（上方 800px 内）时多渲染一段；手动模式下 overflow-anchor 让阅读位置不跳。
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const container = containerRef.current;
    if (!sentinel || !container || hidden === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) showEarlierRef.current();
      },
      { root: container, rootMargin: '800px 0px 0px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hidden]);

  return (
    <div className="relative min-h-0 flex-1">
      <section
        ref={containerRef}
        aria-label={t('transcript.label')}
        // 可聚焦，键盘也能滚动（滚动控制器据此识别导航键）。
        // biome-ignore lint/a11y/noNoninteractiveTabindex: 可滚动区域需要能用键盘滚动。
        tabIndex={0}
        // 右内边距给盖在上面的会话侧栏让位（index.css 的 rail-clear，主窗格里才有）：内边距在滚动条里面，滚动条仍贴着右边。
        className="transcript-scroll scroll-fade rail-clear h-full overflow-y-auto outline-none [--scroll-fade-size:32px]"
      >
        <div
          ref={contentRef}
          className={cn('mx-auto w-full max-w-content pt-6 pb-4', compact ? 'px-4' : 'px-6')}
        >
          {hidden > 0 && (
            <div ref={sentinelRef} className="flex justify-center pb-2">
              <Button variant="ghost" size="xs" onClick={showEarlier}>
                {t('transcript.showEarlier', { count: Math.min(hidden, RENDER_WINDOW) })}
              </Button>
            </div>
          )}
          <FoldScopeProvider sessionId={sessionId} onToggle={holdPosition}>
            <WorkspaceRoot value={cwd}>
              {groupTurns(messages.slice(start)).map((block, index, blocks) => {
                const active = block.kind === 'turn' && isActiveTurn(block.turnId, transcript);
                const fresh = !firstRender && sticky && !seenKeys.has(block.key);
                seenKeys.add(block.key);
                const [seqFirst, seqLast] = blockSeqRange(block);
                return (
                  <div
                    key={block.key}
                    className={cn(
                      'transcript-item first:pt-0',
                      isReportOnly(block) ? 'pt-2' : continuesAgent(block) ? 'pt-0' : 'pt-6',
                      fresh && 'block-enter',
                    )}
                    data-message-id={block.key}
                    data-seq-first={seqFirst}
                    data-seq-last={seqLast}
                  >
                    {block.kind === 'turn' ? (
                      <TurnView
                        turnId={block.turnId}
                        messages={block.messages}
                        turnActive={active}
                        {...(active && {
                          live: liveState(transcript),
                          orb: turnOrb(sessionId, block.turnId),
                          // 交给模型、还没插进来的插话画在进行中的回合末尾（照 Claude 桌面端），不在输入框上方的待发区。
                          steers: groupPending(transcript.pendingMessages).steer,
                        })}
                        hasSubagents={transcript.subagents.length > 0}
                        hideTodos={block.turnId === dockedTodos}
                        lastTurn={index === blocks.length - 1}
                        {...(checksByTurn.has(block.turnId) && {
                          checks: checksByTurn.get(block.turnId),
                        })}
                      />
                    ) : (
                      block.message.role === 'system' && <SystemMessage message={block.message} />
                    )}
                  </div>
                );
              })}
            </WorkspaceRoot>
          </FoldScopeProvider>
        </div>
      </section>
      {quote && (
        <SelectionToolbar containerRef={containerRef} sessionId={sessionId} actions={quote} />
      )}
      {transcript.chapters.length >= CHAPTER_NAV_MIN && (
        <div className="rail-clear pointer-events-none absolute inset-x-0 top-2 flex justify-end px-3">
          <ChapterNav
            chapters={transcript.chapters}
            containerRef={containerRef}
            onJump={jumpToChapter}
          />
        </div>
      )}
      {showJump && (
        <div className="rail-clear pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <button
            type="button"
            aria-label={t('transcript.jumpToLatest')}
            title={t('transcript.jumpToLatest')}
            onClick={() => jumpToLatest('smooth')}
            data-action="jump-to-latest"
            className="pointer-events-auto flex size-8 items-center justify-center rounded-full border border-border bg-card text-soft-foreground shadow-md outline-none pressable [--press-scale:0.95] animate-in fade-in zoom-in-90 hover:bg-muted hover:text-foreground focus-visible:focus-field"
          >
            <ArrowDown aria-hidden className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}

function liveState(transcript: Transcript): LiveState {
  const { state } = transcript;
  if (state === 'running' && transcript.pendingQuestions.length > 0) return 'input';
  return state === 'awaiting_approval'
    ? 'awaiting'
    : state === 'cancelling'
      ? 'stopping'
      : 'running';
}

interface FocusTarget {
  messageId: string;
  turnId?: string;
  text?: string;
  /** 章节分隔线的 `data-chapter-anchor`（0.82.0）：滚到它，停在视口顶上，不闪。 */
  anchor?: string;
  tries: number;
  /** 收起的回合已经展开过。 */
  unfolded?: boolean;
  /** 第一次校正的时间。视口外的回合按估高排版（content-visibility），打开会话时侧栏展开又会改变行宽，滚到之后还要逐帧校正。 */
  startedAt?: number;
  /** 最近一次移动的时间。 */
  movedAt?: number;
  /** 已经标出命中的文字（或闪过所在的一块）。 */
  marked?: boolean;
  /** 用户动了滚动：不再校正。 */
  cancelled?: boolean;
}

/** 跳到章节时分隔线停在视口顶下多少（让开顶部的渐隐与目录按钮）。 */
const CHAPTER_TOP_PX = 40;

/** 最多等几帧让目标出现在 DOM 里。 */
const FOCUS_MAX_TRIES = 16;
/** 最多校正多久。 */
const FOCUS_MAX_MS = 1500;
/** 位置多久不变算稳定（侧栏展开的过渡在这之内）。 */
const FOCUS_SETTLE_MS = 300;

/**
 * 滚到目标，每帧调用一次：先在那条消息里找命中的文字，找不到而回合是收起的就展开再来；把目标放在视口上三分之一处，文字用
 * CSS Custom Highlight 标出（Range 随排版移动），没有或找不到文字时所在的一块闪一下；之后逐帧校正排版变化带来的偏差，位置稳定、
 * 超时或用户自己滚动时结束。
 */
function scrollToFocus(
  container: HTMLElement,
  sessionId: string,
  target: FocusTarget,
): 'retry' | 'done' {
  if (target.cancelled) return 'done';
  const message = container.querySelector(`[data-chat-message="${CSS.escape(target.messageId)}"]`);
  const turn =
    target.turnId === undefined
      ? null
      : container.querySelector(`[data-turn="${CSS.escape(target.turnId)}"]`);
  const anchor =
    target.anchor === undefined
      ? null
      : container.querySelector(`[data-chapter-anchor="${CSS.escape(target.anchor)}"]`);
  if (!message && !turn && !anchor) {
    target.tries += 1;
    return target.tries < FOCUS_MAX_TRIES ? 'retry' : 'done';
  }
  if (anchor) target.marked = true;
  const range =
    message && target.text !== undefined ? findTextRange(message, target.text) : undefined;
  if (!range && !target.unfolded && target.turnId && turn?.hasAttribute('data-turn-folded')) {
    target.unfolded = true;
    setFolds(sessionId, [`turn:${target.turnId}`], true);
    return 'retry';
  }
  const box =
    anchor ??
    (message && getComputedStyle(message).display !== 'contents' ? message : (turn ?? message));
  const rect = (range ?? box)?.getBoundingClientRect();
  const offset = rect
    ? rect.top -
      container.getBoundingClientRect().top -
      (anchor ? CHAPTER_TOP_PX : container.clientHeight / 3)
    : 0;
  const before = container.scrollTop;
  container.scrollTop += offset;
  const moved = Math.abs(container.scrollTop - before) > 1;
  const now = performance.now();
  target.startedAt ??= now;
  if (moved || target.movedAt === undefined) target.movedAt = now;
  const settled = now - target.movedAt >= FOCUS_SETTLE_MS || now - target.startedAt >= FOCUS_MAX_MS;
  if (!target.marked && (!moved || settled)) {
    target.marked = true;
    if (range && typeof Highlight !== 'undefined' && CSS.highlights) {
      CSS.highlights.set(FOCUS_HIGHLIGHT, new Highlight(range));
      window.setTimeout(() => CSS.highlights.delete(FOCUS_HIGHLIGHT), FOCUS_HIGHLIGHT_MS);
    } else {
      const block = box?.closest<HTMLElement>('.transcript-item');
      if (block) {
        block.dataset.revealed = 'true';
        window.setTimeout(() => {
          delete block.dataset.revealed;
        }, REVEAL_HIGHLIGHT_MS);
      }
    }
  }
  return settled ? 'done' : 'retry';
}
