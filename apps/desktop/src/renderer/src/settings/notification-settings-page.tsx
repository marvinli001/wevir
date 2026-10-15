import { Switch } from '@/components/switch';
import { type PlainMessageKey, t } from '@/i18n';
import { IS_MAC } from '@/lib/shortcuts';
import {
  type NotificationSettings,
  updateNotificationSettings,
  useNotificationSettings,
} from '@/notifications/notification-settings';
import { LIST_CARD, SettingsRow, SettingsSection } from './settings-ui';

/** 应用图标的角标只有 macOS 的程序坞与 Linux（Unity）有（Electron `app.setBadgeCount`）。 */
const IS_LINUX = typeof navigator !== 'undefined' && /Linux/.test(navigator.userAgent);
const BADGE_LABEL: PlainMessageKey | undefined = IS_MAC
  ? 'settings.notify.badgeDock'
  : IS_LINUX
    ? 'settings.notify.badge'
    : undefined;

type Key = keyof NotificationSettings;

/** 设置 → 通知（U31）：方式（系统通知、应用内、提示音、角标）与事件（回合完成、审批、提问、出错），只存在本机。 */
export function NotificationSettingsPage() {
  const settings = useNotificationSettings();

  const row = (key: Key, title: PlainMessageKey, disabled = false) => (
    <SettingsRow
      key={key}
      title={t(title)}
      data-setting={`notify-${key}`}
      control={
        <Switch
          checked={settings[key]}
          label={t(title)}
          disabled={disabled}
          onChange={(checked) => updateNotificationSettings({ [key]: checked })}
        />
      }
    />
  );

  return (
    <>
      <SettingsSection title={t('settings.section.notifyChannels')}>
        <div className={LIST_CARD}>
          {row('system', 'settings.notify.system')}
          {row('sound', 'settings.notify.sound', !settings.system)}
          {BADGE_LABEL && row('badge', BADGE_LABEL, !settings.system)}
          {row('inApp', 'settings.notify.inApp')}
        </div>
      </SettingsSection>
      <SettingsSection title={t('settings.section.notifyEvents')}>
        <div className={LIST_CARD}>
          {row('completed', 'settings.notify.completed')}
          {row('approval', 'settings.notify.approval')}
          {row('question', 'settings.notify.question')}
          {row('failed', 'settings.notify.failed')}
        </div>
      </SettingsSection>
    </>
  );
}
