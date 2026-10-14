import type { Transcript } from '@wevir/client-sdk';
import type { ClientIdentity } from '@wevir/protocol';
import { cn } from 'cn';
import { ArrowDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { turnOrb } from '@/fx/orb-state';
import { t } from '@/i18n';
import { FoldScopeProvider } from './fold-state';
import type { LiveState } from './live-indicator';
import { SystemMessage } from './message-view';
import { useStickToBottom } from './scroll-controller';
import { groupTurns, isActiveTurn, turnStart } from './turn-model';
import { TurnView } from './turn-view';
import { WorkspaceRoot } from './work-group';

/** 一次渲染的消息条数；往上滚到顶时再多渲染这么多（分段渲染，长会话不一次铺满 DOM）。 */
export const RENDER_WINDOW = 60;

export interface TranscriptViewHandle {
  jumpToLatest(behavior?: ScrollBehavior): void;
}

/**
 * 消息流：分段渲染（最后 `RENDER_WINDOW` 条起的一段，滚到顶部附近时向前扩展；起点挪到所在回合的开头），按回合成块
 * （turn-view.tsx：工作组与回合的折叠，U2），每块用 `content-visibility: auto` 跳过视口外的排版与绘制。贴底 / 手动
 * 两种滚动模式，离开底部时显示“跳到最新”；点开或收起一处时保持位置（fold-state.tsx）。
 */
export function TranscriptView({
  sessionId,
  transcript,
  self,
  cwd,
  onReady,
}: {
  sessionId: string;
  transcript: Transcript;
  self: ClientIdentity | undefined;
  /** 会话的工作目录：工具的路径相对它显示。 */
  cwd?: string;
  /** 交出滚动控制（发送消息时回到贴底）。 */
  onReady?: (handle: TranscriptViewHandle) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const { sticky, jumpToLatest, holdPosition } = useStickToBottom(
    containerRef,
    contentRef,
    sessionId,
  );
  const { messages } = transcript;
  // 渲染从哪条消息开始。贴底时不固定：只渲染最后 RENDER_WINDOW 条，新消息进来时窗口随之后移，DOM 不随会话
  // 增长；手动阅读时固定在当前第一条，新消息只追加，正在读的内容不会被挪走。向前扩展同样固定。
  const [pinnedStart, setPinnedStart] = useState<string>();
  const pinnedIndex = pinnedStart ? messages.findIndex((m) => m.id === pinnedStart) : -1;
  const start = turnStart(
    messages,
    pinnedIndex >= 0 ? pinnedIndex : Math.max(0, messages.length - RENDER_WINDOW),
  );
  const hidden = start;
  const firstRendered = messages[start]?.id;

  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在切换模式与换会话时固定或放开。
  useEffect(() => setPinnedStart(sticky ? undefined : firstRendered), [sticky, sessionId]);
  useEffect(() => onReady?.({ jumpToLatest }), [onReady, jumpToLatest]);
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
        className="transcript-scroll h-full overflow-y-auto outline-none"
      >
        <div ref={contentRef} className="mx-auto w-full max-w-content px-6 pt-6 pb-4">
          {hidden > 0 && (
            <div ref={sentinelRef} className="flex justify-center pb-2">
              <Button variant="ghost" size="xs" onClick={showEarlier}>
                {t('transcript.showEarlier', { count: Math.min(hidden, RENDER_WINDOW) })}
              </Button>
            </div>
          )}
          <FoldScopeProvider sessionId={sessionId} onToggle={holdPosition}>
            <WorkspaceRoot value={cwd}>
              {groupTurns(messages.slice(start)).map((block) => {
                const fresh = !firstRender && sticky && !seenKeys.has(block.key);
                seenKeys.add(block.key);
                return (
                  <div
                    key={block.key}
                    className={cn(
                      'transcript-item pt-6 first:pt-0',
                      fresh && 'animate-in fade-in slide-in-from-bottom-2 duration-300 ease-smooth',
                    )}
                    data-message-id={block.key}
                  >
                    {block.kind === 'turn' ? (
                      <TurnView
                        turnId={block.turnId}
                        messages={block.messages}
                        turnActive={isActiveTurn(block.turnId, transcript)}
                        {...(isActiveTurn(block.turnId, transcript) && {
                          live: liveState(transcript.state),
                          orb: turnOrb(sessionId, block.turnId),
                        })}
                        hasSubagents={transcript.subagents.length > 0}
                        self={self}
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
      {!sticky && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <button
            type="button"
            aria-label={t('transcript.jumpToLatest')}
            title={t('transcript.jumpToLatest')}
            onClick={() => jumpToLatest('smooth')}
            data-action="jump-to-latest"
            className="pointer-events-auto flex size-8 items-center justify-center rounded-full border border-border bg-card text-soft-foreground shadow-md outline-none transition-[color,background-color,transform] duration-150 animate-in fade-in zoom-in-90 hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 active:scale-95"
          >
            <ArrowDown aria-hidden className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}

function liveState(state: Transcript['state']): LiveState {
  return state === 'awaiting_approval'
    ? 'awaiting'
    : state === 'cancelling'
      ? 'stopping'
      : 'running';
}
