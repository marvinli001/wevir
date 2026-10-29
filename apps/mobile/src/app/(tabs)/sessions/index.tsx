// 会话页：所有配对电脑的会话按电脑分组，每组标题是电脑名与连接状态，点标题进电脑详情。行里是标题、状态、项目、待处理数；右上角
// 新建会话。下拉重连离线的电脑、重读会话列表；“会话列表读取失败”点一下重读那台。

import { Stack, useRouter } from 'expo-router';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { HeaderButton } from '../../../components/header-button';
import { SessionRow } from '../../../components/session-row';
import { Chevron, EmptyState, Group, Icon, SectionTitle, StatusText } from '../../../components/ui';
import { t } from '../../../i18n';
import type { LinkSnapshot } from '../../../lib/computer-link';
import { displayName } from '../../../lib/records';
import { sessionsPlaceholder, statusLine } from '../../../lib/status-text';
import { useMinuteClock } from '../../../state/clock';
import { usePullToRefresh } from '../../../state/refresh';
import { useComputers, useRegistry } from '../../../state/registry';
import { SPACE, TEXT, useTheme } from '../../../theme';

export default function SessionsScreen() {
  const router = useRouter();
  const { loaded, computers } = useComputers();
  const now = useMinuteClock();
  const theme = useTheme();
  const registry = useRegistry();
  const pull = usePullToRefresh(() => registry.refresh());
  return (
    <>
      <Stack.Screen options={{ title: t('computer.sessions') }} />
      {computers.length > 0 && (
        <HeaderButton
          sf="square.and.pencil"
          md="edit_square"
          label={t('newSession.title')}
          onPress={() => router.push('/new-session')}
          disabled={!computers.some((c) => c.status.kind === 'online')}
        />
      )}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl {...pull} tintColor={theme.mutedForeground} />}
      >
        {computers.length > 0
          ? computers.map((snapshot, index) => (
              <ComputerSessions
                key={snapshot.record.name}
                snapshot={snapshot}
                now={now}
                first={index === 0}
              />
            ))
          : loaded && (
              <EmptyState
                icon={{ ios: 'laptopcomputer.and.iphone', android: 'devices' }}
                title={t('computers.empty')}
                action={{
                  title: t('computers.add'),
                  icon: { ios: 'qrcode.viewfinder', android: 'qr_code_scanner' },
                  onPress: () => router.push('/add'),
                }}
              />
            )}
      </ScrollView>
    </>
  );
}

function ComputerSessions({
  snapshot,
  now,
  first,
}: {
  snapshot: LinkSnapshot;
  now: Date;
  first: boolean;
}) {
  const theme = useTheme();
  const router = useRouter();
  const registry = useRegistry();
  const { record, sessions, status } = snapshot;
  const list = sessions.kind === 'ready' ? sessions.sessions : [];
  const placeholder = sessionsPlaceholder(snapshot);
  return (
    <View style={first && styles.firstSection}>
      <Pressable
        accessibilityRole="button"
        onPress={() => router.push({ pathname: '/computer/[name]', params: { name: record.name } })}
        style={({ pressed }) => ({ opacity: pressed ? 0.55 : 1 })}
      >
        <SectionTitle trailing={<Chevron color={theme.mutedForeground} />}>
          <View style={styles.heading}>
            <Text style={[styles.computer, { color: theme.foreground }]} numberOfLines={1}>
              {displayName(record)}
            </Text>
            <StatusText line={statusLine(snapshot, now)} size={TEXT.caption} />
          </View>
        </SectionTitle>
      </Pressable>
      {list.length > 0 ? (
        <Group>
          {list.map((session, index) => (
            <SessionRow
              key={session.id}
              session={session}
              computer={record.name}
              now={now}
              last={index === list.length - 1}
              onPress={() =>
                router.push({
                  pathname: '/session/[key]',
                  params: { key: `${record.name}/${session.id}` },
                })
              }
            />
          ))}
        </Group>
      ) : (
        placeholder !== undefined &&
        status.kind !== 'removed' &&
        (sessions.kind === 'failed' ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => void registry.link(record.name)?.refresh()}
            hitSlop={8}
            style={({ pressed }) => [styles.retry, { opacity: pressed ? 0.5 : 1 }]}
          >
            <Text style={[styles.placeholder, { color: theme.mutedForeground }]}>
              {t(placeholder)}
            </Text>
            <Icon
              name={{ ios: 'arrow.clockwise', android: 'refresh' }}
              size={13}
              color={theme.mutedForeground}
            />
          </Pressable>
        ) : (
          <Text style={[styles.placeholder, { color: theme.mutedForeground }]}>
            {t(placeholder)}
          </Text>
        ))
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: SPACE.page, paddingBottom: 120 },
  firstSection: { marginTop: -12 },
  heading: { flexShrink: 1, gap: 2 },
  computer: { fontSize: TEXT.title, fontWeight: '700', letterSpacing: -0.3 },
  placeholder: { fontSize: TEXT.small, marginHorizontal: 6 },
  retry: { flexDirection: 'row', alignItems: 'center', gap: 2, alignSelf: 'flex-start' },
});
