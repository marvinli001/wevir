// 导航栏的统一样式。iOS 26 起系统导航栏本身就是 Liquid Glass，只要不给它设背景色（设了就变成不透明的旧样式）；内容从栏下面滚过，
// 顶部由系统的柔边滚动效果淡出。Android 用与页面同色的不透明栏、不画阴影。

import type { NativeStackNavigationOptions } from 'expo-router';
import { Platform } from 'react-native';
import type { Theme } from '../theme';

export function stackOptions(theme: Theme): NativeStackNavigationOptions {
  const common: NativeStackNavigationOptions = {
    headerTintColor: theme.foreground,
    headerTitleStyle: { color: theme.foreground },
    headerShadowVisible: false,
    headerBackButtonDisplayMode: 'minimal',
    contentStyle: { backgroundColor: theme.background },
  };
  if (Platform.OS === 'ios') {
    return {
      ...common,
      headerTransparent: true,
      headerLargeTitleShadowVisible: false,
      headerLargeTitleStyle: { color: theme.foreground },
    };
  }
  return { ...common, headerStyle: { backgroundColor: theme.background } };
}
