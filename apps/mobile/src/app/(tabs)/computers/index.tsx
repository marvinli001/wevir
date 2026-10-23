// 电脑页：配对过的电脑，每台显示在线 / 离线（上次在线时间）与直连 / 经中继；导航栏右边的玻璃按钮添加电脑。

import { Stack, useRouter } from 'expo-router';
import { ScrollView, StyleSheet } from 'react-native';
import { HeaderButton } from '../../../components/header-button';
import { EmptyState, Group, Row, StatusText } from '../../../components/ui';
import { t } from '../../../i18n';
import { displayName } from '../../../lib/records';
import { statusLine } from '../../../lib/status-text';
import { useMinuteClock } from '../../../state/clock';
import { useComputers } from '../../../state/registry';
import { SPACE } from '../../../theme';

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
          <Group>
            {computers.map((item, index) => (
              <Row
                key={item.record.name}
                icon={{ ios: 'laptopcomputer', android: 'laptop_mac' }}
                title={displayName(item.record)}
                subtitle={<StatusText line={statusLine(item, now)} />}
                last={index === computers.length - 1}
                onPress={() =>
                  router.push({ pathname: '/computer/[name]', params: { name: item.record.name } })
                }
              />
            ))}
          </Group>
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
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  content: { padding: SPACE.page, paddingBottom: 120 },
});
