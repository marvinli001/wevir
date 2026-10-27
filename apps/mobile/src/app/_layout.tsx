// 根布局：选语言、跑一次 Noise 自检（开发构建）、提供电脑列表与助理、推送（登记与点通知跳转）、App 开着时的提醒条。底下是三个标签页（助理、会话、电脑），
// 助理对话、会话、电脑详情、添加电脑、新建与编辑助理压在标签页之上。

import { getLocales } from 'expo-localization';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect } from 'react';
import { stackOptions } from '../components/stack';
import { pickLocale, setLocale, t } from '../i18n';
import { runNoiseSelfTest } from '../lib/selftest';
import { BotsProvider } from '../state/bots';
import { NotificationBanners } from '../state/notifications';
import { PushProvider } from '../state/push';
import { RegistryProvider } from '../state/registry';
import { useTheme } from '../theme';

setLocale(pickLocale(getLocales().map((l) => l.languageTag)));

if (__DEV__) {
  try {
    const result = runNoiseSelfTest();
    console.log(
      `[wevir] noise self-test on ${typeof HermesInternal === 'object' ? 'Hermes' : 'JS'}: XXpsk2 ${result.pairMs} ms, IK ${result.reconnectMs} ms, X25519 keygen ${result.keygenMs} ms`,
    );
  } catch (error) {
    console.error('[wevir] noise self-test failed', error);
  }
}

declare const HermesInternal: unknown;

export default function RootLayout() {
  const theme = useTheme();
  useEffect(() => {
    SystemUI.setBackgroundColorAsync(theme.background).catch(() => {});
  }, [theme.background]);
  return (
    <RegistryProvider>
      <BotsProvider>
        <StatusBar style={theme.dark ? 'light' : 'dark'} />
        <PushProvider>
          <NotificationBanners>
            <Stack screenOptions={stackOptions(theme)}>
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen name="add" options={{ title: t('add.title'), presentation: 'modal' }} />
              <Stack.Screen
                name="computer/[name]"
                options={{ title: '', headerLargeTitleEnabled: true }}
              />
              <Stack.Screen
                name="bot/[key]"
                options={{ title: '', headerLargeTitleEnabled: true }}
              />
              <Stack.Screen
                name="session/[key]"
                options={{ title: '', headerLargeTitleEnabled: true }}
              />
              <Stack.Screen
                name="new-bot"
                options={{
                  title: t('bots.new'),
                  presentation: 'formSheet',
                  sheetAllowedDetents: [0.62, 1],
                  sheetGrabberVisible: true,
                }}
              />
              <Stack.Screen
                name="edit-bot"
                options={{
                  title: t('editBot.title'),
                  presentation: 'formSheet',
                  sheetAllowedDetents: [0.75, 1],
                  sheetGrabberVisible: true,
                }}
              />
            </Stack>
          </NotificationBanners>
        </PushProvider>
      </BotsProvider>
    </RegistryProvider>
  );
}
