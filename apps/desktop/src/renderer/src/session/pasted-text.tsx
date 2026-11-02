// 粘贴的大段文字（0.90.0，规则在 composer-pastes.ts）的界面，照 Codex 桌面端：输入框上方附件条里的卡片（开头几个字与“粘贴的文本”），
// 消息上方的一行胶囊，点开看原文。附件条是一行，放不下时横向滚动，竖着的滚轮也能左右滑。

import { cn } from 'cn';
import { ScanText, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { t } from '@/i18n';
import { lineCount, pastePreview } from './composer-pastes';
import { CopyButton } from './copy-button';

/** 附件右上角的移除键（图片缩略图与粘贴卡片共用），照 Codex 一直显示。 */
export function RemoveAttachmentButton({
  label,
  onClick,
  action,
}: {
  label: string;
  onClick: () => void;
  action: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      data-action={action}
      className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-foreground text-background shadow-xs outline-none transition-opacity duration-150 hover:opacity-85 focus-visible:focus-field"
    >
      <X aria-hidden className="size-3" strokeWidth={2.5} />
    </button>
  );
}

/**
 * 输入框上方的附件条：一行，放不下时横向滚动（不显示滚动条）；竖着的滚轮换成左右滑，新加的附件滚进视野。`count` 是附件个数。
 */
export function AttachmentStrip({ count, children }: { count: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const strip = ref.current;
    if (!strip) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || strip.scrollWidth <= strip.clientWidth) return;
      // 触控板的横向滑动浏览器自己处理。
      if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      event.preventDefault();
      strip.scrollLeft +=
        event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
    };
    strip.addEventListener('wheel', onWheel, { passive: false });
    return () => strip.removeEventListener('wheel', onWheel);
  }, []);
  const previous = useRef(count);
  useEffect(() => {
    const strip = ref.current;
    if (strip && count > previous.current) {
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      strip.scrollTo({ left: strip.scrollWidth, behavior: reduced ? 'auto' : 'smooth' });
    }
    previous.current = count;
  }, [count]);
  return (
    <div
      ref={ref}
      // 上与右留出移除键探出去的位置（滚动容器会裁掉溢出）。
      className="flex gap-2 overflow-x-auto overscroll-x-contain px-3.5 pt-3 pb-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      data-testid="composer-attachments"
    >
      {children}
    </div>
  );
}

/** 附件条里的一段粘贴：开头几个字与“粘贴的文本 · N 行”，点开看原文，右上角移除。 */
export function ComposerPasteChip({
  text,
  onOpen,
  onRemove,
}: {
  text: string;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const label = t('transcript.pastedText', { lines: lineCount(text) });
  return (
    <div className="relative h-14 w-56 shrink-0" data-testid="composer-paste">
      <button
        type="button"
        onClick={onOpen}
        aria-label={label}
        className="flex size-full items-center gap-2.5 rounded-xl border border-border bg-muted/50 px-2 text-left outline-none transition-colors duration-150 hover:bg-muted focus-visible:focus-field"
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-background text-soft-foreground">
          <ScanText aria-hidden className="size-4.5" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium text-foreground">{pastePreview(text)}</span>
          <span className="truncate text-xs text-muted-foreground">{label}</span>
        </span>
      </button>
      <RemoveAttachmentButton
        label={t('composer.removeAttachment')}
        action="remove-paste"
        onClick={onRemove}
      />
    </div>
  );
}

/** 消息上方的粘贴（照 Codex 发出去的附件）：一行胶囊，开头几个字，点开看原文。 */
export function MessagePastes({
  texts,
  className,
}: {
  texts: readonly string[];
  className?: string | undefined;
}) {
  const [open, setOpen] = useState<string>();
  return (
    <div
      className={cn('flex max-w-[85%] flex-wrap justify-end gap-1.5', className)}
      data-testid="message-pastes"
    >
      {texts.map((text, index) => (
        <button
          // biome-ignore lint/suspicious/noArrayIndexKey: 段落的顺序与内容不变
          key={index}
          type="button"
          onClick={() => setOpen(text)}
          aria-label={`${pastePreview(text)} · ${t('transcript.pastedText', { lines: lineCount(text) })}`}
          className="flex h-9 max-w-60 min-w-0 items-center gap-2 rounded-xl border border-border bg-card px-3 text-sm text-soft-foreground outline-none transition-colors duration-150 hover:text-foreground focus-visible:focus-ring"
          data-pasted-block=""
        >
          <ScanText aria-hidden className="size-4 shrink-0" />
          <span className="min-w-0 truncate">{pastePreview(text)}</span>
        </button>
      ))}
      <PastedTextPreview text={open} onClose={() => setOpen(undefined)} />
    </div>
  );
}

/** 点开的粘贴原文。 */
export function PastedTextPreview({
  text,
  onClose,
}: {
  text: string | undefined;
  onClose: () => void;
}) {
  return (
    <Dialog open={text !== undefined} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        className="flex max-h-[85vh] flex-col gap-3 sm:max-w-2xl"
        data-testid="paste-preview"
      >
        <div className="flex items-center gap-2 pr-8">
          <DialogTitle className="min-w-0 flex-1 truncate text-sm">
            {text !== undefined && t('transcript.pastedText', { lines: lineCount(text) })}
          </DialogTitle>
          {text !== undefined && <CopyButton text={text} className="text-muted-foreground" />}
        </div>
        <pre className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-muted/40 px-3 py-2 font-mono text-xs whitespace-pre-wrap break-words">
          {text}
        </pre>
      </DialogContent>
    </Dialog>
  );
}
