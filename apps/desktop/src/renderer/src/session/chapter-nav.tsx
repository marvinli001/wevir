// 消息流的章节目录（0.82.0，`wevir_mark_chapter`）：会话有两章以上时，消息流右上角浮着一个小按钮，写正在读的那一章；点开列出
// 全部章节，点一项滚到它的分隔线（transcript-view.tsx 的 `onJump`）。

import type { TranscriptChapter } from '@wevir/client-sdk';
import { cn } from 'cn';
import { ListTree } from 'lucide-react';
import { type RefObject, useEffect, useState } from 'react';
import { ScrollFade } from '@/components/scroll-fade';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { t } from '@/i18n';
import { currentChapter } from './chapter-model';

/**
 * 分隔线过了视口顶下这么多就算读到了这一章（跳过去时停在 40 px，见 transcript-view.tsx 的 scrollToFocus）。滚到底时读线是视口
 * 底边：最后几章的分隔线到不了顶上，看得见的最后一章算正在读。
 */
const READ_LINE_PX = 48;
/** 离底边这么近算滚到底。 */
const BOTTOM_SLACK_PX = 2;

export function ChapterNav({
  chapters,
  containerRef,
  onJump,
}: {
  chapters: readonly TranscriptChapter[];
  containerRef: RefObject<HTMLElement | null>;
  onJump: (chapter: TranscriptChapter) => void;
}) {
  const current = useCurrentChapter(containerRef, chapters);
  const [open, setOpen] = useState(false);
  const label = t('transcript.chapters');
  const title = chapters[current]?.title;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={label}
            title={label}
            data-action="chapter-nav"
            className="pointer-events-auto flex h-7 max-w-56 items-center gap-1.5 rounded-full border border-border bg-card px-2.5 text-xs text-soft-foreground shadow-sm outline-none pressable [--press-scale:0.97] hover:bg-muted hover:text-foreground focus-visible:focus-field data-popup-open:bg-muted data-popup-open:text-foreground"
          >
            <ListTree aria-hidden className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate">{title ?? label}</span>
          </button>
        }
      />
      <PopoverContent align="end" className="w-72 gap-0 overflow-hidden p-0" data-chapter-nav>
        <ScrollFade className="max-h-80 overflow-y-auto p-1.5 [--scroll-fade-size:16px]">
          <ol className="flex flex-col">
            {chapters.map((chapter, index) => (
              <li key={chapter.key}>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onJump(chapter);
                  }}
                  aria-current={index === current ? 'location' : undefined}
                  data-chapter={chapter.key}
                  className={cn(
                    'flex w-full min-w-0 gap-2 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:bg-accent',
                    index === current && 'text-foreground',
                  )}
                >
                  <span
                    aria-hidden
                    className="w-4 shrink-0 text-right text-xs leading-5 text-muted-foreground tabular-nums"
                  >
                    {index + 1}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className={cn('truncate text-sm', index === current && 'font-medium')}>
                      {chapter.title}
                    </span>
                    {chapter.summary && (
                      <span className="line-clamp-2 text-xs text-muted-foreground">
                        {chapter.summary}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </ScrollFade>
      </PopoverContent>
    </Popover>
  );
}

/** 正在读的那一章：滚动、改尺寸与章节变化时按分隔线的位置重算（每帧至多一次）。 */
function useCurrentChapter(
  containerRef: RefObject<HTMLElement | null>,
  chapters: readonly TranscriptChapter[],
): number {
  const [current, setCurrent] = useState(-1);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const top = container.getBoundingClientRect().top;
      const anchors = [...container.querySelectorAll<HTMLElement>('[data-chapter-anchor]')].map(
        (element) => ({
          key: element.dataset.chapterAnchor ?? '',
          top: element.getBoundingClientRect().top - top,
        }),
      );
      const first = container.querySelector<HTMLElement>('.transcript-item')?.dataset.seqFirst;
      const atBottom =
        container.scrollHeight - container.scrollTop - container.clientHeight <= BOTTOM_SLACK_PX;
      const readLine = atBottom ? container.clientHeight : READ_LINE_PX;
      setCurrent(
        currentChapter(
          chapters,
          anchors,
          first === undefined ? undefined : Number(first),
          readLine,
        ),
      );
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    measure();
    container.addEventListener('scroll', schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    return () => {
      cancelAnimationFrame(frame);
      container.removeEventListener('scroll', schedule);
      observer.disconnect();
    };
  }, [containerRef, chapters]);
  return current;
}
