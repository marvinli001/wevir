// 导航栏右边的图标按钮与菜单。iOS 用 Stack.Toolbar（系统的玻璃栏按钮，与返回按钮同一块玻璃；菜单从按钮处展开）；Android 的工具栏
// 只收图片资源，改用 headerRight 放一枚 Material Symbols 图标，带水波纹，菜单是底部的列表。

import { Stack } from 'expo-router';
import type { AndroidSymbol, SFSymbol } from 'expo-symbols';
import { Platform, Pressable, StyleSheet } from 'react-native';
import { useTheme } from '../theme';
import { type MenuSection, sheetActions } from './menu';
import { useActionSheet } from './sheets';
import { Icon } from './ui';

export function HeaderButton({
  sf,
  md,
  label,
  onPress,
  disabled = false,
}: {
  sf: SFSymbol;
  md: AndroidSymbol;
  label: string;
  onPress: () => void;
  /** 灰掉、按不下去（原因由页面另行说明）。 */
  disabled?: boolean;
}) {
  if (Platform.OS === 'ios') {
    return (
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          icon={sf}
          accessibilityLabel={label}
          onPress={onPress}
          disabled={disabled}
        />
      </Stack.Toolbar>
    );
  }
  return <AndroidHeaderButton md={md} label={label} onPress={onPress} disabled={disabled} />;
}

/** 导航栏右边点开菜单的按钮。没有菜单项时灰掉。 */
export function HeaderMenu({
  sf,
  md,
  label,
  sections,
  disabled = false,
}: {
  sf: SFSymbol;
  md: AndroidSymbol;
  label: string;
  sections: readonly MenuSection[];
  disabled?: boolean;
}) {
  const [sheet, showSheet] = useActionSheet();
  const all = sections.flatMap((section) => section.items);
  if (Platform.OS === 'ios') {
    return (
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu
          icon={sf}
          accessibilityLabel={label}
          disabled={disabled || all.length === 0}
        >
          {sections.map((section, index) => {
            const actions = section.items.map((item) => (
              <Stack.Toolbar.MenuAction
                key={item.label}
                {...(item.icon !== undefined && { icon: item.icon })}
                {...(item.checked !== undefined && { isOn: item.checked })}
                {...(item.destructive === true && { destructive: true })}
                {...(item.disabled === true && { disabled: true })}
                onPress={item.onPress}
              >
                {item.label}
              </Stack.Toolbar.MenuAction>
            ));
            return sections.length === 1 && section.title === undefined ? (
              actions
            ) : (
              <Stack.Toolbar.Menu
                // biome-ignore lint/suspicious/noArrayIndexKey: 组的顺序固定
                key={index}
                inline
                {...(section.title !== undefined && { title: section.title })}
              >
                {actions}
              </Stack.Toolbar.Menu>
            );
          })}
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
    );
  }
  return (
    <>
      <AndroidHeaderButton
        md={md}
        label={label}
        onPress={() => showSheet(sheetActions(sections))}
        disabled={disabled || all.length === 0}
      />
      {sheet}
    </>
  );
}

function AndroidHeaderButton({
  md,
  label,
  onPress,
  disabled,
}: {
  md: AndroidSymbol;
  label: string;
  onPress: () => void;
  disabled: boolean;
}) {
  const theme = useTheme();
  return (
    <Stack.Screen
      options={{
        headerRight: () => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={label}
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={onPress}
            hitSlop={8}
            android_ripple={{ color: theme.muted, borderless: true, radius: 22 }}
            style={styles.button}
          >
            <Icon
              name={{ android: md }}
              size={24}
              color={disabled ? theme.mutedForeground : theme.foreground}
            />
          </Pressable>
        ),
      }}
    />
  );
}

const styles = StyleSheet.create({
  button: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
});
