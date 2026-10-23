import { hostSupports } from '@wevir/client-sdk';
import type { NotificationKindSettings } from '@wevir/protocol';
import { Switch } from '@/components/switch';
import { useHostSettings } from '@/data/host-settings';
import { useHostConnection } from '@/host/host-connection';
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
type KindKey = keyof NotificationKindSettings;

/**
 * 设置 → 通知（U31）：方式（系统通知、应用内、提示音、角标）只存在本机；事件（回合完成、审批、提问、出错）0.106.0 起在 Host 有
 * `notification_intents` 时读写 Host 设置 `notifications`，并多“自动化”一行，旧 Host 上只存在本机。
 */
export function NotificationSettingsPage() {
  const settings = useNotificationSettings();
  const host = useHostSettings();
  const { view } = useHostConnection();
  const hostKinds =
    host.supported &&
    view.status === 'connected' &&
    hostSupports(view.hello.features, 'notification_intents');
  const kinds = host.settings.notifications;

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

  const kindRow = (key: KindKey, title: PlainMessageKey) =>
    hostKinds ? (
      <SettingsRow
        key={key}
        title={t(title)}
        data-setting={`notify-${key}`}
        control={
          <Switch
            checked={kinds?.[key] !== false}
            label={t(title)}
            disabled={!host.editable}
            onChange={(checked) =>
              void host
                .update({ notifications: { ...kinds, [key]: checked } })
                .catch(() => undefined)
            }
          />
        }
      />
    ) : key === 'automation' ? null : (
      row(key, title)
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
          {kindRow('completed', 'settings.notify.completed')}
          {kindRow('approval', 'settings.notify.approval')}
          {kindRow('question', 'settings.notify.question')}
          {kindRow('failed', 'settings.notify.failed')}
          {kindRow('automation', 'settings.notify.automation')}
        </div>
      </SettingsSection>
    </>
  );
}
