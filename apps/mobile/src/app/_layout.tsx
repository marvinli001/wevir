// 根布局：选语言、跑一次 Noise 自检（开发构建）、提供电脑列表、收件箱与助理、推送（登记与点通知跳转）、App 开着时的提醒条与 App 锁。
// 底下是四个标签页（助理、收件箱、会话、电脑），助理对话、会话、改动与文件、电脑详情、添加电脑、新建会话、新建与编辑助理压在标签页之上。

import { getLocales } from 'expo-localization';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect } from 'react';
import { stackOptions } from '../components/stack';
import { pickLocale, setLocale, t } from '../i18n';
import { runNoiseSelfTest } from '../lib/selftest';
import { BotsProvider } from '../state/bots';
import { InboxProvider } from '../state/inbox';
import { LockProvider } from '../state/lock';
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

// 同一台电脑、助理或会话在栈里只留一份：点开提醒时它已经开着，就退回到那一页，不再叠一份。
const byName = (_: string, params: Record<string, unknown>) => String(params.name);
const byKey = (_: string, params: Record<string, unknown>) => String(params.key);

export default function RootLayout() {
  const theme = useTheme();
  useEffect(() => {
    SystemUI.setBackgroundColorAsync(theme.background).catch(() => {});
  }, [theme.background]);
  return (
    <RegistryProvider>
      <InboxProvider>
        <BotsProvider>
          <StatusBar style={theme.dark ? 'light' : 'dark'} />
          <LockProvider>
            <PushProvider>
              <NotificationBanners>
                <Stack screenOptions={stackOptions(theme)}>
                  <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                  <Stack.Screen
                    name="add"
                    options={{ title: t('add.title'), presentation: 'modal' }}
                  />
                  <Stack.Screen
                    name="computer/[name]"
                    options={{ title: '', headerLargeTitleEnabled: true }}
                    dangerouslySingular={byName}
                  />
                  <Stack.Screen
                    name="bot/[key]"
                    options={{ title: '', headerLargeTitleEnabled: true }}
                    dangerouslySingular={byKey}
                  />
                  <Stack.Screen
                    name="session/[key]"
                    options={{ title: '', headerLargeTitleEnabled: true }}
                    dangerouslySingular={byKey}
                  />
                  <Stack.Screen
                    name="new-session"
                    options={{ title: t('newSession.title'), presentation: 'modal' }}
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
                    name="edit-group"
                    options={{
                      title: t('bots.newGroup'),
                      presentation: 'formSheet',
                      sheetAllowedDetents: [0.75, 1],
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
          </LockProvider>
        </BotsProvider>
      </InboxProvider>
    </RegistryProvider>
  );
}
