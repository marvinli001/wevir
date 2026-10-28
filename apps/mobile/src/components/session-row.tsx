// 会话列表的一行：前面一枚状态标记（运行中转圈、待处理琥珀色、出错红色、其余空心点），标题与“项目 · 状态 · 时间”，尾部待处理数。
// 会话页与电脑详情共用。助理开在项目里的线程（0.134.0）标题前带助理的头像。

import type { Session } from '@wevir/protocol';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { t, timeAgo } from '../i18n';
import { botKey } from '../lib/bots';
import { pendingCount } from '../lib/sessions';
import { useBot } from '../state/bots';
import { TEXT, type Theme, useTheme } from '../theme';
import { BotAvatar } from './bot-avatar';
import { Badge, Icon, Row } from './ui';

type Mark = 'running' | 'attention' | 'error' | 'quiet';

function markOf(session: Session, pending: number): Mark {
  if (pending > 0 || session.state === 'awaiting_approval' || session.awaitingInput)
    return 'attention';
  if (session.state === 'running' || session.state === 'cancelling') return 'running';
  if (session.state === 'error') return 'error';
  return 'quiet';
}

function markColor(theme: Theme, mark: Mark): string {
  switch (mark) {
    case 'attention':
      return theme.warning;
    case 'running':
      return theme.running;
    case 'error':
      return theme.destructive;
    case 'quiet':
      return theme.mutedForeground;
  }
}

/** 会话所在目录的最后一段，作项目名。 */
function folderName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter((p) => p !== '');
  return parts[parts.length - 1] ?? cwd;
}

/** 线程所属助理的头像；助理不在了或还没读到时不画。 */
function ThreadBot({ computer, channelId }: { computer: string; channelId: string }) {
  const bot = useBot(botKey(computer, channelId));
  if (bot === undefined) return null;
  return (
    <View
      accessible
      accessibilityLabel={t('session.assistant', { name: bot.name })}
      style={styles.bot}
    >
      <BotAvatar avatar={bot.avatar} size={16} />
    </View>
  );
}

export function SessionRow({
  session,
  computer,
  now,
  last,
  onPress,
}: {
  session: Session;
  /** 所在电脑的配对记录名（找线程所属的助理）。 */
  computer: string;
  now: Date;
  last: boolean;
  onPress?: () => void;
}) {
  const theme = useTheme();
  const pending = pendingCount(session);
  const mark = markOf(session, pending);
  const color = markColor(theme, mark);
  const state = session.awaitingInput
    ? t('session.awaitingInput')
    : t(`session.state.${session.state}`);
  return (
    <Row
      last={last}
      {...(onPress !== undefined && { onPress })}
      leading={
        <View style={styles.mark}>
          {mark === 'running' ? (
            <ActivityIndicator size="small" color={color} />
          ) : mark === 'attention' ? (
            <Icon
              name={{ ios: 'exclamationmark.circle.fill', android: 'error' }}
              size={18}
              color={color}
            />
          ) : mark === 'error' ? (
            <Icon
              name={{ ios: 'exclamationmark.triangle.fill', android: 'warning' }}
              size={17}
              color={color}
            />
          ) : (
            <View style={[styles.ring, { borderColor: theme.borderStrong }]} />
          )}
        </View>
      }
      title={
        <View style={styles.titleRow}>
          {session.channel !== undefined && (
            <ThreadBot computer={computer} channelId={session.channel.channelId} />
          )}
          <Text style={[styles.title, { color: theme.foreground }]} numberOfLines={1}>
            {session.title.trim() || t('session.untitled')}
          </Text>
          <Text style={[styles.time, { color: theme.mutedForeground }]} numberOfLines={1}>
            {timeAgo(session.updatedAt, now)}
          </Text>
        </View>
      }
      subtitle={
        <View style={styles.metaRow}>
          <Text style={[styles.meta, { color: theme.mutedForeground }]} numberOfLines={1}>
            {folderName(session.cwd)}
            {mark !== 'quiet' && <Text style={{ color }}>{` · ${state}`}</Text>}
          </Text>
          {pending > 0 && (
            <Badge text={t('computer.pending', { count: pending })} color={theme.warning} />
          )}
        </View>
      }
    />
  );
}

const styles = StyleSheet.create({
  mark: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
  ring: { width: 10, height: 10, borderRadius: 5, borderWidth: 1.5 },
  titleRow: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  bot: { alignSelf: 'center', marginRight: -4 },
  title: { flex: 1, fontSize: TEXT.body, fontWeight: '600', letterSpacing: -0.2 },
  time: { fontSize: TEXT.caption, fontVariant: ['tabular-nums'] },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  meta: { flex: 1, fontSize: TEXT.small },
});
