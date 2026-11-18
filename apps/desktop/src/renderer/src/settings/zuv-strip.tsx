import { cn } from 'cn';
import { ChevronDown, Plus } from 'lucide-react';
import type { ReactNode } from 'react';
import { Collapse } from '@/components/collapse';
import { ProviderLogo } from '@/components/provider-logo';
import { buttonVariants } from '@/components/ui/button';
import { t } from '@/i18n';
import { SETTINGS_CARD } from './settings-ui';
import styles from './zuv-strip.module.css';

/**
 * 还没有 ZUV API 时列表上方的一条：点了在下面就地展开登录连接（`children`，zuv-api-connection.tsx），再点收起；Host 不支持登录
 * 连接时 `children` 为空，点了由调用方转到填 Key 的表单。
 */
export function ZuvStrip({
  disabled,
  expanded = false,
  onAdd,
  children,
}: {
  disabled: boolean;
  expanded?: boolean;
  onAdd: () => void;
  children?: ReactNode;
}) {
  return (
    <div className={cn(SETTINGS_CARD, 'mb-3 overflow-hidden')} data-zuv-strip-card>
      <button
        type="button"
        disabled={disabled}
        aria-label={`${t('provider.add')} ${t('provider.catalog.zuv')}`}
        aria-expanded={children ? expanded : undefined}
        data-zuv-strip
        className={cn(
          styles.strip,
          'relative flex w-full items-center gap-3.5 overflow-hidden px-4 py-3 text-left outline-none transition-colors duration-150 focus-visible:focus-field',
          disabled ? 'opacity-50' : 'cursor-pointer hover:bg-muted/40',
          expanded && 'bg-muted/40',
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
        {expanded ? (
          <span className={cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }))} aria-hidden>
            <ChevronDown className="rotate-180" />
          </span>
        ) : (
          <span className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}>
            <Plus data-icon="inline-start" />
            {t('provider.add')}
          </span>
        )}
        {!expanded && <span className={styles.ruler} aria-hidden />}
      </button>
      {children && (
        <Collapse open={expanded} motion="height">
          <div className="border-t border-border bg-background/40 px-5 py-4">{children}</div>
        </Collapse>
      )}
    </div>
  );
}
