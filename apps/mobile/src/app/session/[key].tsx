// 一个会话：大标题是会话标题，下面一行是所在电脑与状态；消息流（用户的话是气泡，回答是正文，工具一行），末尾是待批准的审批、
// 等回答的提问（在手机上作答）与还没送达的消息（可取消）。底部是输入栏：发消息、附照片；回合进行中发出的按“插话 / 排队”送达
// （默认取电脑上“回合进行中按回车”的设置），空着时是停止。右上角的菜单：查看改动、改名、归档。打开时停在最新一条。

import { ClientClosedError } from '@wevir/client-sdk';
import type {
  ApprovalId,
  PendingDelivery,
  PendingMessageId,
  QuestionAnswer,
  QuestionId,
  SessionId,
  ToolDisplayKind,
} from '@wevir/protocol';
import { SESSION_TITLE_MAX_LENGTH } from '@wevir/protocol';
import { getRandomBytes } from 'expo-crypto';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PostView } from '../../components/bot-cards';
import { Composer } from '../../components/composer';
import { HeaderButton } from '../../components/header-button';
import { QuestionCard } from '../../components/question-card';
import { RenameDialog, useActionSheet } from '../../components/sheets';
import { Icon } from '../../components/ui';
import { type MessageKey, t, timeAgo } from '../../i18n';
import { keyboardOverlap } from '../../lib/keyboard';
import { displayName } from '../../lib/records';
import { isBusy, SessionActions, sendErrorKey } from '../../lib/session-actions';
import { type SessionItem, sessionItems, type ToolState } from '../../lib/session-items';
import { type SessionView, SessionWatch } from '../../lib/session-watch';
import { useMinuteClock } from '../../state/clock';
import { usePhotoAttachments } from '../../state/photo-attachments';
import { useComputer, useRegistry } from '../../state/registry';
import { SPACE, TEXT, type Theme, useTheme } from '../../theme';

const TOOL_VERBS: Partial<Record<ToolDisplayKind, MessageKey>> = {
  read: 'tool.read',
  search: 'tool.search',
  edit: 'tool.edit',
  write: 'tool.write',
  shell: 'tool.shell',
  fetch: 'tool.fetch',
  plan: 'tool.plan',
  sub_agent: 'tool.sub_agent',
};

/** 工具一行开头的动词；图片与不认识的种类用工具名。 */
function toolVerb(kind: ToolDisplayKind): string | undefined {
  const key = TOOL_VERBS[kind];
  return key !== undefined ? t(key) : undefined;
}

export default function SessionScreen() {
  const { key } = useLocalSearchParams<{ key: string }>();
  const slash = key.indexOf('/');
  const computer = key.slice(0, slash);
  const sessionId = key.slice(slash + 1) as SessionId;
  const registry = useRegistry();
  const router = useRouter();
  const snapshot = useComputer(computer);
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const now = useMinuteClock();
  // 连接换了（重连、回到前台）时重新取：`sessions` 跟着连接换对象。没连着时只看本地缓存。
  const link = snapshot !== undefined ? registry.link(computer) : undefined;
  const client = link?.sessions;
  const cache = link?.cache;
  const [view, setView] = useState<SessionView>({ caughtUp: false });
  const watch = useRef<SessionWatch | undefined>(undefined);
  const actions = useMemo(
    () =>
      client !== undefined ? new SessionActions(client, sessionId, getRandomBytes) : undefined,
    [client, sessionId],
  );
  const [delivery, setDelivery] = useState<PendingDelivery>('steer');
  const [error, setError] = useState<MessageKey>();
  const [renaming, setRenaming] = useState(false);
  const [keyboard, setKeyboard] = useState(0);
  const [composerHeight, setComposerHeight] = useState(64);
  const [sheet, showSheet] = useActionSheet();

  useEffect(() => {
    const current = new SessionWatch(client, sessionId, setView, cache);
    watch.current = current;
    void current.start();
    return () => {
      current.stop();
      if (watch.current === current) watch.current = undefined;
    };
  }, [client, cache, sessionId]);

  useEffect(() => {
    let stopped = false;
    void actions?.defaultDelivery().then((value) => {
      if (!stopped) setDelivery(value);
    });
    return () => {
      stopped = true;
    };
  }, [actions]);

  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      (e) => setKeyboard(keyboardOverlap(e)),
    );
    const hide = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setKeyboard(0),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const items = useMemo(
    () =>
      view.transcript !== undefined
        ? sessionItems(view.transcript, { image: t('bot.image'), tool: toolVerb })
        : [],
    [view.transcript],
  );
  const session = view.session;
  const state = view.transcript?.state ?? session?.state;
  const busy = isBusy(view.transcript ?? session);
  const readOnly = view.transcript?.readOnly ?? session?.readOnly;
  const canWrite = actions?.canWrite === true && readOnly === undefined;
  const title = view.transcript?.title || session?.title || t('session.untitled');
  const archived = session?.archivedAt !== undefined;
  const meta = [
    snapshot !== undefined ? displayName(snapshot.record) : undefined,
    view.offline === true ? offlineText(snapshot?.status.kind, view.cachedAt, now) : undefined,
    view.offline !== true && state !== undefined ? t(`session.state.${state}`) : undefined,
    archived ? t('session.archived') : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(' · ');

  // Android 的系统相册与相机是另一个 Activity：选照片时 App 进了后台、连接断开，回来后换成新连接。
  // 上传用最新的连接；旧连接已经关了就等新连接上来（最多 15 秒）再传一次。
  const latest = useRef(actions);
  latest.current = actions;
  const upload = async (...args: Parameters<SessionActions['uploadImage']>) => {
    const first = latest.current;
    if (first !== undefined) {
      try {
        return await first.uploadImage(...args);
      } catch (e) {
        if (!(e instanceof ClientClosedError)) throw e;
      }
    }
    for (let waited = 0; waited < 15_000; waited += 250) {
      const next = latest.current;
      if (next !== undefined && next !== first) return next.uploadImage(...args);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new ClientClosedError();
  };

  const photos = usePhotoAttachments({ upload, showSheet, onError: setError });

  const send = useCallback(
    async (text: string) => {
      if (actions === undefined) throw new Error('offline');
      setError(undefined);
      try {
        await actions.send({ text, images: photos.images, ...(busy && { delivery }) });
        photos.clear();
      } catch (e) {
        setError(sendErrorKey(e));
        throw e;
      }
    },
    [actions, photos, busy, delivery],
  );

  const archive = () => {
    if (actions === undefined) return;
    actions.archive(!archived).then(
      () => {
        if (!archived) router.back();
      },
      (e: unknown) =>
        Alert.alert(
          t(
            sendErrorKey(e) === 'error.computerOnly'
              ? 'error.computerOnly'
              : 'session.archiveFailed',
          ),
        ),
    );
  };

  const openMenu = () => {
    const workspaceId = session?.workspaceId;
    showSheet([
      ...(workspaceId !== undefined
        ? [
            {
              label: t('changes.title'),
              onPress: () =>
                router.push({
                  pathname: '/changes/[key]',
                  params: { key: `${computer}/${sessionId}` },
                }),
            },
          ]
        : []),
      ...(actions?.canWrite === true
        ? [
            { label: t('session.rename'), onPress: () => setRenaming(true) },
            {
              label: t(archived ? 'session.unarchive' : 'session.archive'),
              destructive: !archived,
              onPress: archive,
            },
          ]
        : []),
    ]);
  };

  const bottom = keyboard > 0 ? 8 : Math.max(insets.bottom, 8);

  return (
    <>
      <Stack.Screen options={{ title }} />
      <HeaderButton
        sf="ellipsis"
        md="more_vert"
        label={t('session.menu')}
        onPress={openMenu}
        disabled={actions === undefined}
      />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* Android 全面屏（edge-to-edge）下窗口不随键盘缩小，KeyboardAvoidingView 也算不准：按键盘高度自己让开。 */}
        <View style={[styles.flex, Platform.OS === 'android' && { marginBottom: keyboard }]}>
          <SessionList
            items={items}
            meta={meta}
            loading={!view.caughtUp && view.error === undefined}
            failed={view.error !== undefined || view.offline === true}
            theme={theme}
            canWrite={canWrite}
            bottomInset={composerHeight + 16}
            onDecide={async (approvalId, decision) => {
              await watch.current?.respond(approvalId as ApprovalId, decision);
            }}
            onAnswer={async (questionId, answers) => {
              await actions?.answer(questionId as QuestionId, answers);
            }}
            onCancelPending={(pendingId) => {
              actions
                ?.cancelPending(pendingId as PendingMessageId)
                .catch((e: unknown) => setError(sendErrorKey(e)));
            }}
          />
          <View
            style={[styles.composer, { paddingBottom: bottom }]}
            onLayout={(e) => setComposerHeight(e.nativeEvent.layout.height)}
          >
            {error !== undefined && (
              <Text style={[styles.error, { color: theme.destructive }]} testID="session-error">
                {t(error)}
              </Text>
            )}
            <Composer
              onSend={send}
              disabled={!canWrite}
              placeholder={
                readOnly !== undefined
                  ? t('session.readOnly')
                  : actions !== undefined && !actions.canWrite
                    ? t('error.computerOnly')
                    : undefined
              }
              onAttach={canWrite ? photos.choose : undefined}
              attachments={photos.attachments}
              onRemoveAttachment={photos.remove}
              busy={busy}
              onStop={canWrite ? async () => actions?.interrupt() : undefined}
              delivery={delivery}
              onDeliveryChange={setDelivery}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
      {sheet}
      <RenameDialog
        visible={renaming}
        initial={title}
        maxLength={SESSION_TITLE_MAX_LENGTH}
        onCancel={() => setRenaming(false)}
        onSave={async (next) => {
          await actions?.rename(next);
          setRenaming(false);
        }}
      />
    </>
  );
}

/** 没连着时那一段：正在连接，或离线（有缓存时带缓存的时刻）。 */
function offlineText(status: string | undefined, cachedAt: string | undefined, now: Date): string {
  if (status === 'connecting') return t('status.connecting');
  return cachedAt !== undefined
    ? t('offline.cached', { time: timeAgo(cachedAt, now) })
    : t('offline.label');
}

function SessionList({
  items,
  meta,
  loading,
  failed,
  theme,
  canWrite,
  bottomInset,
  onDecide,
  onAnswer,
  onCancelPending,
}: {
  items: readonly SessionItem[];
  meta: string;
  loading: boolean;
  failed: boolean;
  theme: Theme;
  canWrite: boolean;
  bottomInset: number;
  onDecide: (approvalId: string, decision: 'approved' | 'rejected') => Promise<void>;
  onAnswer: (questionId: string, answers: Record<string, QuestionAnswer>) => Promise<void>;
  onCancelPending: (pendingId: string) => void;
}) {
  const now = useMinuteClock();
  const list = useRef<FlatList<SessionItem>>(null);
  const headerHeight = useHeaderHeight();
  // 只认用户拖动：程序滚动在 iOS 上也会触发 onMomentumScrollEnd，读到的偏移可能已经过时。
  const follow = useRef(true);
  const dragging = useRef(false);
  const viewport = useRef(0);
  const lastKey = useRef<string | undefined>(undefined);
  const last = items.at(-1);
  // 刚发出的消息总要看见，即使之前翻到了上面。
  if (last?.key !== lastKey.current) {
    lastKey.current = last?.key;
    if (last?.kind === 'user' || last?.kind === 'pending') follow.current = true;
  }
  const settle = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    if (!dragging.current) return;
    const n = e.nativeEvent;
    follow.current = n.contentSize.height - n.contentOffset.y - n.layoutMeasurement.height < 120;
  };
  return (
    <View
      style={styles.flex}
      onLayout={(e) => {
        viewport.current = e.nativeEvent.layout.height;
      }}
    >
      <FlatList
        ref={list}
        data={items}
        keyExtractor={(item) => item.key}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]}
        initialNumToRender={60}
        onScrollBeginDrag={() => {
          dragging.current = true;
        }}
        onScrollEndDrag={(e) => {
          settle(e);
          if ((e.nativeEvent.velocity?.y ?? 0) === 0) dragging.current = false;
        }}
        onMomentumScrollEnd={(e) => {
          settle(e);
          dragging.current = false;
        }}
        // 自己算偏移：FlatList 的 scrollToEnd 按单元格估算，不算底部给输入框留的内边距。
        // 列表铺到导航栏下面，内容加导航栏高度超出一屏才滚，否则会把开头推到导航栏下。
        onContentSizeChange={(_, contentHeight) => {
          if (follow.current && contentHeight + headerHeight > viewport.current)
            list.current?.scrollToOffset({
              offset: contentHeight - viewport.current,
              animated: false,
            });
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
            <Item
              item={item}
              now={now}
              theme={theme}
              canWrite={canWrite}
              onDecide={onDecide}
              onAnswer={onAnswer}
              onCancelPending={onCancelPending}
            />
          </View>
        )}
      />
    </View>
  );
}

function Item({
  item,
  now,
  theme,
  canWrite,
  onDecide,
  onAnswer,
  onCancelPending,
}: {
  item: SessionItem;
  now: Date;
  theme: Theme;
  canWrite: boolean;
  onDecide: (approvalId: string, decision: 'approved' | 'rejected') => Promise<void>;
  onAnswer: (questionId: string, answers: Record<string, QuestionAnswer>) => Promise<void>;
  onCancelPending: (pendingId: string) => void;
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
        <QuestionCard
          request={item.request}
          canAnswer={canWrite}
          onAnswer={(answers) => onAnswer(item.request.id, answers)}
        />
      );
    case 'pending':
      return (
        <View style={styles.pending} testID="pending-message">
          <View
            style={[
              styles.pendingBubble,
              { borderColor: theme.borderStrong, backgroundColor: theme.background },
            ]}
          >
            <Text style={[styles.pendingText, { color: theme.softForeground }]} numberOfLines={4}>
              {item.text}
            </Text>
          </View>
          <View style={styles.pendingMeta}>
            <Text style={[styles.note, { color: theme.mutedForeground }]}>
              {t(`composer.pending.${item.delivery}`)}
            </Text>
            {canWrite && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('composer.cancelPending')}
                hitSlop={8}
                onPress={() => onCancelPending(item.pendingId)}
              >
                <Text style={[styles.note, styles.cancel, { color: theme.foreground }]}>
                  {t('composer.cancelPending')}
                </Text>
              </Pressable>
            )}
          </View>
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
  flex: { flex: 1 },
  content: { paddingHorizontal: SPACE.page },
  meta: { fontSize: TEXT.caption, paddingHorizontal: 4, paddingBottom: 8 },
  item: { marginTop: 12 },
  tool: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  toolText: { flex: 1, fontSize: TEXT.small },
  note: { fontSize: TEXT.small, paddingHorizontal: 4 },
  cancel: { fontWeight: '600' },
  pending: { alignItems: 'flex-end', gap: 4 },
  pendingBubble: {
    maxWidth: '82%',
    borderRadius: 20,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  pendingText: { fontSize: TEXT.body, lineHeight: 23 },
  pendingMeta: { flexDirection: 'row', gap: 12, paddingHorizontal: 4 },
  empty: { marginTop: 48 },
  emptyText: { fontSize: TEXT.small, textAlign: 'center', marginTop: 48 },
  composer: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 12, gap: 6 },
  error: { fontSize: TEXT.small, textAlign: 'center' },
});
