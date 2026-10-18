import { hostSupports } from '@wevir/client-sdk';
import type { HostSettings, PendingDelivery } from '@wevir/protocol';
import { CornerDownRight, ListPlus } from 'lucide-react';
import { useState } from 'react';
import { Switch } from '@/components/switch';
import { Select } from '@/components/ui/select';
import { useHostSettings } from '@/data/host-settings';
import { filePrefs, preferredEditor, useEditors } from '@/files/files-store';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { composerPrefs, type SendShortcut, sendKeyLabel } from '@/session/composer-prefs';
import { suggestionsEnabled } from '@/session/prompt-suggestion';
import { LanguagePicker } from './language-picker';
import { LIST_CARD, NoticeBanner, Segmented, SettingsRow, SettingsSection } from './settings-ui';

/**
 * 设置 → 常规（U7，原来的“对话”并进来）：界面语言（本机，language-picker.tsx），回合进行中按回车的默认方式（R11：存在 Host，`settings.update`，
 * domain-model §3.7，桌面与 CLI 共用；别的客户端改了，这里经 `settings.updated` 跟上）。U35 起还有发送消息的按键与外部编辑器
 * （文件预览的“打开方式”默认用它），都只存在本机。
 */
export function GeneralSettings() {
  const { supported, settings, update } = useHostSettings();
  const { view } = useHostConnection();
  // 输入建议（0.53.0）：Host 声明了 `prompt_suggestions` 才有这一行。
  const suggestionsSupported =
    view.status === 'connected' && hostSupports(view.hello.features, 'prompt_suggestions');
  const composer = composerPrefs.use();
  const editors = useEditors();
  const preferred = preferredEditor(editors, filePrefs.use().editor);
  // 离开后回顾（0.54.0）：Host 能生成（有 `session_recap`）时才有这一行。
  const recapAvailable =
    supported && view.status === 'connected' && hostSupports(view.hello.features, 'session_recap');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const save = async (patch: Partial<HostSettings>) => {
    setSaving(true);
    setError(undefined);
    try {
      await update(patch);
    } catch (reason) {
      setError(t('settings.chat.saveFailed', { error: describe(reason) }));
    } finally {
      setSaving(false);
    }
  };

  const choose = (delivery: PendingDelivery) => {
    if (delivery === settings.sendWhileBusy || saving) return;
    void save({ sendWhileBusy: delivery });
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
          data-setting="language"
          control={<LanguagePicker />}
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
        {suggestionsSupported && (
          <SettingsRow
            title={t('settings.chat.suggestions')}
            data-setting="prompt-suggestions"
            control={
              <Switch
                label={t('settings.chat.suggestions')}
                checked={suggestionsEnabled(settings)}
                disabled={!supported || saving}
                onChange={(promptSuggestions) => void save({ promptSuggestions })}
              />
            }
          />
        )}
        {recapAvailable && (
          <SettingsRow
            title={t('settings.chat.recap')}
            data-setting="recap"
            control={
              <Switch
                checked={settings.sessionRecap !== false}
                label={t('settings.chat.recap')}
                disabled={saving}
                onChange={(sessionRecap) => void save({ sessionRecap })}
              />
            }
          />
        )}
        <SettingsRow
          title={t('settings.composer.send')}
          data-setting="send-shortcut"
          control={
            <Segmented<SendShortcut>
              label={t('settings.composer.send')}
              value={composer.sendShortcut}
              onChange={(sendShortcut) =>
                composerPrefs.set((current) => ({ ...current, sendShortcut }))
              }
              options={[
                { value: 'enter', label: sendKeyLabel('enter') },
                { value: 'mod-enter', label: sendKeyLabel('mod-enter') },
              ]}
            />
          }
        />
        {editors !== undefined && editors.length > 0 && (
          <SettingsRow
            title={t('settings.editor')}
            data-setting="editor"
            control={
              <Select
                className="w-48"
                aria-label={t('settings.editor')}
                value={preferred?.id ?? ''}
                onValueChange={(editor) => filePrefs.set((current) => ({ ...current, editor }))}
                options={editors.map((editor) => ({ value: editor.id, label: editor.name }))}
              />
            }
          />
        )}
      </div>
    </SettingsSection>
  );
}
