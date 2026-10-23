// 一台电脑：连接状态、实时的会话列表（`session.list` + `sessions.changed`，只读：标题、状态、待处理数）与“退出这台电脑”。

import type { Session } from '@wevir/protocol';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Alert, FlatList, StyleSheet, Text, View } from 'react-native';
import { Button, Card, SectionTitle, StatusText } from '../../components/ui';
import { type MessageKey, t, timeAgo } from '../../i18n';
import type { LinkSnapshot } from '../../lib/computer-link';
import { displayName } from '../../lib/records';
import { pendingCount } from '../../lib/sessions';
import { statusLine, statusNotice } from '../../lib/status-text';
import { useComputer, useRegistry } from '../../state/registry';
import { RADIUS, TEXT, useTheme } from '../../theme';

export default function ComputerScreen() {
  const { name } = useLocalSearchParams<{ name: string }>();
  const snapshot = useComputer(name);
  const theme = useTheme();
  if (snapshot === undefined)
    return <View style={{ flex: 1, backgroundColor: theme.background }} />;
  return <ComputerDetail snapshot={snapshot} />;
}

function ComputerDetail({ snapshot }: { snapshot: LinkSnapshot }) {
  const theme = useTheme();
  const router = useRouter();
  const registry = useRegistry();
  const { record, status, sessions } = snapshot;
  const now = new Date();
  const notice = statusNotice(status);
  const sessionList = sessions.kind === 'ready' ? sessions.sessions : [];

  const forget = () => {
    Alert.alert(t('computer.forget.title'), t('computer.forget.consequence'), [
      { text: t('add.cancel'), style: 'cancel' },
      {
        text: t('computer.forget.confirm'),
        style: 'destructive',
        onPress: () => {
          router.back();
          void registry.forget(record.name);
        },
      },
    ]);
  };

  const header = (
    <View>
      <Card style={styles.statusCard}>
        <StatusText line={statusLine(snapshot, now)} />
        {notice !== undefined && (
          <Text style={[styles.notice, { color: theme.softForeground }]}>{t(notice)}</Text>
        )}
        {status.kind === 'removed' && (
          <Button title={t('computer.pairAgain')} onPress={() => router.push('/add')} />
        )}
        {status.kind === 'offline' && status.reason !== 'host_mismatch' && (
          <Button
            kind="secondary"
            title={t('computer.retry')}
            onPress={() => registry.link(record.name)?.retryNow()}
          />
        )}
      </Card>
      {status.kind !== 'removed' && <SectionTitle>{t('computer.sessions')}</SectionTitle>}
      {sessionsPlaceholder(sessions.kind, status.kind) !== undefined && (
        <Text style={[styles.placeholder, { color: theme.mutedForeground }]}>
          {t(sessionsPlaceholder(sessions.kind, status.kind) as MessageKey)}
        </Text>
      )}
    </View>
  );

  return (
    <>
      <Stack.Screen options={{ title: displayName(record) }} />
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: theme.background }}
        contentContainerStyle={styles.content}
        data={sessionList}
        keyExtractor={(s) => s.id}
        ListHeaderComponent={header}
        ItemSeparatorComponent={() => (
          <View
            style={[
              styles.separatorRow,
              { backgroundColor: theme.card, borderColor: theme.border },
            ]}
          >
            <View style={[styles.separator, { backgroundColor: theme.border }]} />
          </View>
        )}
        renderItem={({ item, index }) => (
          <SessionRow
            session={item}
            now={now}
            first={index === 0}
            last={index === sessionList.length - 1}
          />
        )}
        ListFooterComponent={
          <View style={styles.footer}>
            <Button kind="destructive" title={t('computer.forget')} onPress={forget} />
          </View>
        }
      />
    </>
  );
}

function sessionsPlaceholder(
  sessions: LinkSnapshot['sessions']['kind'],
  status: LinkSnapshot['status']['kind'],
): MessageKey | undefined {
  if (status === 'removed') return undefined;
  switch (sessions) {
    case 'loading':
      return 'computer.loading';
    case 'forbidden':
      return 'computer.forbidden';
    case 'failed':
      return 'computer.sessionsFailed';
    case 'ready':
      return undefined;
    case 'none':
      return status === 'online' ? 'computer.loading' : undefined;
  }
}

function SessionRow({
  session,
  now,
  first,
  last,
}: {
  session: Session;
  now: Date;
  first: boolean;
  last: boolean;
}) {
  const theme = useTheme();
  const pending = pendingCount(session);
  const state = session.awaitingInput
    ? t('session.awaitingInput')
    : t(`session.state.${session.state}`);
  const stateColor =
    pending > 0 || session.state === 'awaiting_approval' || session.awaitingInput
      ? theme.warning
      : session.state === 'running'
        ? theme.running
        : session.state === 'error'
          ? theme.destructive
          : theme.mutedForeground;
  return (
    <View
      style={[
        styles.session,
        { backgroundColor: theme.card, borderColor: theme.border },
        first && styles.sessionFirst,
        last && styles.sessionLast,
      ]}
    >
      <View style={styles.sessionText}>
        <Text style={[styles.sessionTitle, { color: theme.foreground }]} numberOfLines={1}>
          {session.title.trim() || t('session.untitled')}
        </Text>
        <Text style={[styles.sessionMeta, { color: theme.mutedForeground }]} numberOfLines={1}>
          <Text style={{ color: stateColor }}>{state}</Text>
          {` · ${timeAgo(session.updatedAt, now)}`}
        </Text>
      </View>
      {pending > 0 && (
        <View style={[styles.badge, { backgroundColor: theme.muted }]}>
          <Text style={[styles.badgeText, { color: theme.warning }]}>
            {t('computer.pending', { count: pending })}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
  statusCard: { padding: 16, gap: 12 },
  notice: { fontSize: TEXT.small, lineHeight: 19 },
  placeholder: { fontSize: TEXT.small, marginHorizontal: 4, marginBottom: 8 },
  separatorRow: {
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  separator: { height: StyleSheet.hairlineWidth, marginLeft: 16 },
  session: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 10,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  sessionFirst: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: RADIUS.card,
    borderTopRightRadius: RADIUS.card,
  },
  sessionLast: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomLeftRadius: RADIUS.card,
    borderBottomRightRadius: RADIUS.card,
  },
  sessionText: { flex: 1, gap: 3 },
  sessionTitle: { fontSize: TEXT.body, fontWeight: '500' },
  sessionMeta: { fontSize: TEXT.caption },
  badge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  badgeText: { fontSize: TEXT.caption, fontWeight: '600' },
  footer: { marginTop: 32 },
});
