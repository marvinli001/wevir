import { Construction } from 'lucide-react';
import { t } from '@/i18n';

/** 以后的种类在开发模式下的占位（desktop-layout.md §2.1），用来检查排布。 */
export function PlaceholderPane({ name }: { name: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 overflow-hidden px-6 text-center">
      <Construction className="size-6 stroke-[1.5] text-muted-foreground" aria-hidden />
      <p className="text-sm font-medium">{t('pane.placeholder.title', { kind: name })}</p>
      <p className="max-w-64 text-sm text-muted-foreground">{t('pane.placeholder.body')}</p>
    </div>
  );
}
