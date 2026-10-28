// 助理列表的一行，像聊天列表：头像、名字与时间，最后一条消息的摘要，电脑名与状态，尾部未读数。

import { StyleSheet, Text, View } from 'react-native';
import { t, timeAgo } from '../i18n';
import type { AvatarPose } from '../lib/bot-avatar';
import type { Bot, BotState } from '../lib/bots';
import { TEXT, type Theme, useTheme } from '../theme';
import { BotAvatar } from './bot-avatar';
import { Row } from './ui';

export function botPose(state: BotState): AvatarPose {
  return state === 'working' ? 'working' : state === 'paused' ? 'sleeping' : 'default';
}

export function botStateColor(theme: Theme, state: BotState): string {
  switch (state) {
    case 'working':
      return theme.running;
    case 'waiting':
      return theme.warning;
    case 'idle':
    case 'paused':
      return theme.mutedForeground;
  }
}

/** 群的头像（0.132.0）：前两个成员错开叠放，只有一个成员时就是它。 */
export function GroupAvatar({ bot, size }: { bot: Bot; size: number }) {
  const [first, second] = bot.members;
  const pose = botPose(bot.state);
  if (first === undefined || second === undefined) {
    return <BotAvatar avatar={first?.avatar ?? bot.avatar} size={size} pose={pose} />;
  }
  const small = Math.round(size * 0.68);
  return (
    <View style={{ width: size, height: size }}>
      <BotAvatar avatar={first.avatar} size={small} pose={pose} style={styles.topLeft} />
      <BotAvatar avatar={second.avatar} size={small} pose={pose} style={styles.bottomRight} />
    </View>
  );
}

export function BotRow({
  bot,
  now,
  last,
  onPress,
}: {
  bot: Bot;
  now: Date;
  last: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const unread = bot.unreadCount > 0;
  const stateColor = botStateColor(theme, bot.state);
  return (
    <Row
      last={last}
      chevron={false}
      onPress={onPress}
      inset={76}
      leading={
        bot.kind === 'group' ? (
          <GroupAvatar bot={bot} size={46} />
        ) : (
          <BotAvatar avatar={bot.avatar} size={46} pose={botPose(bot.state)} />
        )
      }
      title={
        <View style={styles.titleRow}>
          <Text style={[styles.name, { color: theme.foreground }]} numberOfLines={1}>
            {bot.name}
          </Text>
          {bot.lastPost !== undefined && (
            <Text
              style={[styles.time, { color: unread ? theme.foreground : theme.mutedForeground }]}
              numberOfLines={1}
            >
              {timeAgo(bot.lastPost.at, now)}
            </Text>
          )}
        </View>
      }
      subtitle={
        <View style={styles.body}>
          <View style={styles.lines}>
            <Text
              style={[
                styles.preview,
                { color: unread ? theme.softForeground : theme.mutedForeground },
              ]}
              numberOfLines={1}
            >
              {bot.lastPost?.text ?? bot.description}
            </Text>
            <Text style={[styles.meta, { color: theme.mutedForeground }]} numberOfLines={1}>
              {bot.computerName}
              {bot.state !== 'idle' && (
                <Text style={{ color: stateColor }}>{` · ${t(`bots.state.${bot.state}`)}`}</Text>
              )}
            </Text>
          </View>
          {unread && (
            <View style={[styles.unread, { backgroundColor: theme.primary }]}>
              <Text style={[styles.unreadText, { color: theme.primaryForeground }]}>
                {bot.unreadCount > 99 ? '99+' : bot.unreadCount}
              </Text>
            </View>
          )}
        </View>
      }
    />
  );
}

const styles = StyleSheet.create({
  topLeft: { position: 'absolute', top: 0, left: 0 },
  bottomRight: { position: 'absolute', right: 0, bottom: 0 },
  titleRow: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  name: { flex: 1, fontSize: TEXT.body, fontWeight: '600', letterSpacing: -0.2 },
  time: { fontSize: TEXT.caption, fontVariant: ['tabular-nums'] },
  body: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  lines: { flex: 1, gap: 2 },
  preview: { fontSize: TEXT.small },
  meta: { fontSize: TEXT.caption },
  unread: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unreadText: { fontSize: TEXT.caption, fontWeight: '700', fontVariant: ['tabular-nums'] },
});
