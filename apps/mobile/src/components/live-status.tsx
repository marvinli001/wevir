// 会话页里回合进行中的运行状态与思考一行（同桌面端的“正在思考”那一行与工作组里的思考）：
//
// - 运行状态：跳动的状态点、当前动作（换了一句时上浮进入）、已用时间（每秒走一次）；下面最多三行是正在流出的思考或在跑
//   的命令最近的输出（session-items.ts 只留末尾），最新的字总在最后一行。等审批、等回答时状态点停住、文字用警示色。回合结束就消失。
// - 思考：一行“思考了 N 秒”，有文字时点开看全文。

import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { formatDuration, t } from '../i18n';
import type { LiveAction, SessionItem } from '../lib/session-items';
import { useReducedMotion } from '../state/reduced-motion';
import { TEXT, type Theme } from '../theme';
import { Icon } from './ui';

const DETAIL_LINES = 3;
const DETAIL_LINE_HEIGHT = 18;

function actionText(action: LiveAction): string {
  switch (action.kind) {
    case 'thinking':
      return t('live.thinking');
    case 'awaiting':
      return t('live.awaiting');
    case 'input':
      return t('live.input');
    case 'stopping':
      return t('session.state.cancelling');
    case 'tool':
      return action.label;
  }
}

export function LiveStatus({
  item,
  theme,
}: {
  item: Extract<SessionItem, { kind: 'live' }>;
  theme: Theme;
}) {
  const waiting = item.action.kind === 'awaiting' || item.action.kind === 'input';
  const text = actionText(item.action);
  return (
    <View style={styles.live} testID="session-live" accessibilityLiveRegion="polite">
      <View style={styles.head}>
        <PulseDot color={waiting ? theme.warning : theme.running} paused={waiting} />
        <RiseIn key={text} style={styles.action}>
          <Text
            style={[styles.actionText, { color: waiting ? theme.warning : theme.softForeground }]}
            numberOfLines={1}
            ellipsizeMode="middle"
          >
            {text}
          </Text>
        </RiseIn>
        {item.startedAt !== undefined && (
          <Elapsed since={item.startedAt} color={theme.mutedForeground} />
        )}
      </View>
      {item.detail !== undefined && (
        <View
          style={[styles.detail, { borderLeftColor: theme.border }]}
          testID="session-live-detail"
        >
          <Text
            style={[styles.detailText, { color: theme.mutedForeground }]}
            numberOfLines={DETAIL_LINES}
          >
            {item.detail}
          </Text>
        </View>
      )}
    </View>
  );
}

/** 一段思考：图标、“思考了 N 秒”，有文字时可展开。 */
export function ThoughtRow({
  item,
  theme,
}: {
  item: Extract<SessionItem, { kind: 'thought' }>;
  theme: Theme;
}) {
  const [open, setOpen] = useState(false);
  const hasText = item.text.trim() !== '';
  const label =
    item.durationMs !== undefined && item.durationMs >= 1_000
      ? t('live.thought', { duration: formatDuration(item.durationMs) })
      : t('live.thoughtPlain');
  return (
    <View testID="session-thought">
      <Pressable
        accessibilityRole="button"
        accessibilityState={hasText ? { expanded: open } : undefined}
        disabled={!hasText}
        onPress={() => setOpen(!open)}
        hitSlop={6}
        style={styles.thought}
      >
        <Icon
          name={{ ios: 'lightbulb', android: 'lightbulb' }}
          size={14}
          color={theme.mutedForeground}
        />
        <Text style={[styles.thoughtText, { color: theme.mutedForeground }]} numberOfLines={1}>
          {label}
        </Text>
        {hasText && (
          <Icon
            name={
              open
                ? { ios: 'chevron.down', android: 'expand_more' }
                : { ios: 'chevron.right', android: 'chevron_right' }
            }
            size={11}
            color={theme.mutedForeground}
          />
        )}
      </Pressable>
      {open && (
        <Text
          style={[
            styles.thoughtBody,
            { color: theme.mutedForeground, borderLeftColor: theme.border },
          ]}
          selectable
        >
          {item.text.trim()}
        </Text>
      )}
    </View>
  );
}

/** 跳动的状态点；停住时（等用户处理）不动。 */
function PulseDot({ color, paused }: { color: string; paused: boolean }) {
  const reduced = useReducedMotion();
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (paused || reduced) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.35,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: 700,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [paused, reduced, pulse]);
  return (
    <View style={styles.dotBox}>
      <Animated.View
        style={[
          styles.dot,
          { backgroundColor: color, opacity: pulse, transform: [{ scale: pulse }] },
        ]}
      />
    </View>
  );
}

/** 挂上时从下方上浮进入（按文字作 key 重新挂上，换了一句才动）。 */
function RiseIn({ children, style }: { children: React.ReactNode; style: object }) {
  const reduced = useReducedMotion();
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(progress, {
      toValue: 1,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [progress]);
  const translateY = progress.interpolate({ inputRange: [0, 1], outputRange: [6, 0] });
  return (
    <Animated.View style={[style, !reduced && { opacity: progress, transform: [{ translateY }] }]}>
      {children}
    </Animated.View>
  );
}

/** 回合已用的时间，每秒走一次，只重画这一小段。 */
function Elapsed({ since, color }: { since: string; color: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const ms = now - Date.parse(since);
  if (!Number.isFinite(ms)) return null;
  return (
    <Text style={[styles.elapsed, { color }]} testID="session-live-elapsed">
      {formatDuration(ms, true)}
    </Text>
  );
}

const styles = StyleSheet.create({
  live: { gap: 6, paddingHorizontal: 4 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 22 },
  dotBox: { width: 14, height: 14, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 8, height: 8, borderRadius: 4 },
  action: { flexShrink: 1 },
  actionText: { fontSize: TEXT.small },
  elapsed: { fontSize: TEXT.small, fontVariant: ['tabular-nums'] },
  detail: {
    marginLeft: 6,
    paddingLeft: 14,
    borderLeftWidth: 2,
  },
  detailText: { fontSize: TEXT.caption, lineHeight: DETAIL_LINE_HEIGHT },
  thought: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  thoughtText: { flexShrink: 1, fontSize: TEXT.small },
  thoughtBody: {
    marginTop: 6,
    marginLeft: 10,
    paddingLeft: 12,
    borderLeftWidth: 2,
    fontSize: TEXT.caption,
    lineHeight: 18,
  },
});
