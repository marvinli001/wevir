import { ASSISTANT_PROACTIVITY, type Automation } from '@wevir/protocol';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { BotAvatar } from '../components/bot-avatar';
import { Button, Group, Row, SectionTitle } from '../components/ui';
import { t, timeAgo } from '../i18n';
import { type Bot, botProactivity, botRoutineStatus } from '../lib/bots';
import { useBot, useBotAccess, useBotStore, useTimeline } from '../state/bots';
import { useMinuteClock } from '../state/clock';
import { SPACE, TEXT, useTheme } from '../theme';

export default function BotProfileScreen() {
  const { key } = useLocalSearchParams<{ key: string }>();
  const bot = useBot(key);
  return bot === undefined ? null : <BotProfile bot={bot} />;
}

function BotProfile({ bot }: { bot: Bot }) {
  const theme = useTheme();
  const router = useRouter();
  const store = useBotStore();
  const access = useBotAccess(bot.key);
  const timeline = useTimeline(bot.key);
  const now = useMinuteClock();
  const channel = store.channel(bot.key);
  const [routines, setRoutines] = useState<Automation[]>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!access.online || !access.panel) return;
    let stopped = false;
    const connectionVersion = access.connectionVersion;
    const load = () => {
      void store
        .routines(bot.key)
        .then((items) => {
          if (!stopped && store.access(bot.key).connectionVersion === connectionVersion)
            setRoutines(items);
        })
        .catch(() => {
          if (!stopped) setFailed(true);
        });
    };
    load();
    void store.open(bot.key).catch(() => {
      if (!stopped) setFailed(true);
    });
    const unwatch = store.watchRoutines(bot.key, load);
    return () => {
      stopped = true;
      unwatch();
    };
  }, [store, bot.key, access.online, access.panel, access.connectionVersion]);
  const perform = async (action: () => Promise<void>) => {
    setBusy(true);
    setFailed(false);
    try {
      await action();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  const threads = timeline.threads.filter(
    (thread) => thread.status === 'working' || thread.status === 'waiting',
  );
  const proactivity = channel?.budget === undefined ? undefined : botProactivity(channel.budget);
  return (
    <>
      <Stack.Screen options={{ title: t('bot.profile') }} />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <BotAvatar avatar={bot.avatar} size={72} />
          <Text style={[styles.name, { color: theme.foreground }]}>{bot.name}</Text>
          {bot.lastActiveAt !== undefined && (
            <Text style={[styles.small, { color: theme.mutedForeground }]}>
              {t('bot.lastActive', { time: timeAgo(bot.lastActiveAt, now) })}
            </Text>
          )}
          <Text style={[styles.description, { color: theme.softForeground }]}>
            {bot.description}
          </Text>
        </View>
        {failed && (
          <Text style={[styles.error, { color: theme.destructive }]}>{t('bot.actionFailed')}</Text>
        )}
        {access.canPause && (
          <Button
            title={t(bot.state === 'paused' ? 'bot.resume' : 'bot.pause')}
            kind="secondary"
            disabled={busy}
            onPress={() => void perform(() => store.pause(bot.key, bot.state !== 'paused'))}
          />
        )}
        {access.panel && (
          <>
            <SectionTitle
              trailing={
                channel?.proactiveLimited ? (
                  <Text style={[styles.small, { color: theme.mutedForeground }]}>
                    {t('bot.limited')}
                  </Text>
                ) : undefined
              }
            >
              {t('bot.recentActivity')}
            </SectionTitle>
            <Group>
              {threads.map((thread, index) => (
                <Row
                  key={thread.sessionId}
                  leading={
                    thread.status === 'working' ? (
                      <ActivityIndicator size="small" color={theme.running} />
                    ) : undefined
                  }
                  title={thread.title}
                  subtitle={
                    <Text
                      numberOfLines={1}
                      style={[styles.small, { color: theme.mutedForeground }]}
                    >
                      {thread.doing ?? t(`bot.thread.${thread.status}`)}
                    </Text>
                  }
                  last={index === threads.length - 1 && routines?.length === 0}
                  onPress={() =>
                    router.push({
                      pathname: '/session/[key]',
                      params: { key: `${bot.computer}/${thread.sessionId}`, botKey: bot.key },
                    })
                  }
                />
              ))}
              {routines?.map((routine, index) => (
                <Row
                  key={routine.id}
                  icon={{ ios: 'clock', android: 'schedule' }}
                  title={routine.title}
                  subtitle={
                    <Text style={[styles.small, { color: theme.mutedForeground }]}>
                      {botRoutineStatus(routine, now)}
                    </Text>
                  }
                  last={index === routines.length - 1}
                />
              ))}
              {routines === undefined && access.online && !failed && (
                <Row title={<ActivityIndicator color={theme.mutedForeground} />} last />
              )}
              {threads.length === 0 && routines?.length === 0 && (
                <Row title={t('bot.noActivity')} last />
              )}
            </Group>
            {channel?.budget !== undefined && (
              <>
                <SectionTitle
                  trailing={
                    proactivity === undefined ? (
                      <Text style={[styles.small, { color: theme.mutedForeground }]}>
                        {t('bot.proactivity.custom')}
                      </Text>
                    ) : undefined
                  }
                >
                  {t('bot.proactivity')}
                </SectionTitle>
                <Group>
                  {(
                    Object.keys(ASSISTANT_PROACTIVITY) as (keyof typeof ASSISTANT_PROACTIVITY)[]
                  ).map((key, index) => (
                    <Row
                      key={key}
                      title={t(`bot.proactivity.${key}`)}
                      last={index === 2}
                      chevron={false}
                      trailing={
                        proactivity === key ? (
                          <Text style={{ color: theme.foreground }}>✓</Text>
                        ) : undefined
                      }
                      {...(access.canEdit &&
                        !busy && {
                          onPress: () =>
                            void perform(() =>
                              store.update(bot.key, { budget: ASSISTANT_PROACTIVITY[key] }),
                            ),
                        })}
                    />
                  ))}
                </Group>
              </>
            )}
          </>
        )}
        <Group style={styles.edit}>
          <Row
            title={t('editBot.title')}
            icon={{ ios: 'slider.horizontal.3', android: 'tune' }}
            last
            onPress={() => router.push({ pathname: '/edit-bot', params: { key: bot.key } })}
          />
        </Group>
      </ScrollView>
    </>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: SPACE.page, paddingBottom: 40, gap: 12 },
  hero: { alignItems: 'center', paddingVertical: 24, gap: 10 },
  name: { fontSize: TEXT.title, fontWeight: '600' },
  description: { fontSize: TEXT.body, textAlign: 'center', lineHeight: 22 },
  small: { fontSize: TEXT.caption },
  error: { fontSize: TEXT.small, textAlign: 'center' },
  edit: { marginTop: SPACE.section },
});
