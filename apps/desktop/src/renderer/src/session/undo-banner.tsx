// 输入框上方的“已撤销”横幅（0.51.0，desktop-tokens §58）：撤销之后、会话没开始新回合之前显示撤销了几个回合，右边是重做。

import { Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { t } from '@/i18n';

export function UndoBanner({
  count,
  disabled,
  onRedo,
}: {
  /** 能重做的回合数。 */
  count: number;
  disabled: boolean;
  onRedo: () => void;
}) {
  return (
    <section
      aria-label={t('command.undo')}
      data-testid="undo-banner"
      className="mb-2 flex min-h-9 items-center gap-1.5 rounded-xl border border-border bg-background px-3 py-1 text-xs text-muted-foreground animate-in fade-in slide-in-from-bottom-1 duration-200 ease-smooth"
    >
      <Undo2 aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate font-medium text-foreground">
        {t('undo.banner', { count })}
      </span>
      <Button size="xs" variant="ghost" className="ml-auto" disabled={disabled} onClick={onRedo}>
        {t('command.redo')}
      </Button>
    </section>
  );
}
