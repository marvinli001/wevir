// 几个共用的小控件：按“静器”的方向，表面色卡片、分隔线描边、墨色主按钮，彩色只给状态。

import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import type { StatusLine, StatusTone } from '../lib/status-text';
import { RADIUS, TEXT, type Theme, useTheme } from '../theme';

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

export function StatusText({ line }: { line: StatusLine }) {
  const theme = useTheme();
  return (
    <View style={styles.statusRow}>
      {line.tone === 'pending' ? (
        <ActivityIndicator size="small" color={theme.mutedForeground} style={styles.spinner} />
      ) : (
        <View style={[styles.dot, { backgroundColor: toneColor(theme, line.tone) }]} />
      )}
      <Text style={[styles.statusText, { color: theme.mutedForeground }]} numberOfLines={1}>
        {line.text}
        {line.route !== undefined ? ` · ${line.route}` : ''}
      </Text>
    </View>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const theme = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }, style]}>
      {children}
    </View>
  );
}

export function Button({
  title,
  onPress,
  kind = 'primary',
  disabled = false,
}: {
  title: string;
  onPress: () => void;
  kind?: 'primary' | 'secondary' | 'destructive';
  disabled?: boolean;
}) {
  const theme = useTheme();
  const background =
    kind === 'primary' ? theme.primary : kind === 'secondary' ? theme.muted : theme.card;
  const color =
    kind === 'primary'
      ? theme.primaryForeground
      : kind === 'destructive'
        ? theme.destructive
        : theme.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: background,
          borderColor: kind === 'destructive' ? theme.border : background,
          opacity: disabled ? 0.45 : 1,
          transform: [{ scale: pressed && !disabled ? 0.97 : 1 }],
        },
      ]}
    >
      <Text style={[styles.buttonText, { color }]}>{title}</Text>
    </Pressable>
  );
}

export function SectionTitle({ children }: { children: string }) {
  const theme = useTheme();
  return <Text style={[styles.section, { color: theme.mutedForeground }]}>{children}</Text>;
}

const styles = StyleSheet.create({
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 18 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  spinner: { transform: [{ scale: 0.7 }], width: 8, height: 8 },
  statusText: { fontSize: TEXT.small, flexShrink: 1 },
  card: { borderRadius: RADIUS.card, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  button: {
    height: 46,
    borderRadius: RADIUS.card,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  buttonText: { fontSize: TEXT.body, fontWeight: '600' },
  section: {
    fontSize: TEXT.caption,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginTop: 24,
    marginBottom: 8,
    marginHorizontal: 4,
  },
});
