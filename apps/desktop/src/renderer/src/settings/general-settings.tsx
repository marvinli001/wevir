import { hostSupports } from '@wevir/client-sdk';
import type { HostSettings, PendingDelivery } from '@wevir/protocol';
import { CornerDownRight, ListPlus } from 'lucide-react';
import { useState } from 'react';
import { Switch } from '@/components/switch';
import { Select } from '@/components/ui/select';
import { useHostSettings } from '@/data/host-settings';
import { preventSleepPref } from '@/data/prevent-sleep';
import { filePrefs, preferredEditor, useEditors } from '@/files/files-store';
import { describe, useHostConnection } from '@/host/host-connection';
import { type PlainMessageKey, t } from '@/i18n';
import { layoutPrefs, OPTIONAL_RAIL_CARDS, setRailCardEnabled } from '@/layout/layout-state';
import { composerPrefs, type SendShortcut, sendKeyLabel } from '@/session/composer-prefs';
import {
  PERMISSION_META,
  PERMISSION_MODES,
  permissionModePrefs,
} from '@/session/permission-picker';
import { suggestionsEnabled } from '@/session/prompt-suggestion';
import { usePermissionModes } from '@/session/start-session';
import { LanguagePicker } from './language-picker';
import { MarketMirrorRow } from './market-mirror';
import { LIST_CARD, NoticeBanner, Segmented, SettingsRow, SettingsSection } from './settings-ui';

/** 会话侧栏的可选卡片：名称与 Host 要声明的功能（没有这项功能的 Host 上那张卡片本来就不出现，不列）。 */
const RAIL_CARD_META: Record<
  (typeof OPTIONAL_RAIL_CARDS)[number],
  { label: PlainMessageKey; feature: Parameters<typeof hostSupports>[1] }
> = {
  readiness: { label: 'rail.readiness', feature: 'workspace_readiness' },
  verification: { label: 'rail.checks', feature: 'verification' },
  lsp: { label: 'rail.lsp', feature: 'lsp_status' },
  retro: { label: 'rail.retro', feature: 'session_retro' },
};

/**
 * 设置 → 常规（U7，原来的“对话”并进来）：界面语言（本机，language-picker.tsx），回合进行中按回车的默认方式（R11：存在 Host，`settings.update`，
 * domain-model §3.7，桌面与 CLI 共用；别的客户端改了，这里经 `settings.updated` 跟上）。U35 起还有发送消息的按键与外部编辑器
 * （文件预览的“打开方式”默认用它），都只存在本机。U36 起照 Codex 桌面端加了“运行时防止系统休眠”与“权限”一组（输入框的权限
 * 菜单里出现哪几种模式，请求批准一直在），也只存在本机。“会话侧栏”一组是不管有没有内容都占一张卡片的那几张，默认不显示，
 * 只存在本机。
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
  // 跨引擎的规则文件（0.68.0）：Host 声明了 `rule_files` 才有这一行。
  const insightsAvailable =
    supported &&
    view.status === 'connected' &&
    hostSupports(view.hello.features, 'session_insights');
  // 官方插件市场（0.91.0）：Host 声明了 `plugin_market` 才有“插件市场”一组。
  const marketSupported =
    supported && view.status === 'connected' && hostSupports(view.hello.features, 'plugin_market');
  const ruleFilesSupported =
    supported && view.status === 'connected' && hostSupports(view.hello.features, 'rule_files');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const preventSleep = preventSleepPref.use();
  const permissionsSupported = usePermissionModes();
  const permissionPrefs = permissionModePrefs.use();
  const { railCards } = layoutPrefs.use();
  const railOptions = OPTIONAL_RAIL_CARDS.filter(
    (id) =>
      view.status === 'connected' && hostSupports(view.hello.features, RAIL_CARD_META[id].feature),
  );

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
    <>
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
          {insightsAvailable && (
            <SettingsRow
              title={t('settings.chat.insights')}
              data-setting="insights"
              control={
                <Switch
                  checked={settings.sessionInsights === true}
                  label={t('settings.chat.insights')}
                  disabled={saving}
                  onChange={(sessionInsights) => void save({ sessionInsights })}
                />
              }
            />
          )}
          {ruleFilesSupported && (
            <SettingsRow
              title={t('settings.chat.ruleFiles')}
              data-setting="rule-files"
              control={
                <Switch
                  checked={settings.ruleFiles !== false}
                  label={t('settings.chat.ruleFiles')}
                  disabled={saving}
                  onChange={(ruleFiles) => void save({ ruleFiles })}
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
          <SettingsRow
            title={t('settings.preventSleep')}
            data-setting="prevent-sleep"
            control={
              <Switch
                label={t('settings.preventSleep')}
                checked={preventSleep}
                onChange={(next) => preventSleepPref.set(next)}
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
      {marketSupported && (
        <SettingsSection title={t('settings.section.market')}>
          <div className={LIST_CARD}>
            <MarketMirrorRow
              settings={settings}
              disabled={saving}
              save={(patch) => void save(patch)}
            />
          </div>
        </SettingsSection>
      )}
      {railOptions.length > 0 && (
        <SettingsSection title={t('rail.label')}>
          <div className={LIST_CARD}>
            {railOptions.map((id) => (
              <SettingsRow
                key={id}
                title={t(RAIL_CARD_META[id].label)}
                data-setting={`rail-${id}`}
                control={
                  <Switch
                    label={t(RAIL_CARD_META[id].label)}
                    checked={railCards.includes(id)}
                    onChange={(enabled) => setRailCardEnabled(id, enabled)}
                  />
                }
              />
            ))}
          </div>
        </SettingsSection>
      )}
      {permissionsSupported && (
        <SettingsSection title={t('settings.section.permissions')}>
          <div className={LIST_CARD}>
            {PERMISSION_MODES.map((mode) => (
              <SettingsRow
                key={mode}
                title={t(PERMISSION_META[mode].label)}
                data-setting={`permission-${mode}`}
                control={
                  <Switch
                    label={t(PERMISSION_META[mode].label)}
                    checked={mode === 'on_request' || permissionPrefs[mode]}
                    disabled={mode === 'on_request'}
                    onChange={(enabled) =>
                      mode !== 'on_request' &&
                      permissionModePrefs.set((current) => ({ ...current, [mode]: enabled }))
                    }
                  />
                }
              />
            ))}
          </div>
        </SettingsSection>
      )}
    </>
  );
}
