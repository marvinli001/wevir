// 底部标签页：助理、收件箱、会话、电脑。用系统原生的标签栏：iOS 26 是浮起的 Liquid Glass 标签栏（向下滚时收起），Android 是 Material 3
// 的底部导航，同一份声明。选中色取墨色，与“静器”一致。收件箱是单独的一个标签，标签上的数字是待处理数：两个平台的习惯都是把
// “等你处理的事”放成一个带角标的顶层去处（邮件、信息、Slack 的“动态”），而不是塞在列表顶上；放在助理之后，首页仍是助理。

import { NativeTabs } from 'expo-router/native-tabs';
import { Platform } from 'react-native';
import { t } from '../../i18n';
import { useInbox } from '../../state/inbox';
import { useTheme } from '../../theme';

export default function TabsLayout() {
  const theme = useTheme();
  const pending = useInbox().entries.length;
  return (
    <NativeTabs
      tintColor={theme.foreground}
      minimizeBehavior="onScrollDown"
      backgroundColor={Platform.OS === 'android' ? theme.background : undefined}
      indicatorColor={theme.muted}
      iconColor={{ default: theme.mutedForeground, selected: theme.foreground }}
      labelStyle={{
        default: { color: theme.mutedForeground },
        selected: { color: theme.foreground },
      }}
    >
      <NativeTabs.Trigger name="(bots)">
        <NativeTabs.Trigger.Icon sf="sparkles" md="auto_awesome" />
        <NativeTabs.Trigger.Label>{t('bots.title')}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="inbox">
        <NativeTabs.Trigger.Icon sf={{ default: 'tray', selected: 'tray.fill' }} md="inbox" />
        <NativeTabs.Trigger.Label>{t('inbox.title')}</NativeTabs.Trigger.Label>
        {/* 没有待处理时不放角标（`hidden` 在 iOS 上显示 0，空文字显示成红点）。 */}
        {pending > 0 && <NativeTabs.Trigger.Badge>{String(pending)}</NativeTabs.Trigger.Badge>}
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="sessions">
        <NativeTabs.Trigger.Icon
          sf={{
            default: 'bubble.left.and.text.bubble.right',
            selected: 'bubble.left.and.text.bubble.right.fill',
          }}
          md="forum"
        />
        <NativeTabs.Trigger.Label>{t('computer.sessions')}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="computers">
        <NativeTabs.Trigger.Icon sf="laptopcomputer" md="computer" />
        <NativeTabs.Trigger.Label>{t('computers.title')}</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
