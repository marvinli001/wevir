// 一台电脑：大标题是电脑名，下面一张状态卡（连接状态、说明、重试 / 重新配对），实时的会话列表（`session.list` +
// `sessions.changed`，只读），这台电脑的推送状态，最后是“退出这台电脑”。

import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { PushStatusSection } from '../../components/push-section';
import { SessionRow } from '../../components/session-row';
import { Button, Group, Icon, Row, SectionTitle, StatusText } from '../../components/ui';
import { t } from '../../i18n';
import type { LinkSnapshot } from '../../lib/computer-link';
import { displayName } from '../../lib/records';
import { sessionsPlaceholder, statusLine, statusNotice } from '../../lib/status-text';
import { useMinuteClock } from '../../state/clock';
import { useComputer, useRegistry } from '../../state/registry';
import { RADIUS, SPACE, TEXT, useTheme } from '../../theme';

export default function ComputerScreen() {
  const { name } = useLocalSearchParams<{ name: string }>();
  const snapshot = useComputer(name);
  if (snapshot === undefined) return null;
  return <ComputerDetail snapshot={snapshot} />;
}

function ComputerDetail({ snapshot }: { snapshot: LinkSnapshot }) {
  const theme = useTheme();
  const router = useRouter();
  const registry = useRegistry();
  const now = useMinuteClock();
  const { record, status, sessions } = snapshot;
  const notice = statusNotice(status);
  const sessionList = sessions.kind === 'ready' ? sessions.sessions : [];
  const placeholder = sessionList.length === 0 ? sessionsPlaceholder(snapshot) : undefined;

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

  return (
    <>
      <Stack.Screen options={{ title: displayName(record) }} />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        <Group style={styles.statusCard}>
          <View style={styles.statusHead}>
            <View style={[styles.hero, { backgroundColor: theme.muted }]}>
              <Icon
                name={{ ios: 'laptopcomputer', android: 'laptop_mac' }}
                size={26}
                color={theme.foreground}
              />
            </View>
            <View style={styles.statusText}>
              <StatusText line={statusLine(snapshot, now)} size={TEXT.body} />
            </View>
          </View>
          {notice !== undefined && (
            <Text style={[styles.notice, { color: theme.softForeground }]}>{t(notice)}</Text>
          )}
          {status.kind === 'removed' && (
            <Button
              title={t('computer.pairAgain')}
              icon={{ ios: 'qrcode.viewfinder', android: 'qr_code_scanner' }}
              onPress={() => router.push('/add')}
            />
          )}
          {status.kind === 'offline' && status.reason !== 'host_mismatch' && (
            <Button
              kind="secondary"
              title={t('computer.retry')}
              icon={{ ios: 'arrow.clockwise', android: 'refresh' }}
              onPress={() => registry.link(record.name)?.retryNow()}
            />
          )}
        </Group>

        {status.kind !== 'removed' && (
          <>
            <SectionTitle>{t('computer.sessions')}</SectionTitle>
            {sessionList.length > 0 ? (
              <Group>
                {sessionList.map((session, index) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    now={now}
                    last={index === sessionList.length - 1}
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
              placeholder !== undefined && (
                <Text style={[styles.placeholder, { color: theme.mutedForeground }]}>
                  {t(placeholder)}
                </Text>
              )
            )}
          </>
        )}

        {status.kind !== 'removed' && <PushStatusSection name={record.name} />}

        <Group style={styles.forget}>
          <Row
            last
            chevron={false}
            title={
              <Text style={[styles.forgetText, { color: theme.destructive }]}>
                {t('computer.forget')}
              </Text>
            }
            onPress={forget}
          />
        </Group>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: SPACE.page, paddingTop: 8, paddingBottom: 64 },
  statusCard: { padding: 18, gap: 16 },
  statusHead: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  hero: {
    width: 52,
    height: 52,
    borderRadius: RADIUS.control,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusText: { flex: 1, gap: 4 },
  notice: { fontSize: TEXT.small, lineHeight: 20 },
  placeholder: { fontSize: TEXT.small, marginHorizontal: 6 },
  forget: { marginTop: SPACE.section },
  forgetText: { fontSize: TEXT.body, fontWeight: '500', textAlign: 'center' },
});
