import { cn } from 'cn';
import { Plus } from 'lucide-react';
import { ProviderLogo } from '@/components/provider-logo';
import { buttonVariants } from '@/components/ui/button';
import { t } from '@/i18n';
import { SETTINGS_CARD } from './settings-ui';
import styles from './zuv-strip.module.css';

export function ZuvStrip({ disabled, onAdd }: { disabled: boolean; onAdd: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-label={`${t('provider.add')} ${t('provider.catalog.zuv')}`}
      data-zuv-strip
      className={cn(
        SETTINGS_CARD,
        styles.strip,
        'relative mb-3 flex w-full items-center gap-3.5 overflow-hidden px-4 py-3 text-left outline-none focus-visible:focus-field',
        disabled ? 'opacity-50' : 'cursor-pointer',
      )}
      onClick={onAdd}
    >
      <span className="flex size-9 shrink-0 items-center justify-center">
        <ProviderLogo logo="zuv" className="size-8" />
      </span>
      <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="text-sm font-medium">{t('provider.catalog.zuv')}</span>
        <span className="text-xs text-muted-foreground">
          {t('provider.zuv.billing')} · {t('provider.zuv.models')}
        </span>
      </span>
      <span className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
        <Plus data-icon="inline-start" />
        {t('provider.add')}
      </span>
      <span className={styles.ruler} aria-hidden />
    </button>
  );
}
