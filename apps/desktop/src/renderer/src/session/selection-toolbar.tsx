// 消息里选中文字时浮在选区旁的工具条（desktop-tokens §57，照 Codex 与 Claude 桌面端）：“添加到对话”把选中的文字作为引用放进
// 输入框，“支线提问”分出支线、引用放进支线窗格的输入框。判断与位置在 selection-model.ts，这里只做 DOM：原生的 Selection /
// Range、事件与渲染。
//
// 选区只认带 `data-quotable` 的区域（回答的文字、用户消息），两端要落在同一个区域里；代码块头部（语言与“复制代码”）用
// `user-select: none` 不在选区里。拖选时不显示，松手（pointerup）后显示；`selectionchange` 与 `pointerup` 都会触发判断，
// Windows 上两者的先后不定。流式输出重渲染选区所在的块时，选区按区域内的文字偏移还原。

import { cn } from 'cn';
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { t } from '@/i18n';
import { quotableText, type Rect, toolbarPlacement } from './selection-model';

/** 可引用的区域（回答的一段文字、一条用户消息）。 */
export const QUOTABLE_ATTRIBUTE = 'data-quotable';
const QUOTABLE_SELECTOR = `[${QUOTABLE_ATTRIBUTE}]`;
/** 选区落在这些元素里不显示工具条。 */
const BLOCKED_SELECTOR = 'button, input, textarea, select, [contenteditable], [data-no-quote]';

export interface QuoteActions {
  /** 追加到输入框。 */
  onAdd(text: string): void;
  /** 分出支线提问；会话不能分支时没有。 */
  onSide?: (text: string) => void;
}

interface Anchor {
  text: string;
  first: Rect;
  last: Rect;
  bounds: Rect;
}

/** 选区在区域里的文字偏移，流式重渲染把选区弄丢时按它还原。 */
interface Recorded {
  region: Element;
  start: number;
  end: number;
  raw: string;
}

export function SelectionToolbar({
  containerRef,
  sessionId,
  actions,
}: {
  /** 消息流的滚动容器：选区要在它里面，滚动与尺寸变化也看它。 */
  containerRef: RefObject<HTMLElement | null>;
  sessionId: string;
  actions: QuoteActions;
}) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const visibleText = useRef<string>(undefined);
  visibleText.current = anchor?.text;

  // biome-ignore lint/correctness/useExhaustiveDependencies: 换会话时重新挂；其余经 ref 取最新的。
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setAnchor(null);
    let pointerDown = false;
    /** 用户滚动或按了 Esc 之后收起的那段选中文字：选区不变就不再显示，换了选区或松开鼠标再显示。 */
    let dismissed: string | undefined;
    let recorded: Recorded | null = null;
    let frame = 0;

    const hide = () => {
      recorded = null;
      setAnchor(null);
    };

    const evaluate = () => {
      frame = 0;
      if (pointerDown) return;
      const selection = document.getSelection();
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return hide();
      const range = selection.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) return hide();
      const end = effectiveEnd(range);
      const startRegion = regionOf(range.startContainer);
      const text = quotableText({
        text: selection.toString(),
        collapsed: false,
        start: startRegion,
        end: regionOf(end.node),
        blocked: isBlocked(range.startContainer) || isBlocked(end.node),
      });
      if (text === undefined || startRegion === null) return hide();
      recorded = recordOffsets(startRegion, range, end);
      if (text === dismissed) return setAnchor(null);
      const rects = Array.from(range.getClientRects()).filter(
        (rect) => rect.width > 0 || rect.height > 0,
      );
      const first = rects[0];
      const last = rects[rects.length - 1];
      if (!first || !last) return setAnchor(null);
      const box = container.getBoundingClientRect();
      const next: Anchor = {
        text,
        first: toRect(first),
        last: toRect(last),
        bounds: {
          left: Math.max(box.left, 0),
          top: Math.max(box.top, 0),
          right: Math.min(box.right, window.innerWidth),
          bottom: Math.min(box.bottom, window.innerHeight),
        },
      };
      setAnchor((current) => (current && sameAnchor(current, next) ? current : next));
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(evaluate);
    };

    // 流式输出换掉选区所在的块时浏览器把选区折叠了：区域里的文字没变，就按偏移还原；选区还在则只重新量位置（排版可能动了）。
    const observer = new MutationObserver(() => {
      if (pointerDown || recorded === null) return;
      const selection = document.getSelection();
      if (
        selection &&
        selection.rangeCount > 0 &&
        !selection.isCollapsed &&
        container.contains(selection.anchorNode)
      ) {
        schedule();
        return;
      }
      const restored = restoreSelection(recorded);
      if (restored) schedule();
      else hide();
    });
    observer.observe(container, { childList: true, subtree: true, characterData: true });

    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && toolbarRef.current?.contains(event.target)) return;
      pointerDown = true;
      dismissed = undefined;
      hide();
    };
    const onPointerUp = () => {
      pointerDown = false;
      dismissed = undefined;
      schedule();
    };
    const onPointerCancel = () => {
      pointerDown = false;
    };
    const onSelectionChange = () => {
      if (!pointerDown) schedule();
    };
    const dismiss = () => {
      dismissed = visibleText.current;
      hide();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.isComposing) return;
      const toolbar = toolbarRef.current;
      if (visibleText.current === undefined || !toolbar) return;
      if (event.key === 'Escape') {
        // 只收起工具条，不让同一下 Esc 再停掉进行中的回合（输入框的 Esc 监听看 defaultPrevented）。
        event.preventDefault();
        if (toolbar.contains(document.activeElement)) container.focus({ preventScroll: true });
        dismiss();
        return;
      }
      const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
      if (event.key === 'Tab' && plain && !toolbar.contains(document.activeElement)) {
        // 焦点在消息流上（或没有焦点）时 Tab 进入工具条。
        if (document.activeElement === container || document.activeElement === document.body) {
          event.preventDefault();
          toolbar.querySelector('button')?.focus({ preventScroll: true });
        }
        return;
      }
      if (
        plain &&
        event.target === container &&
        ['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' '].includes(event.key)
      ) {
        dismiss();
      }
    };
    // 用户自己滚动（滚轮、触摸）引起的 scroll 收起工具条；贴底跟随流式输出的程序滚动、尺寸变化只重新量位置。滚轮没有真的
    // 滚动（已在尽头）时不收起。
    let userScrollUntil = 0;
    const onUserScroll = () => {
      userScrollUntil = performance.now() + 200;
    };
    const onScroll = () => {
      if (performance.now() < userScrollUntil && visibleText.current !== undefined) dismiss();
      else schedule();
    };
    const onViewportChange = () => schedule();

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('pointercancel', onPointerCancel, true);
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('blur', onPointerCancel);
    window.addEventListener('resize', onViewportChange);
    container.addEventListener('scroll', onScroll, { passive: true });
    container.addEventListener('wheel', onUserScroll, { passive: true });
    container.addEventListener('touchmove', onUserScroll, { passive: true });
    const resizeObserver = new ResizeObserver(onViewportChange);
    resizeObserver.observe(container);
    schedule();

    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('pointercancel', onPointerCancel, true);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('blur', onPointerCancel);
      window.removeEventListener('resize', onViewportChange);
      container.removeEventListener('scroll', onScroll);
      container.removeEventListener('wheel', onUserScroll);
      container.removeEventListener('touchmove', onUserScroll);
      resizeObserver.disconnect();
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [containerRef, sessionId]);

  // 量出工具条的实际大小再放位置（在绘制之前，不闪）；选区滚出了可见区域时收起。
  useLayoutEffect(() => {
    const element = toolbarRef.current;
    if (!element || !anchor) return;
    const placement = toolbarPlacement(
      anchor.first,
      anchor.last,
      { width: element.offsetWidth, height: element.offsetHeight },
      anchor.bounds,
      { width: window.innerWidth, height: window.innerHeight },
    );
    if (!placement) {
      setAnchor(null);
      return;
    }
    element.style.left = `${placement.left}px`;
    element.style.top = `${placement.top}px`;
    element.dataset.side = placement.side;
  }, [anchor]);

  if (!anchor) return null;

  const { onAdd, onSide } = actions;
  const run = (action: (text: string) => void) => {
    const { text } = anchor;
    document.getSelection()?.removeAllRanges();
    setAnchor(null);
    action(text);
  };
  // Tab、方向键只在工具条的按钮之间走（role="toolbar" 的惯例）；Esc 由文档上的监听处理。
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys = ['Tab', 'ArrowLeft', 'ArrowRight'];
    if (!keys.includes(event.key) || event.metaKey || event.ctrlKey || event.altKey) return;
    const buttons = Array.from(event.currentTarget.querySelectorAll('button'));
    const index = buttons.findIndex((button) => button === document.activeElement);
    const backward = event.key === 'ArrowLeft' || (event.key === 'Tab' && event.shiftKey);
    event.preventDefault();
    buttons[(index + (backward ? -1 : 1) + buttons.length) % buttons.length]?.focus();
  };

  return createPortal(
    <div
      ref={toolbarRef}
      role="toolbar"
      aria-label={t('selection.label')}
      data-testid="selection-toolbar"
      // 按下时不让选区与焦点离开原处。
      onMouseDown={(event) => event.preventDefault()}
      onKeyDown={onKeyDown}
      // duration-150 也设了 transition-duration，transition-property 默认是 all：量过尺寸再写 left / top 会从左上角的
      // 0, 0 过渡过来，跟随滚动时也慢半拍。位置只能跳变，所以关掉过渡，入场只用 animate-in。
      className="fixed top-0 left-0 z-40 flex items-center gap-0.5 rounded-xl bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 transition-none animate-in fade-in-0 zoom-in-95 duration-150 ease-smooth"
    >
      <ToolbarButton action="quote-add" onClick={() => run(onAdd)}>
        {t('selection.addToChat')}
      </ToolbarButton>
      {onSide && (
        <>
          <span aria-hidden className="h-4 w-px bg-border" />
          <ToolbarButton action="quote-side" onClick={() => run(onSide)}>
            {t('command.btw')}
          </ToolbarButton>
        </>
      )}
    </div>,
    document.body,
  );
}

function ToolbarButton({
  action,
  onClick,
  children,
}: {
  action: string;
  onClick(): void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-action={action}
      onClick={onClick}
      className={cn(
        'h-7 rounded-lg px-2.5 text-sm whitespace-nowrap text-popover-foreground outline-none pressable [--press-scale:0.97]',
        'hover:bg-muted focus-visible:bg-muted focus-visible:focus-ring',
      )}
    >
      {children}
    </button>
  );
}

// ── DOM 辅助 ───────────────────────────────────────────────────────────

function elementOf(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement;
}

function regionOf(node: Node): Element | null {
  return elementOf(node)?.closest(QUOTABLE_SELECTOR) ?? null;
}

function isBlocked(node: Node): boolean {
  return elementOf(node)?.closest(BLOCKED_SELECTOR) != null;
}

/**
 * 选区终点所在的节点与偏移。三击选段落时浏览器把终点放在下一个块的开头（可能是别的消息）：终点在节点开头时退回到前一个
 * 文本节点的末尾，才是真正选到的地方。
 */
function effectiveEnd(range: Range): { node: Node; offset: number } {
  const { endContainer: node, endOffset: offset } = range;
  if (offset > 0 || range.collapsed) return { node, offset };
  const root = range.commonAncestorContainer;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  walker.currentNode = node;
  const previous = walker.previousNode();
  return previous
    ? { node: previous, offset: previous.textContent?.length ?? 0 }
    : { node, offset };
}

function recordOffsets(
  region: Element,
  range: Range,
  end: { node: Node; offset: number },
): Recorded | null {
  if (!region.contains(end.node)) return null;
  const prefix = document.createRange();
  prefix.selectNodeContents(region);
  prefix.setEnd(range.startContainer, range.startOffset);
  const start = prefix.toString().length;
  prefix.setEnd(end.node, end.offset);
  const stop = prefix.toString().length;
  if (stop <= start) return null;
  return { region, start, end: stop, raw: (region.textContent ?? '').slice(start, stop) };
}

/** 区域里的文字没变就把选区放回原来的偏移。 */
function restoreSelection(recorded: Recorded): boolean {
  const { region, start, end, raw } = recorded;
  if (!region.isConnected || (region.textContent ?? '').slice(start, end) !== raw) return false;
  const range = rangeForOffsets(region, start, end);
  const selection = document.getSelection();
  if (!range || !selection) return false;
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

function rangeForOffsets(region: Element, start: number, end: number): Range | null {
  const range = document.createRange();
  const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
  let offset = 0;
  let started = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (!started && start < offset + length) {
      range.setStart(node, start - offset);
      started = true;
    }
    if (started && end <= offset + length) {
      range.setEnd(node, end - offset);
      return range;
    }
    offset += length;
  }
  return null;
}

function toRect(rect: DOMRect): Rect {
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

function sameAnchor(a: Anchor, b: Anchor): boolean {
  return (
    a.text === b.text &&
    sameRect(a.first, b.first) &&
    sameRect(a.last, b.last) &&
    sameRect(a.bounds, b.bounds)
  );
}

function sameRect(a: Rect, b: Rect): boolean {
  return a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
}
