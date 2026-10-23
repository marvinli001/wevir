// 共用的控件。iOS 26 起，浮在内容上的控件（按钮、分段的滑块）用系统的 Liquid Glass（expo-glass-effect）；内容本身（分组卡片、
// 行）保持实底，照苹果“玻璃只给控件层”的口径。Android 与旧 iOS 没有玻璃，同一组件退回实底胶囊，形状与层级不变。
// 颜色照“静器”：表面色卡片、分隔线描边、墨色主按钮，彩色只给状态。

import { GlassView, isGlassEffectAPIAvailable, isLiquidGlassAvailable } from 'expo-glass-effect';
import * as Haptics from 'expo-haptics';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ViewStyle,
} from 'react-native';
import type { StatusLine, StatusTone } from '../lib/status-text';
import { RADIUS, SPACE, TEXT, type Theme, useTheme } from '../theme';

/** 这台设备能用 Liquid Glass（iOS 26 且 API 在，早期测试版没有）。 */
export const GLASS =
  Platform.OS === 'ios' && isLiquidGlassAvailable() && isGlassEffectAPIAvailable();

export type IconName = SymbolViewProps['name'];

export function Icon({
  name,
  size = 20,
  color,
  weight,
  style,
}: {
  name: IconName;
  size?: number;
  color: string;
  weight?: SymbolViewProps['weight'];
  style?: ViewStyle;
}) {
  return (
    <SymbolView
      name={name}
      size={size}
      tintColor={color}
      weight={weight}
      style={[{ width: size, height: size }, style]}
    />
  );
}

/**
 * 行尾与分组标题的箭头。Material Symbols 的字形在字框里留白比 SF Symbols 多（`chevron_right` 只占字框一半高），Android 上放大
 * 到同样的视觉尺寸，再用负边距收回多出的留白，让箭头仍贴着行的右边距。
 */
export function Chevron({ color }: { color: string }) {
  return (
    <Icon
      name={{ ios: 'chevron.right', android: 'chevron_right' }}
      size={Platform.OS === 'android' ? 24 : 13}
      weight="semibold"
      color={color}
      style={Platform.OS === 'android' ? styles.chevronAndroid : undefined}
    />
  );
}

export function toneColor(theme: Theme, tone: StatusTone): string {
  switch (tone) {
    case 'online':
      return theme.success;
    case 'pending':
      return theme.running;
    case 'offline':
      return theme.borderStrong;
    case 'problem':
      return theme.destructive;
  }
}

/** 状态点：在线时外面一圈淡色光晕。 */
export function StatusDot({ tone }: { tone: StatusTone }) {
  const theme = useTheme();
  const color = toneColor(theme, tone);
  return (
    <View
      style={[styles.dotHalo, tone === 'online' && { backgroundColor: `${color}2e` }]}
      accessibilityElementsHidden
    >
      <View style={[styles.dot, { backgroundColor: color }]} />
    </View>
  );
}

export function StatusText({ line, size = TEXT.small }: { line: StatusLine; size?: number }) {
  const theme = useTheme();
  return (
    <View style={styles.statusRow}>
      {line.tone === 'pending' ? (
        <ActivityIndicator size="small" color={theme.mutedForeground} style={styles.spinner} />
      ) : (
        <StatusDot tone={line.tone} />
      )}
      <Text
        style={[styles.statusText, { color: theme.mutedForeground, fontSize: size }]}
        numberOfLines={1}
      >
        {line.text}
        {line.route !== undefined ? ` · ${line.route}` : ''}
      </Text>
    </View>
  );
}

/** 分组：大圆角实底卡片，行之间由 `Row` 自己画缩进的分隔线。 */
export function Group({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.group,
        { backgroundColor: theme.card, borderColor: theme.dark ? theme.border : 'transparent' },
        !theme.dark && styles.groupShadow,
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** 分组里的一行：可选的前置图标块、主次两行文字、尾部内容；有 `onPress` 时按下变色并显示箭头。 */
export function Row({
  icon,
  leading,
  title,
  subtitle,
  trailing,
  onPress,
  last = false,
  chevron = onPress !== undefined,
}: {
  icon?: IconName;
  leading?: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  trailing?: ReactNode;
  onPress?: () => void;
  last?: boolean;
  chevron?: boolean;
}) {
  const theme = useTheme();
  // 分隔线从文字起点开始：图标块 32、状态标记 22，加上左边距与间距。
  const inset = icon !== undefined ? 62 : leading !== undefined ? 52 : SPACE.page;
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      disabled={onPress === undefined}
      onPress={onPress}
      android_ripple={{ color: theme.muted }}
      style={({ pressed }) => [
        styles.row,
        pressed && Platform.OS === 'ios' && { backgroundColor: theme.muted },
      ]}
    >
      {icon !== undefined && (
        <View style={[styles.tile, { backgroundColor: theme.muted }]}>
          <Icon name={icon} size={18} color={theme.foreground} />
        </View>
      )}
      {leading}
      <View style={styles.rowText}>
        {typeof title === 'string' ? (
          <Text style={[styles.rowTitle, { color: theme.foreground }]} numberOfLines={1}>
            {title}
          </Text>
        ) : (
          title
        )}
        {subtitle}
      </View>
      {trailing}
      {chevron && <Chevron color={theme.borderStrong} />}
      {!last && <View style={[styles.separator, { backgroundColor: theme.border, left: inset }]} />}
    </Pressable>
  );
}

export function SectionTitle({
  children,
  trailing,
}: {
  children: ReactNode;
  trailing?: ReactNode;
}) {
  const theme = useTheme();
  return (
    <View style={styles.sectionRow}>
      {typeof children === 'string' ? (
        <Text style={[styles.section, { color: theme.foreground }]} numberOfLines={1}>
          {children}
        </Text>
      ) : (
        children
      )}
      {trailing}
    </View>
  );
}

/** 胶囊按钮：iOS 26 是可交互的玻璃（主按钮用墨色着色），其余平台是同形状的实底。 */
export function Button({
  title,
  icon,
  onPress,
  kind = 'primary',
  disabled = false,
}: {
  title: string;
  icon?: IconName;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'destructive';
  disabled?: boolean;
}) {
  const theme = useTheme();
  const color =
    kind === 'primary'
      ? theme.primaryForeground
      : kind === 'destructive'
        ? theme.destructive
        : theme.foreground;
  const label = (
    <View style={styles.buttonInner}>
      {icon !== undefined && <Icon name={icon} size={17} color={color} weight="semibold" />}
      <Text style={[styles.buttonText, { color }]} numberOfLines={1}>
        {title}
      </Text>
    </View>
  );
  const press = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    onPress();
  };
  if (GLASS) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={press}
        style={{ opacity: disabled ? 0.4 : 1 }}
      >
        <GlassView
          isInteractive={!disabled}
          glassEffectStyle="regular"
          tintColor={kind === 'primary' ? theme.primary : undefined}
          style={styles.button}
        >
          {label}
        </GlassView>
      </Pressable>
    );
  }
  const background = kind === 'primary' ? theme.primary : theme.muted;
  return (
    <View style={[styles.button, styles.buttonClip, { opacity: disabled ? 0.4 : 1 }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled }}
        disabled={disabled}
        onPress={press}
        android_ripple={{ color: kind === 'primary' ? theme.mutedForeground : theme.borderStrong }}
        style={({ pressed }) => [
          styles.buttonFill,
          {
            backgroundColor: background,
            opacity: pressed && Platform.OS === 'ios' ? 0.8 : 1,
          },
        ]}
      >
        {label}
      </Pressable>
    </View>
  );
}

/** 空状态：一枚大图标、一行字、一个按钮。 */
export function EmptyState({
  icon,
  title,
  action,
}: {
  icon: IconName;
  title: string;
  action?: { title: string; icon?: IconName; onPress: () => void };
}) {
  const theme = useTheme();
  return (
    <View style={styles.empty}>
      <View style={[styles.emptyIcon, { backgroundColor: theme.card, borderColor: theme.border }]}>
        <Icon name={icon} size={34} color={theme.softForeground} weight="light" />
      </View>
      <Text style={[styles.emptyText, { color: theme.mutedForeground }]}>{title}</Text>
      {action !== undefined && (
        <View style={styles.emptyAction}>
          <Button title={action.title} icon={action.icon} onPress={action.onPress} />
        </View>
      )}
    </View>
  );
}

/** 分段控件：胶囊底槽里一块滑动的实底滑块，切换时轻触反馈。iOS 26 的底槽是玻璃。 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  disabled = false,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const offset = useRef(new Animated.Value(index)).current;
  useEffect(() => {
    Animated.spring(offset, {
      toValue: index,
      useNativeDriver: true,
      damping: 22,
      stiffness: 260,
      mass: 0.8,
    }).start();
  }, [index, offset]);
  const segment = width > 0 ? (width - 8) / options.length : 0;
  const content = (
    <>
      {segment > 0 && (
        <Animated.View
          style={[
            styles.thumb,
            {
              width: segment,
              backgroundColor: theme.dark ? theme.borderStrong : theme.card,
              transform: [{ translateX: Animated.multiply(offset, segment) }],
            },
          ]}
        />
      )}
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="tab"
            accessibilityState={{ selected, disabled }}
            disabled={disabled}
            onPress={() => {
              if (selected) return;
              void Haptics.selectionAsync().catch(() => {});
              onChange(option.value);
            }}
            style={styles.segment}
          >
            <Text
              style={[
                styles.segmentText,
                { color: selected ? theme.foreground : theme.mutedForeground },
              ]}
              numberOfLines={1}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </>
  );
  const layout = (e: { nativeEvent: { layout: { width: number } } }) =>
    setWidth(e.nativeEvent.layout.width);
  if (GLASS) {
    return (
      <GlassView glassEffectStyle="regular" style={styles.segments} onLayout={layout}>
        {content}
      </GlassView>
    );
  }
  return (
    <View style={[styles.segments, { backgroundColor: theme.muted }]} onLayout={layout}>
      {content}
    </View>
  );
}

/** 胶囊标签：待处理数之类。 */
export function Badge({ text, color }: { text: string; color: string }) {
  return (
    <View style={[styles.badge, { backgroundColor: `${color}1f` }]}>
      <Text style={[styles.badgeText, { color }]} numberOfLines={1}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 18 },
  dotHalo: {
    width: 14,
    height: 14,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  spinner: { transform: [{ scale: 0.7 }], width: 14, height: 14 },
  statusText: { flexShrink: 1 },
  group: {
    borderRadius: RADIUS.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderCurve: 'continuous',
    overflow: 'hidden',
  },
  groupShadow: {
    boxShadow: '0 1px 2px rgba(26, 26, 23, 0.04), 0 4px 16px rgba(26, 26, 23, 0.04)',
    overflow: 'visible',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 60,
    paddingHorizontal: SPACE.page,
    paddingVertical: 12,
    gap: 14,
  },
  tile: {
    width: 32,
    height: 32,
    borderRadius: RADIUS.tile,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowText: { flex: 1, gap: 3 },
  chevronAndroid: { marginHorizontal: -7 },
  rowTitle: { fontSize: TEXT.body, fontWeight: '600', letterSpacing: -0.2 },
  separator: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
  },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    marginTop: SPACE.section,
    marginBottom: 10,
    marginHorizontal: 6,
  },
  section: { fontSize: TEXT.title, fontWeight: '700', letterSpacing: -0.3, flexShrink: 1 },
  button: {
    height: 50,
    borderRadius: RADIUS.capsule,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 22,
  },
  buttonClip: { overflow: 'hidden', paddingHorizontal: 0 },
  buttonFill: {
    flex: 1,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 22,
  },
  buttonInner: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  buttonText: { fontSize: TEXT.body, fontWeight: '600', letterSpacing: -0.2 },
  empty: { alignItems: 'center', paddingTop: 120, paddingHorizontal: 32 },
  emptyIcon: {
    width: 84,
    height: 84,
    borderRadius: 28,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  emptyText: { fontSize: TEXT.body, textAlign: 'center' },
  emptyAction: { marginTop: 24, minWidth: 180 },
  segments: {
    flexDirection: 'row',
    height: 44,
    borderRadius: RADIUS.capsule,
    padding: 4,
    overflow: 'hidden',
  },
  thumb: {
    position: 'absolute',
    top: 4,
    bottom: 4,
    left: 4,
    borderRadius: RADIUS.capsule,
    boxShadow: '0 1px 3px rgba(26, 26, 23, 0.12)',
  },
  segment: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  segmentText: { fontSize: TEXT.small, fontWeight: '600' },
  badge: { borderRadius: RADIUS.capsule, paddingHorizontal: 9, paddingVertical: 3 },
  badgeText: { fontSize: TEXT.caption, fontWeight: '600' },
});
