// 助理页（首页）：所有配对电脑上的助理合并成一个聊天式列表，等用户决定的在前，其余按最后动静排；行内标电脑名。右上角新建。

import { Stack, useRouter } from 'expo-router';
import { ScrollView, StyleSheet } from 'react-native';
import { BotRow } from '../../../components/bot-row';
import { HeaderButton } from '../../../components/header-button';
import { EmptyState, Group } from '../../../components/ui';
import { t } from '../../../i18n';
import { useBots } from '../../../state/bots';
import { useMinuteClock } from '../../../state/clock';
import { SPACE } from '../../../theme';

export default function BotsScreen() {
  const router = useRouter();
  const { loaded, bots } = useBots();
  const now = useMinuteClock();
  const create = () => router.push('/new-bot');
  return (
    <>
      <Stack.Screen options={{ title: t('bots.title') }} />
      <HeaderButton sf="plus" md="add" label={t('bots.new')} onPress={create} />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        {bots.length > 0 ? (
          <Group style={styles.list}>
            {bots.map((bot, index) => (
              <BotRow
                key={bot.key}
                bot={bot}
                now={now}
                last={index === bots.length - 1}
                onPress={() => router.push({ pathname: '/bot/[key]', params: { key: bot.key } })}
              />
            ))}
          </Group>
        ) : (
          loaded && (
            <EmptyState
              icon={{ ios: 'sparkles', android: 'auto_awesome' }}
              title={t('bots.empty')}
              action={{
                title: t('bots.new'),
                icon: { ios: 'plus', android: 'add' },
                onPress: create,
              }}
            />
          )
        )}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: SPACE.page, paddingBottom: 120 },
  list: { marginTop: 8 },
});
