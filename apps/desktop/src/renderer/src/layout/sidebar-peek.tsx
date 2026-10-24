import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { t } from '@/i18n';
import { Sidebar } from './sidebar';

/** 指针停在左边缘这么久才滑出，划过去不触发；离开浮层这么久才收回，从浮层移到边缘或反过来不闪。 */
const OPEN_DELAY_MS = 120;
const CLOSE_DELAY_MS = 240;

/**
 * 收起侧栏的“窥视”（视觉打磨，参照 MonoCode 的 sidebar-peek）：侧栏收起（或窗口太窄、没有停靠）时，指针贴到窗口左边缘，侧栏以
 * 磨砂的浮动卡片从左边滑出来，背后的内容轻微变暗；指针离开卡片就收回，点了其中的链接（换页面）或按 Esc 也收回。卡片不抢焦点、
 * 不挡住窗口按钮（WindowControls 在 z-30，卡片在 z-20，顶上 44 px 是侧栏自己留给窗口按钮的空行），点窗口按钮的侧栏开关照常
 * 停靠侧栏。样式在 index.css 的 sidebar-peek。
 */
export function SidebarPeek({ width }: { width: number }) {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const location = useLocation();

  const later = (next: boolean, delay: number) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(next), delay);
  };
  const cancel = () => clearTimeout(timer.current);

  useEffect(() => () => clearTimeout(timer.current), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在换页面时触发。
  useEffect(() => {
    cancel();
    setOpen(false);
  }, [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      {/* 左边缘的感应条：顶栏以下，宽 6 px；卡片打开后不再需要它。 */}
      <div
        aria-hidden
        className="absolute top-11 bottom-0 left-0 z-20 w-1.5"
        hidden={open}
        onPointerEnter={() => later(true, OPEN_DELAY_MS)}
        onPointerLeave={cancel}
      />
      <div aria-hidden className="sidebar-peek-backdrop" data-open={open || undefined} />
      <aside
        aria-label={t('sidebar.label')}
        aria-hidden={!open}
        inert={!open}
        className="sidebar-peek text-sidebar-foreground"
        data-open={open || undefined}
        style={{ width }}
        onPointerEnter={cancel}
        onPointerLeave={() => later(false, CLOSE_DELAY_MS)}
      >
        <Sidebar />
      </aside>
    </>
  );
}
