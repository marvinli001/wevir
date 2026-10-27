// 一个会话：大标题是会话标题，下面一行是所在电脑与状态；消息流（用户的话是气泡，回答是正文，工具一行），末尾是待批准的审批、
// 等回答的提问（在手机上作答）与还没送达的消息（可取消）。底部是输入栏：发消息、附照片；回合进行中发出的按“插话 / 排队”送达
// （默认取电脑上“回合进行中按回车”的设置），空着时是停止。右上角的菜单：查看改动、改名、归档。打开时停在最新一条。

import type {
  ApprovalId,
  PendingDelivery,
  PendingMessageId,
  QuestionAnswer,
  QuestionId,
  SessionId,
  ToolDisplayKind,
  UserImagePart,
} from '@wevir/protocol';
import { SESSION_TITLE_MAX_LENGTH } from '@wevir/protocol';
import { getRandomBytes } from 'expo-crypto';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PostView } from '../../components/bot-cards';
import { Composer, type ComposerAttachment } from '../../components/composer';
import { HeaderButton } from '../../components/header-button';
import { QuestionCard } from '../../components/question-card';
import { RenameDialog, useActionSheet } from '../../components/sheets';
import { Icon } from '../../components/ui';
import { type MessageKey, t, timeAgo } from '../../i18n';
import {
  PHOTOS_PER_MESSAGE,
  PhotoPermissionError,
  type PhotoSource,
  pickPhotos,
} from '../../lib/photos';
import { displayName } from '../../lib/records';
import { isBusy, SessionActions, sendErrorKey } from '../../lib/session-actions';
import { type SessionItem, sessionItems, type ToolState } from '../../lib/session-items';
import { type SessionView, SessionWatch } from '../../lib/session-watch';
import { useMinuteClock } from '../../state/clock';
import { useComputer, useRegistry } from '../../state/registry';
import { SPACE, TEXT, type Theme, useTheme } from '../../theme';

interface Attachment extends ComposerAttachment {
  image?: UserImagePart;
}

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
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [error, setError] = useState<MessageKey>();
  const [renaming, setRenaming] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
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
      () => setKeyboard(true),
    );
    const hide = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setKeyboard(false),
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

  const send = useCallback(
    async (text: string) => {
      if (actions === undefined) throw new Error('offline');
      setError(undefined);
      const images = attachments.flatMap((a) => (a.image !== undefined ? [a.image] : []));
      try {
        await actions.send({ text, images, ...(busy && { delivery }) });
        setAttachments([]);
      } catch (e) {
        setError(sendErrorKey(e));
        throw e;
      }
    },
    [actions, attachments, busy, delivery],
  );

  const attach = async (source: PhotoSource) => {
    if (actions === undefined) return;
    setError(undefined);
    let photos: Awaited<ReturnType<typeof pickPhotos>>;
    try {
      photos = await pickPhotos(source, PHOTOS_PER_MESSAGE - attachments.length);
    } catch (e) {
      setError(e instanceof PhotoPermissionError ? 'photo.cameraDenied' : 'photo.failed');
      return;
    }
    for (const photo of photos) {
      const key = `${photo.uri}:${Date.now()}`;
      setAttachments((current) => [...current, { key, uri: photo.uri, uploading: true }]);
      actions.uploadImage(photo.mimeType, photo.data).then(
        (image) =>
          setAttachments((current) =>
            current.map((a) => (a.key === key ? { ...a, uploading: false, image } : a)),
          ),
        (e: unknown) => {
          console.warn('[wevir] image upload failed', e);
          setError(
            sendErrorKey(e) === 'error.computerOnly' ? 'error.computerOnly' : 'photo.failed',
          );
          setAttachments((current) => current.filter((a) => a.key !== key));
        },
      );
    }
  };

  const chooseSource = () =>
    showSheet([
      { label: t('photo.library'), onPress: () => void attach('library') },
      { label: t('photo.camera'), onPress: () => void attach('camera') },
    ]);

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

  const bottom = keyboard ? 8 : Math.max(insets.bottom, 8);

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
        <View style={styles.flex}>
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
              onAttach={canWrite ? chooseSource : undefined}
              attachments={attachments}
              onRemoveAttachment={(key) =>
                setAttachments((current) => current.filter((a) => a.key !== key))
              }
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
  const pinned = useRef(true);
  const height = useRef(0);
  return (
    <FlatList
      ref={list}
      data={items}
      keyExtractor={(item) => item.key}
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]}
      initialNumToRender={60}
      onScroll={(e) => {
        const n = e.nativeEvent;
        // 不满一屏也算停在末尾（大标题的内边距让偏移是负的）。
        pinned.current =
          n.contentSize.height <= n.layoutMeasurement.height ||
          n.contentSize.height - n.contentOffset.y - n.layoutMeasurement.height < 120;
      }}
      scrollEventThrottle={100}
      onLayout={(e) => {
        height.current = e.nativeEvent.layout.height;
      }}
      // 内容不满一屏时不滚：scrollToEnd 不算大标题占的顶部内边距，会把开头推到导航栏下面。
      onContentSizeChange={(_, contentHeight) => {
        if (pinned.current && contentHeight > height.current)
          list.current?.scrollToEnd({ animated: false });
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
