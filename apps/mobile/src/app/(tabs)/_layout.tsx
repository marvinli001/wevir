// 底部标签页：会话、电脑。用系统原生的标签栏：iOS 26 是浮起的 Liquid Glass 标签栏（向下滚时收起），Android 是 Material 3 的
// 底部导航，同一份声明。选中色取墨色，与“静器”一致。

import { NativeTabs } from 'expo-router/native-tabs';
import { Platform } from 'react-native';
import { t } from '../../i18n';
import { useTheme } from '../../theme';

export default function TabsLayout() {
  const theme = useTheme();
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
      <NativeTabs.Trigger name="(home)">
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
