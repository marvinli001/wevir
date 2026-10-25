// 叠放的布局改写自 kuratlielia/arc-library registry/components/toast-stack/toast-stack.tsx 的 layoutStack
// （MIT License，Copyright (c) 2026 Elia Kuratli，来源提交 fff39c044c6e3b86006e3a6acc9a32a821a80d99）。
// 由 Wevir 修改：不用 motion，通知区量出各卡片的高度、把位置与缩放写进卡片的 CSS 变量，平移、缩放、高度走 theme.css 的
// snap 弹簧；卡片仍由各自的组件挂在通知区里（连接、动作结果、会话通知），按出现的先后排；没有滑动关闭与点按展开。

import { cn } from 'cn';
import { CircleAlert, CircleCheck, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { IconButton } from '@/components/icon-button';
import { t } from '@/i18n';

/** 离场动画的时长（与 className 里的 duration-150 一致），动画事件没来时按它卸载。 */
const EXIT_MS = 150;

/** 收起时后面的卡片各露出多少（px）、各缩小多少；最多叠几张（再往后的隐藏）；展开时卡片之间的间距。 */
const PEEK = 10;
const STEP = 0.05;
const VISIBLE = 3;
const GAP = 8;

/** 前面的图标：进行中是转动的圈，完成是对勾，出错是警示，等用户处理（U31 的审批、提问）是提醒。 */
export type ToastTone = 'progress' | 'success' | 'danger' | 'attention';

/** 通知区展开着（指针在上面或焦点在里面）：所有卡片暂停自动关闭。 */
const StackExpanded = createContext(false);

/** 卡片出现的先后：越大越新，最新的在最前面。 */
let toastSeq = 0;

/**
 * 窗口右下角的通知区（U25）：最新的一张在最前，之前的缩小叠在它后面、各露出一条边（最多叠三张）；指针移上来或键盘焦点
 * 进来时展开成一列，离开后收回（照 Arc 的 toast-stack 与 Sonner）。收起时容器不接收指针、只有卡片接收，空白处不挡下面的
 * 界面；展开时整列都接收，卡片之间的空隙不会让它收回。层级高于对话框（z-50），对话框开着时断线也看得到。
 */
export function ToastViewport({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const expanded = hovered || focused;

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const layout = () => {
      const live = Array.from(root.querySelectorAll<HTMLElement>('[data-toast]'))
        .filter((card) => card.dataset.closing === undefined)
        .sort((a, b) => Number(b.dataset.toastSeq) - Number(a.dataset.toastSeq));
      const heights = live.map(
        (card) => card.querySelector<HTMLElement>('[data-toast-body]')?.offsetHeight ?? 0,
      );
      const front = heights[0] ?? 0;
      let top = 0;
      live.forEach((card, index) => {
        const height = heights[index] ?? 0;
        const depth = Math.min(index, VISIBLE - 1);
        const visible = index < VISIBLE;
        const y = expanded ? -top : -PEEK * depth;
        card.style.setProperty('--toast-y', `${y}px`);
        card.style.setProperty('--toast-scale', String(expanded ? 1 : 1 - STEP * depth));
        // 收起时后面的卡片取最前那张的高度，边缘对齐；内容隐去。
        card.style.setProperty('--toast-h', `${expanded || index === 0 ? height : front}px`);
        card.style.zIndex = String(live.length - index);
        card.toggleAttribute('data-tucked', !expanded && index > 0);
        card.toggleAttribute('data-hidden', !visible);
        card.inert = !visible;
        if (visible) top += height + GAP;
      });
      const shown = Math.min(live.length, VISIBLE);
      root.style.height =
        shown === 0 ? '0px' : `${expanded ? top - GAP : front + PEEK * (shown - 1)}px`;
    };
    layout();
    const resize = new ResizeObserver(layout);
    const observeBodies = () => {
      resize.disconnect();
      for (const body of root.querySelectorAll('[data-toast-body]')) resize.observe(body);
    };
    observeBodies();
    const mutation = new MutationObserver(() => {
      observeBodies();
      layout();
    });
    mutation.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-closing'],
    });
    return () => {
      resize.disconnect();
      mutation.disconnect();
    };
  }, [expanded]);

  return (
    <StackExpanded.Provider value={expanded}>
      <section
        ref={ref}
        aria-label={t('toast.region')}
        className={cn(
          'fixed right-4 bottom-4 z-60 w-[min(22rem,calc(100vw-2rem))]',
          expanded ? 'pointer-events-auto' : 'pointer-events-none',
        )}
        onPointerEnter={(event) => {
          if (event.pointerType === 'mouse') setHovered(true);
        }}
        onPointerLeave={() => setHovered(false)}
        onFocus={(event) => {
          if (event.target.matches(':focus-visible')) setFocused(true);
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false);
        }}
      >
        {children}
      </section>
    </StackExpanded.Provider>
  );
}

/**
 * 一条通知（U25，照 Codex 与 Claude Code 桌面端）：中性的浮层卡片，语气只由前面的图标表达；右上角的关闭按钮。
 * `open` 变成 false 时淡出并右移后卸载，离场时显示的仍是传进来的内容（由调用方保留最后一次）。给了 `duration` 时到点
 * 自动关闭，指针停在卡片上、焦点在里面或通知区展开着时暂停，离开后重新计时。位置、缩放与高度由通知区写进 `--toast-*`；
 * 从关着变成开着时算作新出现的一张，排到最前面。
 */
export function Toast({
  open,
  tone,
  title,
  children,
  duration,
  onClose,
  testId,
}: {
  open: boolean;
  tone: ToastTone;
  title: ReactNode;
  /** 标题下面的说明、操作。 */
  children?: ReactNode;
  duration?: number;
  onClose: () => void;
  testId?: string;
}) {
  const mounted = usePresence(open);
  const [held, setHeld] = useState(false);
  const stackExpanded = useContext(StackExpanded);
  const card = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) seq.current = ++toastSeq;
  wasOpen.current = open;
  // 调用方每次渲染都给新的 onClose，计时不该因此重来。
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open || duration === undefined || held || stackExpanded) return;
    const timer = window.setTimeout(() => close.current(), duration);
    return () => window.clearTimeout(timer);
  }, [open, duration, held, stackExpanded]);

  if (!mounted.current) return null;
  const Icon =
    tone === 'danger'
      ? TriangleAlert
      : tone === 'success'
        ? CircleCheck
        : tone === 'attention'
          ? CircleAlert
          : LoaderCircle;
  return (
    // 外层是叠放的位置（通知区写的 --toast-*，snap 弹簧），里层是卡片本身与入场、离场动画，两边的过渡与动画互不干扰。
    // biome-ignore lint/a11y/noStaticElementInteractions: 指针与焦点的事件只为暂停自动关闭计时，卡片是 status / alert，本身不是控件。
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      data-testid={testId}
      data-tone={tone}
      data-toast
      data-toast-seq={seq.current}
      data-closing={open ? undefined : ''}
      className="pointer-events-auto absolute inset-x-0 bottom-0 h-(--toast-h,auto) origin-top translate-y-(--toast-y,0) scale-(--toast-scale,1) transition-[translate,scale,height,opacity] duration-(--spring-snap-duration) ease-spring-snap data-hidden:opacity-0"
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setHeld(false);
      }}
      onAnimationEnd={(event) => {
        if (event.target === card.current && !open) mounted.unmount();
      }}
    >
      <div
        ref={card}
        className={cn(
          'h-full overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10',
          open
            ? 'animate-in fade-in slide-in-from-bottom-2 duration-200 ease-smooth'
            : 'animate-out fade-out slide-out-to-right-4 fill-mode-forwards duration-150 ease-smooth',
        )}
      >
        <div
          data-toast-body
          className="flex items-start gap-2.5 py-3 pr-2.5 pl-3.5 transition-opacity duration-150 ease-smooth in-data-tucked:opacity-0"
        >
          <Icon
            aria-hidden
            className={cn(
              'mt-0.5 size-4 shrink-0',
              tone === 'progress' && 'animate-spin text-muted-foreground',
              tone === 'success' && 'text-success',
              tone === 'danger' && 'text-destructive',
              tone === 'attention' && 'text-warning',
            )}
          />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-base leading-snug break-words">{title}</p>
            {children}
          </div>
          <IconButton
            label={t('common.close')}
            size="icon-xs"
            className="-my-0.5 shrink-0 text-muted-foreground"
            onClick={onClose}
          >
            <X />
          </IconButton>
        </div>
      </div>
    </div>
  );
}

/** 打开时立即挂上；关闭后等离场动画结束再卸载（动画事件不一定来，例如窗口被遮住时，到点也卸载）。 */
function usePresence(open: boolean): { current: boolean; unmount: () => void } {
  const [mounted, setMounted] = useState(open);
  useLayoutEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  useEffect(() => {
    if (open || !mounted) return;
    const timer = window.setTimeout(() => setMounted(false), EXIT_MS + 50);
    return () => window.clearTimeout(timer);
  }, [open, mounted]);
  return { current: mounted, unmount: () => setMounted(false) };
}
