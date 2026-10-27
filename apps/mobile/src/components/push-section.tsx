// 推送的两处界面：电脑详情里这台电脑的推送状态（没有通知权限时点开系统设置），电脑页底部的“锁屏只显示‘需要处理’”。

import { Linking, StyleSheet, Switch, Text } from 'react-native';
import { t } from '../i18n';
import type { MessageKey } from '../i18n/zh-CN';
import type { PushStatus } from '../lib/push';
import { usePushSettings, usePushStatus } from '../state/push';
import { SPACE, TEXT, useTheme } from '../theme';
import { Group, Row } from './ui';

function statusKey(status: PushStatus): MessageKey {
  return status.kind === 'failed'
    ? `push.status.failed.${status.reason}`
    : `push.status.${status.kind}`;
}

/** 电脑详情：连上过、知道推送状态时才显示。 */
export function PushStatusSection({ name }: { name: string }) {
  const theme = useTheme();
  const status = usePushStatus(name);
  if (status === undefined) return null;
  const tone =
    status.kind === 'failed' || status.kind === 'denied'
      ? theme.destructive
      : theme.mutedForeground;
  return (
    <Group style={styles.section}>
      <Row
        last
        icon={{ ios: 'bell.badge', android: 'notifications_active' }}
        title={t('push.section')}
        trailing={<Text style={[styles.status, { color: tone }]}>{t(statusKey(status))}</Text>}
        {...(status.kind === 'denied' && { onPress: () => void Linking.openSettings() })}
      />
    </Group>
  );
}

/** 电脑页底部：锁屏时只显示“需要处理”（iOS 由通知扩展判断锁屏，Android 用锁屏隐藏内容的渠道）。 */
export function PushSettingsSection() {
  const theme = useTheme();
  const { hideOnLockScreen, setHideOnLockScreen } = usePushSettings();
  return (
    <Group style={styles.settings}>
      <Row
        last
        icon={{ ios: 'lock', android: 'lock' }}
        title={
          <Text style={[styles.title, { color: theme.foreground }]} numberOfLines={2}>
            {t('push.hideOnLockScreen')}
          </Text>
        }
        trailing={
          <Switch
            value={hideOnLockScreen}
            onValueChange={setHideOnLockScreen}
            accessibilityLabel={t('push.hideOnLockScreen')}
          />
        }
      />
    </Group>
  );
}

const styles = StyleSheet.create({
  status: { fontSize: TEXT.small },
  title: { fontSize: TEXT.body },
  section: { marginTop: SPACE.section },
  settings: { marginTop: SPACE.section },
});
