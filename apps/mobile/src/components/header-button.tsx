// 导航栏右边的图标按钮。iOS 用 Stack.Toolbar（系统的玻璃栏按钮，与返回按钮同一块玻璃）；Android 的工具栏只收图片资源，改用
// headerRight 放一枚 Material Symbols 图标，带水波纹。

import { Stack } from 'expo-router';
import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import { Platform, Pressable, StyleSheet } from 'react-native';
import { useTheme } from '../theme';
import { Icon } from './ui';

export function HeaderButton({
  sf,
  md,
  label,
  onPress,
}: {
  sf: SFSymbol;
  md: AndroidSymbol;
  label: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  if (Platform.OS === 'ios') {
    return (
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button icon={sf} accessibilityLabel={label} onPress={onPress} />
      </Stack.Toolbar>
    );
  }
  return (
    <Stack.Screen
      options={{
        headerRight: () => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={label}
            onPress={onPress}
            hitSlop={8}
            android_ripple={{ color: theme.muted, borderless: true, radius: 22 }}
            style={styles.button}
          >
            <Icon name={{ android: md }} size={24} color={theme.foreground} />
          </Pressable>
        ),
      }}
    />
  );
}

const styles = StyleSheet.create({
  button: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
});
