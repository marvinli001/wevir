import { cn } from 'cn';
import { CircleAlert, CircleCheck, LoaderCircle, TriangleAlert, X } from 'lucide-react';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { IconButton } from '@/components/icon-button';
import { t } from '@/i18n';

/** 离场动画的时长（与 className 里的 duration-150 一致），动画事件没来时按它卸载。 */
const EXIT_MS = 150;

/** 前面的图标：进行中是转动的圈，完成是对勾，出错是警示，等用户处理（U31 的审批、提问）是提醒。 */
export type ToastTone = 'progress' | 'success' | 'danger' | 'attention';

/**
 * 窗口右下角的通知区（U25）：一列浮起的卡片，从下往上叠。容器本身不接收指针，只有卡片接收，空白处不挡下面的界面。
 * 层级高于对话框（z-50），对话框开着时断线也看得到。
 */
export function ToastViewport({ children }: { children: ReactNode }) {
  return (
    <section
      aria-label={t('toast.region')}
      className="pointer-events-none fixed right-4 bottom-4 z-60 flex w-[min(22rem,calc(100vw-2rem))] flex-col-reverse gap-2"
    >
      {children}
    </section>
  );
}

/**
 * 一条通知（U25，照 Codex 与 Claude Code 桌面端）：中性的浮层卡片，语气只由前面的图标表达；右上角的关闭按钮。
 * `open` 变成 false 时淡出并右移后卸载，离场时显示的仍是传进来的内容（由调用方保留最后一次）。给了 `duration` 时到点
 * 自动关闭，指针停在卡片上或焦点在里面时暂停，离开后重新计时。
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
  // 调用方每次渲染都给新的 onClose，计时不该因此重来。
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (!open || duration === undefined || held) return;
    const timer = window.setTimeout(() => close.current(), duration);
    return () => window.clearTimeout(timer);
  }, [open, duration, held]);

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
    // biome-ignore lint/a11y/noStaticElementInteractions: 指针与焦点的事件只为暂停自动关闭计时，卡片是 status / alert，本身不是控件。
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      data-testid={testId}
      data-tone={tone}
      className={cn(
        'pointer-events-auto flex items-start gap-2.5 rounded-xl bg-popover py-3 pr-2.5 pl-3.5 text-popover-foreground shadow-md ring-1 ring-foreground/10',
        open
          ? 'animate-in fade-in slide-in-from-bottom-2 duration-200 ease-smooth'
          : 'animate-out fade-out slide-out-to-right-4 fill-mode-forwards duration-150 ease-smooth',
      )}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setHeld(false);
      }}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget && !open) mounted.unmount();
      }}
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
