// 助理页（首页）：所有配对电脑上的助理合并成一个聊天式列表，等用户决定的在前，其余按最后动静排；行内标电脑名。右上角新建：这台设备
// 在哪台电脑上都没有建助理的权限（手机默认没有）时灰掉，列表下面说明到电脑上哪里开。

import { Stack, useRouter } from 'expo-router';
import { ScrollView, StyleSheet, Text } from 'react-native';
import { BotRow } from '../../../components/bot-row';
import { HeaderButton } from '../../../components/header-button';
import { EmptyState, Group } from '../../../components/ui';
import { t } from '../../../i18n';
import { useBotCreators, useBots, useOnlineBotHosts } from '../../../state/bots';
import { useMinuteClock } from '../../../state/clock';
import { SPACE, TEXT, useTheme } from '../../../theme';

export default function BotsScreen() {
  const router = useRouter();
  const { loaded, bots } = useBots();
  const now = useMinuteClock();
  const theme = useTheme();
  const canCreate = useBotCreators().length > 0;
  const online = useOnlineBotHosts();
  const create = () => router.push('/new-bot');
  const forbidden =
    online > 0 && !canCreate ? (
      <Text style={[styles.note, { color: theme.mutedForeground }]}>{t('bots.newForbidden')}</Text>
    ) : undefined;
  return (
    <>
      <Stack.Screen options={{ title: t('bots.title') }} />
      <HeaderButton
        sf="plus"
        md="add"
        label={t('bots.new')}
        onPress={create}
        disabled={!canCreate}
      />
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
              {...(canCreate && {
                action: {
                  title: t('bots.new'),
                  icon: { ios: 'plus', android: 'add' },
                  onPress: create,
                },
              })}
            />
          )
        )}
        {forbidden}
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: SPACE.page, paddingBottom: 120 },
  list: { marginTop: 8 },
  note: { fontSize: TEXT.small, lineHeight: 20, marginTop: 12, marginHorizontal: 6 },
});
