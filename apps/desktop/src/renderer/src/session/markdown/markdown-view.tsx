import { cn } from 'cn';
import { memo, useContext, useEffect, useMemo, useRef } from 'react';
import { OpenFileLink } from '@/files/file-links';
import { t } from '@/i18n';
import { highlightCodeBlocks, whenNearViewport } from './highlight';
import {
  createStreamingMarkdownRenderer,
  type MarkdownBlockHtml,
  renderMarkdownHtml,
} from './markdown';
import { restoreCspStyles, useMermaidEnhancer } from './mermaid';

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
 * 助手消息的 Markdown。流式时每个顶层块一份 HTML，新片段只重渲染它落进的末尾块（markdown.ts）；定稿后整篇
 * 渲染一次，代码块进入视口附近时再高亮。块包在 `display: contents` 的 div 里，样式（styles/markdown.css）
 * 不受分块影响。代码块的“复制”、外部链接与文件链接（U32，交给 OpenFileLink）用事件委托处理。
 */
export const MarkdownView = memo(function MarkdownView({
  text,
  streaming,
  className,
  document: documentMode,
}: {
  text: string;
  streaming: boolean;
  className?: string;
  document?: DocumentMarkdown;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const renderer = useMemo(() => createStreamingMarkdownRenderer(), []);
  // 事件委托只注册一次，打开文件的方式经 ref 取最新的。
  const openFileLink = useContext(OpenFileLink);
  const openFileRef = useRef(openFileLink);
  openFileRef.current = openFileLink;
  const blocks = useMemo<MarkdownBlockHtml[]>(
    () =>
      documentMode
        ? [{ __html: documentMode.render(text) }]
        : streaming
          ? renderer.render(text)
          : [{ __html: renderMarkdownHtml(text) }],
    [streaming, renderer, text, documentMode],
  );
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
    if (!streaming) renderer.reset();
  }, [streaming, renderer]);

  // 高亮：定稿后、进入视口附近时做一次（流式中的代码块还在变，不高亮）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 内容（blocks）换了要对新的 DOM 重新做。
  useEffect(() => {
    const root = rootRef.current;
    if (streaming || !root || !root.querySelector('pre code')) return;
    return whenNearViewport(root, () => void highlightCodeBlocks(root));
  }, [streaming, blocks]);

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
        void window.wevir.copyText(code).then(() => {
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
        void window.wevir.openExternal(link.href);
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
    <div
      ref={rootRef}
      className={cn('markdown', className)}
      data-streaming={streaming || undefined}
    >
      {blocks.map((block, index) => (
        // 块的身份就是它在文档里的位置：流式时只有末尾的块会换对象。
        // biome-ignore lint/suspicious/noArrayIndexKey: 见上。
        // biome-ignore lint/security/noDangerouslySetInnerHtml: HTML 由 marked 生成并经 DOMPurify 清洗。
        <div key={index} className="contents" dangerouslySetInnerHTML={block} />
      ))}
    </div>
  );
});
