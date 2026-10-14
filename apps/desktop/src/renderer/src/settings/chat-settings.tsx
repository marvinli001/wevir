import type { PendingDelivery } from '@wevir/protocol';
import { cn } from 'cn';
import { CornerDownRight, ListPlus } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useHostSettings } from '@/data/host-settings';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import { NoticeBanner } from './settings-ui';

const OPTIONS: { delivery: PendingDelivery; icon: ReactNode }[] = [
  { delivery: 'steer', icon: <CornerDownRight /> },
  { delivery: 'queue', icon: <ListPlus /> },
];

/**
 * “对话”设置（R11）：回合进行中按回车的默认方式。存在 Host（`settings.update`，domain-model §3.7），桌面与 CLI 共用；
 * 别的客户端改了，这里经 `settings.updated` 跟上。
 */
export function ChatSettings() {
  const { supported, settings, update } = useHostSettings();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const choose = async (delivery: PendingDelivery) => {
    if (delivery === settings.sendWhileBusy || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      await update({ sendWhileBusy: delivery });
    } catch (reason) {
      setError(t('settings.chat.saveFailed', { error: describe(reason) }));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium">{t('settings.chat.sendWhileBusy')}</h2>
      {!supported && (
        <NoticeBanner notice={{ tone: 'warning', text: t('settings.chat.unsupported') }} />
      )}
      {error && <NoticeBanner notice={{ tone: 'error', text: error }} />}
      <fieldset className="grid gap-2">
        <legend className="sr-only">{t('settings.chat.sendWhileBusy')}</legend>
        {OPTIONS.map(({ delivery, icon }) => {
          const checked = settings.sendWhileBusy === delivery;
          return (
            <button
              key={delivery}
              type="button"
              aria-pressed={checked}
              disabled={!supported || saving}
              data-send-while-busy={delivery}
              onClick={() => void choose(delivery)}
              className={cn(
                'flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-60 [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0',
                checked ? 'border-primary/50 bg-primary/5' : 'border-border hover:bg-muted/60',
              )}
            >
              {icon}
              <span className="min-w-0">
                <span className="block text-sm font-medium">
                  {t(`settings.chat.sendWhileBusy.${delivery}`)}
                </span>
                <span className="block text-sm text-muted-foreground">
                  {t(`settings.chat.sendWhileBusy.${delivery}Hint`)}
                </span>
              </span>
            </button>
          );
        })}
      </fieldset>
      <p className="text-sm text-muted-foreground">{t('settings.chat.sendWhileBusyHint')}</p>
    </section>
  );
}
