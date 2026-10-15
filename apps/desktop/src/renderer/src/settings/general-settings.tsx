import type { PendingDelivery } from '@wevir/protocol';
import { Command, CornerDownLeft, CornerDownRight, ListPlus } from 'lucide-react';
import { useState } from 'react';
import { useHostSettings } from '@/data/host-settings';
import { filePrefs, preferredEditor, useEditors } from '@/files/files-store';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import { composerPrefs, type SendShortcut, sendKeyLabel } from '@/session/composer-prefs';
import { LanguagePicker } from './language-picker';
import {
  LIST_CARD,
  NoticeBanner,
  SELECT,
  Segmented,
  SettingsRow,
  SettingsSection,
} from './settings-ui';

/**
 * 设置 → 常规（U7，原来的“对话”并进来）：界面语言（本机，language-picker.tsx），回合进行中按回车的默认方式（R11：存在 Host，`settings.update`，
 * domain-model §3.7，桌面与 CLI 共用；别的客户端改了，这里经 `settings.updated` 跟上）。U35 起还有发送消息的按键与外部编辑器
 * （文件预览的“打开方式”默认用它），都只存在本机。
 */
export function GeneralSettings() {
  const { supported, settings, update } = useHostSettings();
  const composer = composerPrefs.use();
  const editors = useEditors();
  const preferred = preferredEditor(editors, filePrefs.use().editor);
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
        <SettingsRow
          title={t('settings.composer.send')}
          data-setting="send-shortcut"
          control={
            <Segmented<SendShortcut>
              label={t('settings.composer.send')}
              value={composer.sendShortcut}
              onChange={(sendShortcut) => composerPrefs.set({ sendShortcut })}
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
              <select
                className={SELECT}
                aria-label={t('settings.editor')}
                value={preferred?.id ?? ''}
                onChange={(event) =>
                  filePrefs.set((current) => ({ ...current, editor: event.target.value }))
                }
              >
                {editors.map((editor) => (
                  <option key={editor.id} value={editor.id}>
                    {editor.name}
                  </option>
                ))}
              </select>
            }
          />
        )}
      </div>
    </SettingsSection>
  );
}
