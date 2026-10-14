import { cn } from 'cn';
import { ProviderLogo } from '@/components/provider-logo';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { t } from '@/i18n';
import { CATALOG_GROUPS, type CatalogEntry, PROVIDER_CATALOG } from '@/settings/provider-catalog';

/** “更多”：按国际、国内、本地与自定义列出全部模型服务（U6）；还没接上的标“即将支持”、不能选。 */
export function ProviderCatalogDialog({
  open,
  selected,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  selected?: string;
  onOpenChange: (open: boolean) => void;
  onSelect: (entry: CatalogEntry) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-5 p-5 sm:max-w-140">
        <DialogTitle className="text-lg font-semibold">{t('welcome.catalog.title')}</DialogTitle>
        <div className="flex flex-col gap-5">
          {CATALOG_GROUPS.map((group) => (
            <section key={group.id} aria-label={t(group.label)}>
              <h3 className="mb-2 text-xs font-medium text-muted-foreground">{t(group.label)}</h3>
              <ul className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                {PROVIDER_CATALOG.filter((entry) => entry.group === group.id).map((entry) => {
                  const available = entry.source !== undefined;
                  return (
                    <li key={entry.id}>
                      <button
                        type="button"
                        disabled={!available}
                        aria-pressed={entry.id === selected}
                        data-catalog-entry={entry.id}
                        onClick={() => onSelect(entry)}
                        className={cn(
                          'flex h-11 w-full items-center gap-2.5 rounded-lg border border-transparent px-3 text-left text-sm outline-none transition-[background-color,border-color,transform] duration-150 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50 active:scale-[0.98] disabled:pointer-events-none',
                          entry.id === selected && 'border-border-strong bg-muted',
                        )}
                      >
                        <ProviderLogo
                          logo={entry.logo}
                          fallback={t(entry.name)}
                          className={cn(!available && 'opacity-50')}
                        />
                        <span
                          className={cn(
                            'min-w-0 flex-1 truncate',
                            !available && 'text-muted-foreground',
                          )}
                        >
                          {t(entry.name)}
                        </span>
                        {!available && (
                          <span className="shrink-0 rounded-sm bg-muted px-1.5 text-xs leading-5 text-muted-foreground">
                            {t('welcome.soon')}
                          </span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
