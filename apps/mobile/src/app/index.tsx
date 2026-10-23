// 首页：配对过的电脑，每台显示在线 / 离线（上次在线时间）与直连 / 经中继。

import { Link, Stack, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Button, StatusText } from '../components/ui';
import { t } from '../i18n';
import { displayName } from '../lib/records';
import { statusLine } from '../lib/status-text';
import { useComputers } from '../state/registry';
import { RADIUS, TEXT, useTheme } from '../theme';

/** “上次在线”的相对时间每分钟刷新一次。 */
function useMinuteClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export default function ComputersScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { loaded, computers } = useComputers();
  const now = useMinuteClock();
  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <Link href="/add" asChild>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('computers.add')}
                hitSlop={12}
              >
                <Text style={[styles.plus, { color: theme.foreground }]}>+</Text>
              </Pressable>
            </Link>
          ),
        }}
      />
      <FlatList
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: theme.background }}
        contentContainerStyle={styles.content}
        data={computers}
        keyExtractor={(item) => item.record.name}
        ItemSeparatorComponent={() => <View style={styles.gap} />}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            onPress={() =>
              router.push({ pathname: '/computer/[name]', params: { name: item.record.name } })
            }
            style={({ pressed }) => [
              styles.row,
              { backgroundColor: pressed ? theme.muted : theme.card, borderColor: theme.border },
            ]}
          >
            <View style={styles.rowText}>
              <Text style={[styles.name, { color: theme.foreground }]} numberOfLines={1}>
                {displayName(item.record)}
              </Text>
              <StatusText line={statusLine(item, now)} />
            </View>
            <Text style={[styles.chevron, { color: theme.mutedForeground }]}>›</Text>
          </Pressable>
        )}
        ListEmptyComponent={
          loaded ? (
            <View style={styles.empty}>
              <Text style={[styles.emptyText, { color: theme.mutedForeground }]}>
                {t('computers.empty')}
              </Text>
              <Button title={t('computers.add')} onPress={() => router.push('/add')} />
            </View>
          ) : undefined
        }
      />
    </>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
  gap: { height: 10 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: RADIUS.card,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 16,
    paddingVertical: 14,
    gap: 12,
  },
  rowText: { flex: 1, gap: 4 },
  name: { fontSize: TEXT.title, fontWeight: '600' },
  chevron: { fontSize: 24, fontWeight: '300' },
  plus: { fontSize: 28, fontWeight: '300', paddingHorizontal: 4 },
  empty: { alignItems: 'center', gap: 16, paddingTop: 96 },
  emptyText: { fontSize: TEXT.body },
});
