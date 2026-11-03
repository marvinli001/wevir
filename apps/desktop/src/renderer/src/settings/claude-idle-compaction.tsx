import { useState } from 'react';
import { Switch } from '@/components/switch';
import { Select } from '@/components/ui/select';
import { useHostSettings } from '@/data/host-settings';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { NoticeBanner, SettingsRow } from './settings-ui';

export function ClaudeIdleCompactionSetting({ providerId }: { providerId?: string }) {
  const { client } = useHostConnection();
  const { settings, editable, update } = useHostSettings();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  if (!client?.supports('idle_compaction')) return null;
  const label = t('settings.chat.idleCompaction');
  const override =
    providerId === undefined ? undefined : settings.claudeIdleCompactionOverrides?.[providerId];
  const save = async (value: 'default' | 'on' | 'off') => {
    setSaving(true);
    setError(undefined);
    try {
      if (providerId === undefined) {
        await update({ compactIdleClaudeSessions: value === 'on' });
      } else {
        const overrides = { ...settings.claudeIdleCompactionOverrides };
        if (value === 'default') delete overrides[providerId];
        else overrides[providerId] = value === 'on';
        await update({ claudeIdleCompactionOverrides: overrides });
      }
    } catch (reason) {
      setError(describe(reason));
    } finally {
      setSaving(false);
    }
  };
  return (
    <>
      <SettingsRow
        title={label}
        data-setting="claude-idle-compaction"
        control={
          providerId === undefined ? (
            <Switch
              label={label}
              checked={settings.compactIdleClaudeSessions === true}
              disabled={saving || !editable}
              onChange={(enabled) => void save(enabled ? 'on' : 'off')}
            />
          ) : (
            <Select
              aria-label={label}
              value={override === undefined ? 'default' : override ? 'on' : 'off'}
              options={[
                { value: 'default', label: t('source.idleCompaction.default') },
                { value: 'on', label: t('source.idleCompaction.on') },
                { value: 'off', label: t('source.idleCompaction.off') },
              ]}
              disabled={saving || !editable}
              onValueChange={(value) => void save(value)}
            />
          )
        }
      />
      {error && <NoticeBanner notice={{ tone: 'error', text: error }} />}
    </>
  );
}
