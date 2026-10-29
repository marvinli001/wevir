// 点一下就从按钮处展开的菜单，代替屏幕中间或底部的操作表。iOS 是系统的菜单（@expo/ui 的 SwiftUI Menu）：按钮照旧由
// React Native 画，上面铺一块透明的触发区，菜单从按钮所在的位置展开（iOS 26 是贴着按钮的玻璃菜单）。Android 点按钮弹出底部的
// Material 列表（sheets.tsx）。导航栏上的菜单是 header-button.tsx 的 HeaderMenu（Stack.Toolbar.Menu）。

import { Button, Host, Menu, Rectangle, Section, Toggle } from '@expo/ui/swift-ui';
import {
  accessibilityLabel as a11yLabel,
  contentShape,
  disabled as disabledModifier,
  foregroundStyle,
  menuIndicator,
  menuOrder,
  shapes,
} from '@expo/ui/swift-ui/modifiers';
import type { SFSymbol } from 'expo-symbols';
import type { ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { type SheetAction, useActionSheet } from './sheets';

export interface MenuItem {
  label: string;
  /** 名称可能重复时给（例如同名的两台电脑）。 */
  id?: string;
  /** iOS 菜单项前的 SF Symbol；`checked` 的项用勾，不显示它。 */
  icon?: SFSymbol;
  /** 单选列表里选中的一项（打勾）。 */
  checked?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  onPress: () => void;
}

/** 一组菜单项；有标题时 iOS 在组上面写标题，Android 的列表只用第一组的标题。 */
export interface MenuSection {
  title?: string;
  items: readonly MenuItem[];
}

/** 把菜单摊平成 Android 底部列表的一组操作。 */
export function sheetActions(sections: readonly MenuSection[]): SheetAction[] {
  return sections.flatMap((section) =>
    section.items
      .filter((item) => item.disabled !== true)
      .map((item) => ({
        ...(item.id !== undefined && { id: item.id }),
        label: item.label,
        ...(item.destructive === true && { destructive: true }),
        ...(item.checked === true && { checked: true }),
        onPress: item.onPress,
      })),
  );
}

function items(list: readonly MenuItem[]) {
  return list.map((item) => {
    const modifiers = item.disabled === true ? [disabledModifier(true)] : undefined;
    // 单选的项用 Toggle：系统菜单在选中的一项前打勾，没选的留出同样的缩进。
    return item.checked !== undefined ? (
      <Toggle
        key={item.id ?? item.label}
        label={item.label}
        isOn={item.checked}
        onIsOnChange={() => item.onPress()}
        {...(modifiers !== undefined && { modifiers })}
      />
    ) : (
      <Button
        key={item.id ?? item.label}
        label={item.label}
        {...(item.icon !== undefined && { systemImage: item.icon })}
        {...(item.destructive === true && { role: 'destructive' as const })}
        onPress={item.onPress}
        {...(modifiers !== undefined && { modifiers })}
      />
    );
  });
}

function nativeSections(sections: readonly MenuSection[]) {
  return sections.map((section, index) => {
    const key = `${index}:${section.title ?? ''}`;
    return sections.length === 1 && section.title === undefined ? (
      items(section.items)
    ) : (
      <Section key={key} {...(section.title !== undefined && { title: section.title })}>
        {items(section.items)}
      </Section>
    );
  });
}

/**
 * 包住一个按钮，点它弹出菜单。`children` 是按钮的样子（不要再放 Pressable）；`disabled` 时点不开，按钮的灰色由调用方画。
 */
export function MenuTrigger({
  sections,
  title,
  label,
  disabled = false,
  style,
  children,
  testID,
}: {
  sections: readonly MenuSection[];
  /** Android 列表的标题。 */
  title?: string;
  /** 读屏念的名字。 */
  label: string;
  disabled?: boolean;
  style?: ViewStyle;
  children: ReactNode;
  testID?: string;
}) {
  const [sheet, showSheet] = useActionSheet();
  if (Platform.OS === 'ios') {
    return (
      <View style={style} testID={testID}>
        <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          {children}
        </View>
        {!disabled && (
          <Host style={StyleSheet.absoluteFill}>
            <Menu
              label={
                <Rectangle
                  modifiers={[foregroundStyle('transparent'), contentShape(shapes.rectangle())]}
                />
              }
              // 向上展开时系统默认把组倒过来排（离按钮近的在前）；固定成写下的顺序，标题与选项的先后不跟着变。
              modifiers={[menuIndicator('hidden'), menuOrder('fixed'), a11yLabel(label)]}
            >
              {nativeSections(sections)}
            </Menu>
          </Host>
        )}
      </View>
    );
  }
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={() => showSheet(sheetActions(sections), title)}
        style={style}
        testID={testID}
      >
        {children}
      </Pressable>
      {sheet}
    </>
  );
}
