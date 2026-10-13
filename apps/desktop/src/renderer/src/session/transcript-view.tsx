import type { ChatMessage, Transcript } from '@wevir/client-sdk';
import type { ClientIdentity } from '@wevir/protocol';
import { ArrowDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';
import { MessageView } from './message-view';
import { useStickToBottom } from './scroll-controller';

/** 一次渲染的消息条数；往上滚到顶时再多渲染这么多（分段渲染，长会话不一次铺满 DOM）。 */
export const RENDER_WINDOW = 60;

export interface TranscriptViewHandle {
  jumpToLatest(behavior?: ScrollBehavior): void;
}

/**
 * 消息流：分段渲染（最后 `RENDER_WINDOW` 条起的一段，滚到顶部附近时向前扩展），每条消息用
 * `content-visibility: auto` 跳过视口外的排版与绘制。贴底 / 手动两种滚动模式，离开底部时显示“跳到最新”。
 */
export function TranscriptView({
  sessionId,
  transcript,
  self,
  onReady,
}: {
  sessionId: string;
  transcript: Transcript;
  self: ClientIdentity | undefined;
  /** 交出滚动控制（发送消息时回到贴底）。 */
  onReady?: (handle: TranscriptViewHandle) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const { sticky, jumpToLatest } = useStickToBottom(containerRef, contentRef, sessionId);
  const { messages } = transcript;
  // 渲染从哪条消息开始。贴底时不固定：只渲染最后 RENDER_WINDOW 条，新消息进来时窗口随之后移，DOM 不随会话
  // 增长；手动阅读时固定在当前第一条，新消息只追加，正在读的内容不会被挪走。向前扩展同样固定。
  const [pinnedStart, setPinnedStart] = useState<string>();
  const pinnedIndex = pinnedStart ? messages.findIndex((m) => m.id === pinnedStart) : -1;
  const start = pinnedIndex >= 0 ? pinnedIndex : Math.max(0, messages.length - RENDER_WINDOW);
  const hidden = start;
  const firstRendered = messages[start]?.id;

  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在切换模式与换会话时固定或放开。
  useEffect(() => setPinnedStart(sticky ? undefined : firstRendered), [sticky, sessionId]);
  useEffect(() => onReady?.({ jumpToLatest }), [onReady, jumpToLatest]);
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
          {messages.slice(start).map((message) => (
            <div key={message.id} className="transcript-item" data-message-id={message.id}>
              <MessageView
                message={message}
                turnActive={isTurnActive(message, transcript)}
                self={self}
              />
            </div>
          ))}
        </div>
      </section>
      {!sticky && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <Button
            variant="outline"
            size="sm"
            className="pointer-events-auto rounded-full shadow-md"
            onClick={() => jumpToLatest('smooth')}
          >
            <ArrowDown data-icon="inline-start" />
            {t('transcript.jumpToLatest')}
          </Button>
        </div>
      )}
    </div>
  );
}

/** 消息所属的回合是不是会话正在进行的那一个。 */
function isTurnActive(message: ChatMessage, transcript: Transcript): boolean {
  return (
    message.role === 'assistant' &&
    message.turnId === transcript.activeTurnId &&
    (transcript.state === 'running' ||
      transcript.state === 'awaiting_approval' ||
      transcript.state === 'cancelling')
  );
}
