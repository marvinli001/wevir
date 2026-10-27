import { cn } from 'cn';
import { memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { OpenFileLink } from '@/files/file-links';
import { useReducedMotion } from '@/fx/motion';
import { t } from '@/i18n';
import { platformApi } from '@/platform/platform';
import { MarkdownSessionLinks } from '../session-link';
import { highlightCodeBlocks, whenNearViewport } from './highlight';
import {
  createStreamingMarkdownRenderer,
  type MarkdownBlockHtml,
  renderMarkdownHtml,
} from './markdown';
import { restoreCspStyles, useMermaidEnhancer } from './mermaid';
import {
  FRESH_FADE_MS,
  type FreshRange,
  REVEAL_FRAME_MS,
  revealStep,
  trackFresh,
  wrapFresh,
} from './reveal';

/**
 * 文件窗格里的 Markdown（0.32.0）：公式、Mermaid 图与会话目录里的图片。`render` 是 markdown-document.ts 的 renderDocumentHtml
 * （由文件窗格传进来，KaTeX 不进启动时的主块），`imageUrl` 向 Host 要会话目录里一张图片的地址。
 */
export interface DocumentMarkdown {
  render(text: string): string;
  imageUrl(path: string): Promise<string | undefined>;
}

const COPIED_RESET_MS = 2000;

/**
 * 流式时显示的文字（reveal.ts）：挂载时已有的字直接显示，之后收到的按帧放出；写完以后放完剩下的、再等最后的淡入结束，`live`
 * 才变 false（换成整篇渲染）。减弱动效或 `smooth` 关掉时不缓冲，窗口看不见时直接显示到最新。
 */
function useStreamingReveal(
  text: string,
  streaming: boolean,
  smooth: boolean,
): { shown: string; live: boolean; animate: boolean } {
  const reduced = useReducedMotion();
  const animate = smooth && !reduced;
  const [length, setLength] = useState(text.length);
  const [settled, setSettled] = useState(!streaming);
  if (streaming && settled) setSettled(false);
  const textRef = useRef(text);
  textRef.current = text;
  const streamingRef = useRef(streaming);
  streamingRef.current = streaming;
  const shownLength = Math.min(length, text.length);
  const running = animate && !settled && (streaming || shownLength < text.length);

  useEffect(() => {
    if (!running) return;
    let last = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      if (now - last >= REVEAL_FRAME_MS) {
        const elapsed = now - last;
        last = now;
        const target = textRef.current;
        setLength((shown) =>
          revealStep(Math.min(shown, target.length), target, elapsed, !streamingRef.current),
        );
      }
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [running]);

  // 窗口看不见时 requestAnimationFrame 停了：直接显示到最新，回来时不用补放。
  useEffect(() => {
    if (running && document.visibilityState === 'hidden') setLength(text.length);
  }, [running, text]);

  const finished = !streaming && (!animate || shownLength >= text.length);
  useEffect(() => {
    if (!finished || settled) return;
    if (!animate) {
      setSettled(true);
      return;
    }
    const timer = window.setTimeout(() => setSettled(true), FRESH_FADE_MS);
    return () => window.clearTimeout(timer);
  }, [finished, settled, animate]);

  const live = animate ? !settled : streaming;
  return { shown: live && animate ? text.slice(0, shownLength) : text, live, animate };
}

/**
 * 助手消息的 Markdown。流式时每个顶层块一份 HTML，新片段只重渲染它落进的末尾块（markdown.ts），收到的字按帧放出、新字
 * 淡入（`smooth`，默认开；reveal.ts）；定稿后整篇渲染一次，代码块进入视口附近时再高亮。块包在 `display: contents` 的 div
 * 里，样式（styles/markdown.css）不受分块影响。代码块的“复制”、外部链接与文件链接（U32，交给 OpenFileLink）用事件委托处理。
 */
export const MarkdownView = memo(function MarkdownView({
  text,
  streaming,
  smooth = true,
  className,
  document: documentMode,
  quotable = false,
}: {
  text: string;
  streaming: boolean;
  /** 选中里面的文字时可以引用（消息里选中文字的工具条，session/selection-toolbar.tsx）。 */
  quotable?: boolean;
  /** 流式时缓冲放字并淡入新字；思考过程这类收着看的关掉。 */
  smooth?: boolean;
  className?: string;
  document?: DocumentMarkdown;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { shown, live, animate } = useStreamingReveal(text, streaming, smooth);
  const renderer = useMemo(() => createStreamingMarkdownRenderer(), []);
  // 事件委托只注册一次，打开文件的方式经 ref 取最新的。
  const openFileLink = useContext(OpenFileLink);
  const openFileRef = useRef(openFileLink);
  openFileRef.current = openFileLink;
  const blocks = useMemo<MarkdownBlockHtml[]>(
    () =>
      documentMode
        ? [{ __html: documentMode.render(text) }]
        : live
          ? renderer.render(shown)
          : [{ __html: renderMarkdownHtml(text) }],
    [live, renderer, shown, text, documentMode],
  );

  // 新放出的字淡入：只处理这一帧换了 HTML 的块（都在末尾），在它们里面把还在淡入的字包起来。
  const freshRef = useRef<FreshRange[]>([]);
  const lengthRef = useRef<number | undefined>(undefined);
  const blocksRef = useRef<MarkdownBlockHtml[]>([]);
  useLayoutEffect(() => {
    const root = rootRef.current;
    const previous = blocksRef.current;
    blocksRef.current = blocks;
    if (!root || !live || !animate) {
      freshRef.current = [];
      lengthRef.current = undefined;
      return;
    }
    const now = performance.now();
    const length = root.textContent?.length ?? 0;
    const ranges = trackFresh(freshRef.current, lengthRef.current ?? length, length, now);
    freshRef.current = ranges;
    lengthRef.current = length;
    if (ranges.length === 0) return;
    const from = Math.min(...ranges.map((range) => range.start));
    let offset = length;
    for (let index = root.children.length - 1; index >= 0 && offset > from; index--) {
      const child = root.children[index] as Element;
      offset -= child.textContent?.length ?? 0;
      if (blocks[index] !== previous[index]) wrapFresh(child, offset, ranges, now);
    }
  }, [blocks, live, animate]);
  useMermaidEnhancer(rootRef, blocks, documentMode !== undefined);

  // 文件窗格：KaTeX 的 style 经 CSSOM 补回，图片向 Host 要地址。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 内容（blocks）换了要对新的 DOM 重新做。
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !documentMode) return;
    restoreCspStyles(root);
    let stopped = false;
    for (const image of root.querySelectorAll<HTMLImageElement>('img[data-file-image]')) {
      const path = image.dataset.fileImage;
      if (path === undefined) continue;
      void documentMode.imageUrl(path).then((url) => {
        if (!stopped && url !== undefined) image.src = url;
      });
    }
    return () => {
      stopped = true;
    };
  }, [blocks, documentMode]);

  useEffect(() => {
    if (!live) renderer.reset();
  }, [live, renderer]);

  // 高亮：定稿后、进入视口附近时做一次（流式中的代码块还在变，不高亮）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 内容（blocks）换了要对新的 DOM 重新做。
  useEffect(() => {
    const root = rootRef.current;
    if (live || !root || !root.querySelector('pre code')) return;
    return whenNearViewport(root, () => void highlightCodeBlocks(root));
  }, [live, blocks]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const timers = new Map<HTMLButtonElement, number>();
    const onClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const copy = event.target.closest<HTMLButtonElement>('[data-code-copy]');
      if (copy && root.contains(copy)) {
        event.preventDefault();
        const code = copy.closest('[data-code-block]')?.querySelector('code')?.textContent ?? '';
        void platformApi()
          .copyText(code)
          .then(() => {
            copy.textContent = t('markdown.copied');
            window.clearTimeout(timers.get(copy));
            timers.set(
              copy,
              window.setTimeout(() => {
                copy.textContent = t('markdown.copyCode');
              }, COPIED_RESET_MS),
            );
          });
        return;
      }
      const link = event.target.closest<HTMLAnchorElement>('a[data-external-link]');
      if (link && root.contains(link)) {
        // 渲染进程不导航：交给主进程用系统浏览器打开（只接受 http、https、mailto）。
        event.preventDefault();
        void platformApi().openExternal(link.href);
        return;
      }
      const fileLink = event.target.closest<HTMLAnchorElement>('a[data-file-link]');
      if (fileLink && root.contains(fileLink)) {
        event.preventDefault();
        openFileRef.current?.(fileLink.dataset.fileLink ?? '');
      }
    };
    root.addEventListener('click', onClick);
    return () => {
      root.removeEventListener('click', onClick);
      for (const timer of timers.values()) window.clearTimeout(timer);
    };
  }, []);

  return (
    <>
      <div
        ref={rootRef}
        className={cn('markdown', className)}
        data-streaming={live || undefined}
        data-quotable={quotable ? '' : undefined}
      >
        {blocks.map((block, index) => (
          // 块的身份就是它在文档里的位置：流式时只有末尾的块会换对象。
          // biome-ignore lint/suspicious/noArrayIndexKey: 见上。
          // biome-ignore lint/security/noDangerouslySetInnerHtml: HTML 由 marked 生成并经 DOMPurify 清洗。
          <div key={index} className="contents" dangerouslySetInnerHTML={block} />
        ))}
      </div>
      {/* 放在根元素外面：根元素的子元素与 blocks 一一对应（新字淡入按位置找块）。 */}
      <MarkdownSessionLinks root={rootRef} version={blocks} />
    </>
  );
});
