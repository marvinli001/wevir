// 输入框上方的“回顾”卡片（0.54.0，desktop-tokens §61）：离开一阵回到会话时，一到三句话说这件事在做什么、下一步是什么。
// 安静的一块：细边框、小图标、正文色的摘要，右上角关闭；不带动作按钮。

import { History, X } from 'lucide-react';
import { IconButton } from '@/components/icon-button';
import { t } from '@/i18n';

export function RecapCard({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <section
      aria-label={t('recap.title')}
      data-testid="session-recap"
      className="mb-2 flex items-start gap-2 rounded-xl border border-border bg-background py-2 pr-1.5 pl-3 text-sm animate-in fade-in slide-in-from-bottom-1 duration-200 ease-smooth"
    >
      <History aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-muted-foreground text-xs">{t('recap.title')}</p>
        <p className="mt-0.5 break-words text-foreground">{text}</p>
      </div>
      <IconButton label={t('common.close')} size="icon-xs" onClick={onDismiss}>
        <X />
      </IconButton>
    </section>
  );
}
