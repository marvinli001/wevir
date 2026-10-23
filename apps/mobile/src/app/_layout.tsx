// 根布局：选语言、跑一次 Noise 自检（开发构建）、提供电脑列表，用系统的导航栈。

import { getLocales } from 'expo-localization';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect } from 'react';
import { pickLocale, setLocale, t } from '../i18n';
import { runNoiseSelfTest } from '../lib/selftest';
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
      <StatusBar style={theme.dark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.background },
          headerTintColor: theme.foreground,
          headerTitleStyle: { color: theme.foreground },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: theme.background },
        }}
      >
        <Stack.Screen name="index" options={{ title: t('computers.title') }} />
        <Stack.Screen name="add" options={{ title: t('add.title'), presentation: 'modal' }} />
        <Stack.Screen name="computer/[name]" options={{ title: '' }} />
      </Stack>
    </RegistryProvider>
  );
}
