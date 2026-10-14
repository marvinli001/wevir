import { cn } from 'cn';
import { ArrowLeft, ArrowRight, PanelLeft } from 'lucide-react';
import type { Ref } from 'react';
import { IconButton } from '@/components/icon-button';
import { t } from '@/i18n';
import { useHistoryNav } from '@/lib/history-nav';
import { formatShortcut, SHORTCUTS } from '@/lib/shortcuts';

/**
 * 窗口左上角紧跟红绿灯的一组按钮（U5，照 Codex 桌面端）：后退、前进，工作台里还有侧栏开关。宽度固定是
 * `--window-controls-width`（index.css），顶栏据此让位。`onBack`：历史里退无可退时后退做什么（设置页回首页）。
 */
export function WindowControls({
  sidebar,
  onBack,
  className,
}: {
  sidebar?: { open: boolean; onToggle: () => void; ref?: Ref<HTMLButtonElement> };
  onBack?: () => void;
  className?: string;
}) {
  const history = useHistoryNav();
  const canBack = history.canBack || onBack !== undefined;
  return (
    <div className={cn('flex items-center gap-0.5', className)}>
      <IconButton
        label={t('layout.back')}
        shortcut={formatShortcut(SHORTCUTS.back)}
        disabled={!canBack}
        onClick={() => (history.canBack ? history.back() : onBack?.())}
        tooltipSide="bottom"
        className="text-muted-foreground"
      >
        <ArrowLeft />
      </IconButton>
      <IconButton
        label={t('layout.forward')}
        shortcut={formatShortcut(SHORTCUTS.forward)}
        disabled={!history.canForward}
        onClick={history.forward}
        tooltipSide="bottom"
        className="text-muted-foreground"
      >
        <ArrowRight />
      </IconButton>
      {sidebar && (
        <IconButton
          ref={sidebar.ref}
          label={t(sidebar.open ? 'layout.collapseSidebar' : 'layout.expandSidebar')}
          shortcut={formatShortcut(SHORTCUTS.toggleSidebar)}
          aria-pressed={sidebar.open}
          onClick={sidebar.onToggle}
          tooltipSide="bottom"
          className="text-muted-foreground"
        >
          <PanelLeft />
        </IconButton>
      )}
    </div>
  );
}
