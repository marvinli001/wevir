// 设置 → 个性化 → 写作（0.95.0，Host 功能 `writing_style`，domain-model §3.43）：“参考我的写作风格”的开关（Host 设置的
// `writingStyle`），照 Codex 只有一个开关。档案由 Agent 在用户要它按自己的风格写、并同意建档时建好与更新，用户要看或改时找 Agent，
// 设置里不列。改动从下一次建会话、恢复或接力起生效。

import { Switch } from '@/components/switch';
import { t } from '@/i18n';
import { LIST_CARD, SettingsRow, SettingsSection } from './settings-ui';

export function WritingStyleSettings({
  enabled,
  onToggle,
}: {
  enabled: boolean;
  onToggle: (writingStyle: boolean) => void;
}) {
  return (
    <SettingsSection title={t('settings.personalization.writing')} data-section="writing">
      <div className={LIST_CARD}>
        <SettingsRow
          title={t('settings.personalization.writingStyle')}
          data-setting="writing-style"
          control={
            <Switch
              label={t('settings.personalization.writingStyle')}
              checked={enabled}
              onChange={onToggle}
            />
          }
        />
      </div>
    </SettingsSection>
  );
}
