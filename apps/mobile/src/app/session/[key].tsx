// 一个会话（多是助理开出的线程）：大标题是会话标题，下面一行是所在电脑与状态；消息流只读（用户的话是气泡，回答是正文，工具一行），
// 末尾是待批准的审批（批准 / 拒绝）与要到电脑上回答的问题。打开时停在最新一条。

import type { ApprovalId, SessionId } from '@wevir/protocol';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';
import { PostView } from '../../components/bot-cards';
import { HeaderButton } from '../../components/header-button';
import { Icon } from '../../components/ui';
import { t } from '../../i18n';
import { displayName } from '../../lib/records';
import { type SessionItem, sessionItems, type ToolState } from '../../lib/session-items';
import { type SessionView, SessionWatch } from '../../lib/session-watch';
import { useMinuteClock } from '../../state/clock';
import { useComputer, useRegistry } from '../../state/registry';
import { SPACE, TEXT, type Theme, useTheme } from '../../theme';

export default function SessionScreen() {
  const { key } = useLocalSearchParams<{ key: string }>();
  const slash = key.indexOf('/');
  const computer = key.slice(0, slash);
  const sessionId = key.slice(slash + 1) as SessionId;
  const router = useRouter();
  const registry = useRegistry();
  const snapshot = useComputer(computer);
  const theme = useTheme();
  // 连接换了（重连、回到前台）时重新取：`sessions` 跟着连接换对象。
  const client = snapshot !== undefined ? registry.link(computer)?.sessions : undefined;
  const [view, setView] = useState<SessionView>({ caughtUp: false });
  const watch = useRef<SessionWatch | undefined>(undefined);

  useEffect(() => {
    if (client === undefined) return;
    const current = new SessionWatch(client, sessionId, setView);
    watch.current = current;
    void current.start();
    return () => {
      current.stop();
      if (watch.current === current) watch.current = undefined;
    };
  }, [client, sessionId]);

  const items = useMemo(
    () => (view.transcript !== undefined ? sessionItems(view.transcript, t('bot.image')) : []),
    [view.transcript],
  );
  const state = view.transcript?.state ?? view.session?.state;
  const title = view.transcript?.title || view.session?.title || t('session.untitled');
  const meta = [
    snapshot !== undefined ? displayName(snapshot.record) : undefined,
    state !== undefined ? t(`session.state.${state}`) : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(' · ');

  return (
    <>
      <Stack.Screen options={{ title }} />
      <HeaderButton
        sf="plus.forwardslash.minus"
        md="difference"
        label={t('changes.title')}
        onPress={() => router.push({ pathname: '/changes/[key]', params: { key } })}
      />
      <SessionList
        items={items}
        meta={meta}
        loading={!view.caughtUp && view.error === undefined}
        failed={view.error !== undefined || (snapshot !== undefined && client === undefined)}
        theme={theme}
        onDecide={async (approvalId, decision) => {
          await watch.current?.respond(approvalId as ApprovalId, decision);
        }}
      />
    </>
  );
}

function SessionList({
  items,
  meta,
  loading,
  failed,
  theme,
  onDecide,
}: {
  items: readonly SessionItem[];
  meta: string;
  loading: boolean;
  failed: boolean;
  theme: Theme;
  onDecide: (approvalId: string, decision: 'approved' | 'rejected') => Promise<void>;
}) {
  const now = useMinuteClock();
  const list = useRef<FlatList<SessionItem>>(null);
  const pinned = useRef(true);
  return (
    <FlatList
      ref={list}
      data={items}
      keyExtractor={(item) => item.key}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      initialNumToRender={60}
      onScroll={(e) => {
        const n = e.nativeEvent;
        pinned.current =
          n.contentSize.height - n.contentOffset.y - n.layoutMeasurement.height < 120;
      }}
      scrollEventThrottle={100}
      onContentSizeChange={() => {
        if (pinned.current) list.current?.scrollToEnd({ animated: false });
      }}
      ListHeaderComponent={
        <Text style={[styles.meta, { color: theme.mutedForeground }]} numberOfLines={1}>
          {meta}
        </Text>
      }
      ListEmptyComponent={
        loading ? (
          <ActivityIndicator style={styles.empty} color={theme.mutedForeground} />
        ) : (
          <Text style={[styles.emptyText, { color: theme.mutedForeground }]}>
            {failed ? t('thread.unavailable') : t('thread.empty')}
          </Text>
        )
      }
      renderItem={({ item }) => (
        <View style={styles.item}>
          <Item item={item} now={now} theme={theme} onDecide={onDecide} />
        </View>
      )}
    />
  );
}

function Item({
  item,
  now,
  theme,
  onDecide,
}: {
  item: SessionItem;
  now: Date;
  theme: Theme;
  onDecide: (approvalId: string, decision: 'approved' | 'rejected') => Promise<void>;
}) {
  switch (item.kind) {
    case 'user':
    case 'assistant':
      return (
        <PostView
          post={{
            id: item.key,
            author: item.kind === 'user' ? 'user' : 'bot',
            createdAt: now.toISOString(),
            card: { kind: 'text', text: item.text },
          }}
          now={now}
          onDecide={async () => {}}
          onOpenThread={() => {}}
          onRetry={() => {}}
        />
      );
    case 'approval':
      return (
        <PostView
          post={item.post}
          now={now}
          onDecide={(_, decision) => onDecide(item.approvalId, decision)}
          onOpenThread={() => {}}
          onRetry={() => {}}
        />
      );
    case 'tool':
      return (
        <View style={styles.tool}>
          <Icon
            name={toolIcon(item.state)}
            size={14}
            color={item.state === 'failed' ? theme.destructive : theme.mutedForeground}
          />
          <Text
            style={[styles.toolText, { color: theme.mutedForeground }]}
            numberOfLines={1}
            ellipsizeMode="middle"
          >
            {item.label}
          </Text>
        </View>
      );
    case 'error':
      return (
        <Text style={[styles.note, { color: theme.destructive }]} selectable>
          {item.text}
        </Text>
      );
    case 'question':
      return (
        <View style={[styles.question, { backgroundColor: theme.card }]}>
          <Text style={[styles.questionText, { color: theme.foreground }]}>{item.text}</Text>
          <Text style={[styles.note, { color: theme.mutedForeground }]}>
            {t('thread.answerOnComputer')}
          </Text>
        </View>
      );
  }
}

function toolIcon(state: ToolState) {
  switch (state) {
    case 'running':
      return { ios: 'ellipsis.circle', android: 'more_horiz' } as const;
    case 'failed':
      return { ios: 'xmark.circle', android: 'cancel' } as const;
    case 'done':
      return { ios: 'checkmark.circle', android: 'check_circle' } as const;
  }
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: SPACE.page, paddingBottom: 48 },
  meta: { fontSize: TEXT.caption, paddingHorizontal: 4, paddingBottom: 8 },
  item: { marginTop: 12 },
  tool: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  toolText: { flex: 1, fontSize: TEXT.small },
  note: { fontSize: TEXT.small, paddingHorizontal: 4 },
  question: { borderRadius: 16, padding: 14, gap: 6 },
  questionText: { fontSize: TEXT.body, lineHeight: 22 },
  empty: { marginTop: 48 },
  emptyText: { fontSize: TEXT.small, textAlign: 'center', marginTop: 48 },
});
