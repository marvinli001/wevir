// 一台电脑上已归档的会话（同桌面端 设置 → 已归档）：`session.list { archived: true }` 读出，按归档时刻从新到旧，导航栏里搜索标题或
// 项目名。点一行打开会话（只读历史，菜单里能取消归档）；行尾“取消归档”把会话放回列表，底部几秒“撤销”。每次回到这页重读，下拉也重读。

import type { Session, SessionId } from '@wevir/protocol';
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Group, Icon, Row } from '../../components/ui';
import { t, timeAgo } from '../../i18n';
import { archivedSessions, folderName } from '../../lib/sessions';
import { useMinuteClock } from '../../state/clock';
import { usePullToRefresh } from '../../state/refresh';
import { useComputer, useRegistry } from '../../state/registry';
import { useToast } from '../../state/toast';
import { SPACE, TEXT, useTheme } from '../../theme';

export default function ArchivedScreen() {
  const { name } = useLocalSearchParams<{ name: string }>();
  const theme = useTheme();
  const router = useRouter();
  const registry = useRegistry();
  const showToast = useToast();
  const now = useMinuteClock();
  const snapshot = useComputer(name);
  // 连接换了（重连、回到前台）时跟着换，重新读。
  const client = snapshot !== undefined ? registry.link(name)?.sessions : undefined;
  const [sessions, setSessions] = useState<Session[]>();
  const [failure, setFailure] = useState<string>();
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<SessionId>();
  // 只认最后一次读取的结果。
  const latest = useRef(0);

  const load = useCallback(async () => {
    if (client === undefined) return;
    const ticket = ++latest.current;
    try {
      const result = await client.request('session.list', { archived: true });
      if (ticket !== latest.current) return;
      setSessions(result.sessions);
      setFailure(undefined);
    } catch (e) {
      if (ticket !== latest.current) return;
      setFailure(t('archived.failed', { error: e instanceof Error ? e.message : String(e) }));
    }
  }, [client]);
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );
  const pull = usePullToRefresh(load);
  const shown = useMemo(() => archivedSessions(sessions ?? [], query), [sessions, query]);

  const setArchived = async (session: Session, archived: boolean) => {
    if (client === undefined) return;
    await client.request('session.archive', { sessionId: session.id, archived });
  };

  const unarchive = (session: Session) => {
    if (busy !== undefined) return;
    setBusy(session.id);
    setArchived(session, false).then(
      () => {
        setBusy(undefined);
        setSessions((current) => current?.filter((candidate) => candidate.id !== session.id));
        showToast({
          text: t('session.unarchived'),
          action: {
            label: t('session.undo'),
            onPress: () =>
              void setArchived(session, true).then(load, (e: unknown) => {
                console.warn('[wevir] could not archive again', e);
                Alert.alert(t('session.archiveFailed'));
              }),
          },
        });
      },
      (e: unknown) => {
        setBusy(undefined);
        console.warn('[wevir] could not unarchive', e);
        Alert.alert(t('session.unarchiveFailed'));
      },
    );
  };

  const placeholder =
    client === undefined
      ? t('archived.offline')
      : failure !== undefined
        ? failure
        : sessions === undefined
          ? undefined
          : sessions.length === 0
            ? t('archived.empty')
            : shown.length === 0
              ? t('archived.noMatches')
              : undefined;

  return (
    <>
      <Stack.Screen
        options={{
          headerSearchBarOptions: {
            placeholder: t('archived.search'),
            hideWhenScrolling: false,
            autoCapitalize: 'none',
            // 搜索时留着导航栏：不然列表顶到状态栏，右上角的设置按钮压在行尾按钮上。
            hideNavigationBar: false,
            obscureBackground: false,
            onChangeText: (event) => setQuery(event.nativeEvent.text),
            onCancelButtonPress: () => setQuery(''),
          },
        }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="on-drag"
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl {...pull} tintColor={theme.mutedForeground} />}
        testID="archived-list"
      >
        {client !== undefined && sessions === undefined && failure === undefined ? (
          <ActivityIndicator style={styles.loading} color={theme.mutedForeground} />
        ) : placeholder !== undefined ? (
          <Text
            style={[
              styles.placeholder,
              { color: failure !== undefined ? theme.destructive : theme.mutedForeground },
            ]}
          >
            {placeholder}
          </Text>
        ) : (
          <Group>
            {shown.map((session, index) => (
              <Row
                key={session.id}
                last={index === shown.length - 1}
                chevron={false}
                onPress={() =>
                  router.push({
                    pathname: '/session/[key]',
                    params: { key: `${name}/${session.id}` },
                  })
                }
                leading={
                  <View style={styles.mark}>
                    <Icon
                      name={{ ios: 'archivebox', android: 'archive' }}
                      size={17}
                      color={theme.mutedForeground}
                    />
                  </View>
                }
                title={
                  <Text style={[styles.title, { color: theme.foreground }]} numberOfLines={1}>
                    {session.title.trim() || t('session.untitled')}
                  </Text>
                }
                subtitle={
                  <Text style={[styles.meta, { color: theme.mutedForeground }]} numberOfLines={1}>
                    {`${folderName(session.cwd)} · ${timeAgo(session.archivedAt ?? session.updatedAt, now)}`}
                  </Text>
                }
                trailing={
                  client?.canWrite === true && (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t('session.unarchive')}
                      accessibilityState={{ disabled: busy !== undefined }}
                      disabled={busy !== undefined}
                      onPress={() => unarchive(session)}
                      hitSlop={8}
                      style={({ pressed }) => [
                        styles.unarchive,
                        {
                          borderColor: theme.borderStrong,
                          opacity: pressed || busy !== undefined ? 0.6 : 1,
                        },
                      ]}
                      testID="archived-unarchive"
                    >
                      {busy === session.id ? (
                        <ActivityIndicator size="small" color={theme.foreground} />
                      ) : (
                        <Text style={[styles.unarchiveText, { color: theme.foreground }]}>
                          {t('session.unarchive')}
                        </Text>
                      )}
                    </Pressable>
                  )
                }
              />
            ))}
          </Group>
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: SPACE.page, paddingTop: 8, paddingBottom: 64 },
  loading: { marginTop: 32 },
  placeholder: { fontSize: TEXT.small, marginHorizontal: 6, marginTop: 8 },
  mark: { width: 22, height: 22, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: TEXT.body, fontWeight: '600', letterSpacing: -0.2 },
  meta: { fontSize: TEXT.small },
  unarchive: {
    minHeight: 30,
    minWidth: 64,
    paddingHorizontal: 11,
    borderRadius: 15,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  unarchiveText: { fontSize: TEXT.small, fontWeight: '600' },
});
