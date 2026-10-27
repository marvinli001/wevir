// 电脑页：配对过的电脑，每台显示在线 / 离线（上次在线时间）与直连 / 经中继；导航栏右边的玻璃按钮添加电脑。下面是“安全”一组：
// 可选的 App 锁（state/lock.tsx），再下面是推送的锁屏设置。

import { Stack, useRouter } from 'expo-router';
import { ScrollView, StyleSheet, Switch, Text } from 'react-native';
import { HeaderButton } from '../../../components/header-button';
import { PushSettingsSection } from '../../../components/push-section';
import { EmptyState, Group, Row, SectionTitle, StatusText } from '../../../components/ui';
import { t } from '../../../i18n';
import { displayName } from '../../../lib/records';
import { statusLine } from '../../../lib/status-text';
import { useMinuteClock } from '../../../state/clock';
import { useLock } from '../../../state/lock';
import { useComputers } from '../../../state/registry';
import { SPACE, TEXT, useTheme } from '../../../theme';

export default function ComputersScreen() {
  const router = useRouter();
  const { loaded, computers } = useComputers();
  const now = useMinuteClock();
  const add = () => router.push('/add');
  return (
    <>
      <Stack.Screen options={{ title: t('computers.title') }} />
      <HeaderButton sf="plus" md="add" label={t('computers.add')} onPress={add} />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        {computers.length > 0 ? (
          <>
            <Group>
              {computers.map((item, index) => (
                <Row
                  key={item.record.name}
                  icon={{ ios: 'laptopcomputer', android: 'laptop_mac' }}
                  title={displayName(item.record)}
                  subtitle={<StatusText line={statusLine(item, now)} />}
                  last={index === computers.length - 1}
                  onPress={() =>
                    router.push({
                      pathname: '/computer/[name]',
                      params: { name: item.record.name },
                    })
                  }
                />
              ))}
            </Group>
          </>
        ) : (
          loaded && (
            <EmptyState
              icon={{ ios: 'laptopcomputer.and.iphone', android: 'devices' }}
              title={t('computers.empty')}
              action={{
                title: t('computers.add'),
                icon: { ios: 'qrcode.viewfinder', android: 'qr_code_scanner' },
                onPress: add,
              }}
            />
          )
        )}
        <Security />
        {computers.length > 0 && <PushSettingsSection />}
      </ScrollView>
    </>
  );
}

function Security() {
  const theme = useTheme();
  const lock = useLock();
  const unavailable = lock.available === 'none';
  const icon =
    lock.available === 'fingerprint'
      ? ({ ios: 'touchid', android: 'fingerprint' } as const)
      : ({ ios: 'faceid', android: 'fingerprint' } as const);
  return (
    <>
      <SectionTitle>{t('lock.section')}</SectionTitle>
      <Group>
        <Row
          icon={icon}
          title={t('lock.title')}
          subtitle={
            unavailable && !lock.enabled ? (
              <Text style={[styles.note, { color: theme.mutedForeground }]}>
                {t('lock.unavailable')}
              </Text>
            ) : undefined
          }
          trailing={
            <Switch
              value={lock.enabled}
              disabled={!lock.ready || (unavailable && !lock.enabled)}
              onValueChange={(next) => void lock.setEnabled(next)}
            />
          }
          last
        />
      </Group>
    </>
  );
}

const styles = StyleSheet.create({
  content: { padding: SPACE.page, paddingBottom: 120 },
  note: { fontSize: TEXT.small },
});
