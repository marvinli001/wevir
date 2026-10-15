import type { PendingDelivery } from '@wevir/protocol';
import { CornerDownRight, ListPlus } from 'lucide-react';
import { useState } from 'react';
import { useHostSettings } from '@/data/host-settings';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import { LIST_CARD, NoticeBanner, Segmented, SettingsRow, SettingsSection } from './settings-ui';

/**
 * 设置 → 常规（U7，原来的“对话”并进来）：语言，回合进行中按回车的默认方式（R11：存在 Host，`settings.update`，
 * domain-model §3.7，桌面与 CLI 共用；别的客户端改了，这里经 `settings.updated` 跟上）。
 */
export function GeneralSettings() {
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
    <SettingsSection>
      {error && (
        <div className="mb-3">
          <NoticeBanner notice={{ tone: 'error', text: error }} />
        </div>
      )}
      <div className={LIST_CARD}>
        <SettingsRow
          title={t('settings.appearance.language')}
          control={
            <span className="text-sm text-muted-foreground">
              {t('settings.appearance.languageValue')}
            </span>
          }
        />
        <SettingsRow
          title={t('settings.chat.sendWhileBusy')}
          description={supported ? undefined : t('settings.chat.unsupported')}
          data-setting="send-while-busy"
          control={
            <Segmented
              label={t('settings.chat.sendWhileBusy')}
              value={settings.sendWhileBusy}
              disabled={!supported || saving}
              onChange={(delivery) => void choose(delivery)}
              options={[
                {
                  value: 'steer',
                  label: t('settings.chat.sendWhileBusy.steer'),
                  icon: <CornerDownRight />,
                },
                {
                  value: 'queue',
                  label: t('settings.chat.sendWhileBusy.queue'),
                  icon: <ListPlus />,
                },
              ]}
            />
          }
        />
      </div>
    </SettingsSection>
  );
}
