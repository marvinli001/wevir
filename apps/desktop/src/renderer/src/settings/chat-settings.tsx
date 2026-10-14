import type { PendingDelivery } from '@wevir/protocol';
import { cn } from 'cn';
import { CornerDownRight, ListPlus } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useHostSettings } from '@/data/host-settings';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import { LIST_CARD, NoticeBanner, SettingsSection } from './settings-ui';

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
    <SettingsSection
      title={t('settings.chat.sendWhileBusy')}
      description={t('settings.chat.sendWhileBusyHint')}
    >
      <div className="space-y-3">
        {!supported && (
          <NoticeBanner notice={{ tone: 'warning', text: t('settings.chat.unsupported') }} />
        )}
        {error && <NoticeBanner notice={{ tone: 'error', text: error }} />}
        <fieldset className={cn(LIST_CARD, 'overflow-hidden')}>
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
                className="flex w-full items-start gap-3 px-4 py-3 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset disabled:opacity-60 [&_svg]:mt-0.5 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
              >
                {icon}
                <span className="min-w-0 flex-1">
                  <span className="block text-base font-medium">
                    {t(`settings.chat.sendWhileBusy.${delivery}`)}
                  </span>
                  <span className="block text-sm text-muted-foreground">
                    {t(`settings.chat.sendWhileBusy.${delivery}Hint`)}
                  </span>
                </span>
                {/* 单选的圆点：选中是墨色的实心圆环（静器没有彩色的强调色）。 */}
                <span
                  aria-hidden
                  className={cn(
                    'mt-0.5 size-4 shrink-0 rounded-full border',
                    checked ? 'border-[5px] border-primary' : 'border-input',
                  )}
                />
              </button>
            );
          })}
        </fieldset>
      </div>
    </SettingsSection>
  );
}
