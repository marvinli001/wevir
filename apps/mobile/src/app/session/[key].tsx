// 一个会话：大标题是会话标题，下面一行是所在电脑与状态；消息流（用户的话是气泡，回答是正文，工具一行），末尾是待批准的审批、
// 等回答的提问（在手机上作答）与还没送达的消息（可取消）。底部是输入栏：发消息、附照片；回合进行中发出的按“插话 / 排队”送达
// （默认取电脑上“回合进行中按回车”的设置），空着时是停止。右上角的菜单：查看改动、改名、归档。打开时停在最新一条。
// 回合进行中消息流末尾是运行状态（components/live-status.tsx），回答逐字放出（components/markdown.tsx）。

import { ClientClosedError } from '@wevir/client-sdk';
import type {
  AccountState,
  ApprovalId,
  PendingDelivery,
  PendingMessageId,
  ProviderProfile,
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
import { type ContinuityContext, HandoffRow, UsageLimitCard } from '../../components/continuity';
import { HeaderMenu } from '../../components/header-button';
import { LiveStatus, ThoughtRow } from '../../components/live-status';
import { Markdown } from '../../components/markdown';
import type { MenuSection } from '../../components/menu';
import { QuestionCard } from '../../components/question-card';
import { RenameDialog } from '../../components/sheets';
import { Button, Icon, type IconName } from '../../components/ui';
import { type MessageKey, t, timeAgo } from '../../i18n';
import { ApprovalUnavailableError } from '../../lib/approval-gate';
import { keyboardOverlap } from '../../lib/keyboard';
import { displayName } from '../../lib/records';
import { ScrollFollow, type ScrollMetrics, showsLatest } from '../../lib/scroll-follow';
import { isBusy, SessionActions, sendErrorKey } from '../../lib/session-actions';
import {
  type NoticeIcon,
  type SessionItem,
  sessionItems,
  type ToolState,
} from '../../lib/session-items';
import { type SessionView, SessionWatch } from '../../lib/session-watch';
import { useMinuteClock } from '../../state/clock';
import { usePhotoAttachments } from '../../state/photo-attachments';
import { useComputer, useRegistry } from '../../state/registry';
import { useToast } from '../../state/toast';
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
  // 读取失败后点“重试”：加一次，重新订阅。
  const [attempt, setAttempt] = useState(0);
  const watch = useRef<SessionWatch | undefined>(undefined);
  const actions = useMemo(
    () =>
      client !== undefined ? new SessionActions(client, sessionId, getRandomBytes) : undefined,
    [client, sessionId],
  );
  const [delivery, setDelivery] = useState<PendingDelivery>('steer');
  const [error, setError] = useState<MessageKey>();
  const [renaming, setRenaming] = useState(false);
  const showToast = useToast();
  const [keyboard, setKeyboard] = useState(0);
  const [composerHeight, setComposerHeight] = useState(64);
  const [catalog, setCatalog] = useState<{
    providers: ProviderProfile[];
    accounts?: AccountState[];
  }>({ providers: [] });

  useEffect(() => {
    let stopped = false;
    setCatalog({ providers: [] });
    if (client?.canReadProviders) {
      void Promise.all([
        client.request('provider.list', {}).then((value) => value.providers),
        client.request('account.list', {}).then((value) => value.accounts),
      ]).then(
        ([providers, accounts]) => {
          if (!stopped) setCatalog({ providers, accounts });
        },
        () => {},
      );
    }
    return () => {
      stopped = true;
    };
  }, [client]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` 变了（点了重试）就重新订阅
  useEffect(() => {
    const current = new SessionWatch(client, sessionId, setView, cache);
    watch.current = current;
    void current.start();
    return () => {
      current.stop();
      if (watch.current === current) watch.current = undefined;
    };
  }, [client, cache, sessionId, attempt]);

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

  // 发来消息、回报的会话的标题，从这台电脑的会话列表里查。
  const listed = snapshot?.sessions.kind === 'ready' ? snapshot.sessions.sessions : undefined;
  const sessionTitles = useMemo(
    () => new Map((listed ?? []).map((entry) => [entry.id, entry.title])),
    [listed],
  );
  const items = useMemo(
    () =>
      view.transcript !== undefined
        ? sessionItems(
            view.transcript,
            {
              image: t('bot.image'),
              tool: toolVerb,
              sessionTitle: (id) => sessionTitles.get(id),
            },
            { live: view.offline !== true },
          )
        : [],
    [view.transcript, view.offline, sessionTitles],
  );
  const session = view.session;
  const state = view.transcript?.state ?? session?.state;
  const busy = isBusy(view.transcript ?? session);
  const readOnly = view.transcript?.readOnly ?? session?.readOnly;
  const canWrite = actions?.canWrite === true && readOnly === undefined;
  const continuity: ContinuityContext = {
    ...catalog,
    autoContinue: {
      ...(view.transcript?.autoContinue && { armed: view.transcript.autoContinue }),
    },
    ...(canWrite &&
      snapshot?.status.kind === 'online' &&
      view.caughtUp &&
      !view.cachedAt &&
      !view.offline &&
      client?.supports('usage_auto_continue') && {
        cancelAutoContinue: (turnId) => actions.cancelAutoContinue(turnId),
      }),
  };
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

  const photos = usePhotoAttachments({ upload, onError: setError });

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
        if (archived) return;
        // 归档后会话从列表里消失、手机上找不回来：退回去，底部给几秒“撤销”。
        router.back();
        showToast({
          text: t('session.archived'),
          action: {
            label: t('session.undo'),
            onPress: () =>
              void actions.archive(false).catch((e: unknown) => {
                console.warn('[wevir] could not unarchive', e);
                Alert.alert(t('session.unarchiveFailed'));
              }),
          },
        });
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

  const workspaceId = session?.workspaceId;
  const menu: MenuSection[] = [
    {
      items: [
        ...(actions?.canWrite === true
          ? [
              {
                label: t('newSession.title'),
                icon: 'square.and.pencil' as const,
                onPress: () =>
                  router.push({
                    pathname: '/new-session',
                    params: {
                      computer,
                      ...(workspaceId !== undefined && { workspace: workspaceId }),
                    },
                  }),
              },
            ]
          : []),
        ...(workspaceId !== undefined
          ? [
              {
                label: t('changes.title'),
                icon: 'plusminus' as const,
                onPress: () =>
                  router.push({
                    pathname: '/changes/[key]',
                    params: { key: `${computer}/${sessionId}` },
                  }),
              },
            ]
          : []),
      ],
    },
    ...(actions?.canWrite === true
      ? [
          {
            items: [
              {
                label: t('session.rename'),
                icon: 'pencil' as const,
                onPress: () => setRenaming(true),
              },
              {
                label: t(archived ? 'session.unarchive' : 'session.archive'),
                icon: archived ? ('tray.and.arrow.up' as const) : ('archivebox' as const),
                destructive: !archived,
                onPress: archive,
              },
            ],
          },
        ]
      : []),
  ].filter((section) => section.items.length > 0);

  const bottom = keyboard > 0 ? 8 : Math.max(insets.bottom, 8);

  return (
    <>
      <Stack.Screen options={{ title }} />
      <HeaderMenu
        sf="ellipsis"
        md="more_vert"
        label={t('session.menu')}
        sections={menu}
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
            clientId={client?.identity.clientId}
            continuity={continuity}
            bottomInset={composerHeight + 16}
            onDecide={async (approvalId, decision) => {
              const current = watch.current;
              if (current === undefined) throw new ApprovalUnavailableError('offline');
              await current.respond(approvalId as ApprovalId, decision);
            }}
            onAnswer={async (questionId, answers) => {
              await actions?.answer(questionId as QuestionId, answers);
            }}
            onRetry={() => {
              link?.retryNow();
              setAttempt((n) => n + 1);
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
              draftKey={key}
              onSend={send}
              disabled={!canWrite}
              placeholder={
                readOnly !== undefined
                  ? t('session.readOnly')
                  : actions !== undefined && !actions.canWrite
                    ? t('error.computerOnly')
                    : undefined
              }
              {...(canWrite && { attachMenu: photos.menu })}
              attachments={photos.attachments}
              onRemoveAttachment={photos.remove}
              busy={busy}
              onStop={canWrite ? async () => actions?.interrupt() : undefined}
              delivery={delivery}
              onDeliveryChange={setDelivery}
              {...(canWrite &&
                client?.supports('speech') === true && {
                  speech: client,
                  sessionId,
                  onDictationError: setError,
                })}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
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

function metrics(e: NativeSyntheticEvent<NativeScrollEvent>): ScrollMetrics {
  const n = e.nativeEvent;
  return {
    contentHeight: n.contentSize.height,
    offset: n.contentOffset.y,
    viewport: n.layoutMeasurement.height,
  };
}

function SessionList({
  items,
  meta,
  loading,
  failed,
  theme,
  canWrite,
  clientId,
  continuity,
  bottomInset,
  onDecide,
  onAnswer,
  onCancelPending,
  onRetry,
}: {
  items: readonly SessionItem[];
  meta: string;
  loading: boolean;
  failed: boolean;
  theme: Theme;
  canWrite: boolean;
  clientId: string | undefined;
  continuity: ContinuityContext;
  bottomInset: number;
  onDecide: (approvalId: string, decision: 'approved' | 'rejected') => Promise<void>;
  onAnswer: (questionId: string, answers: Record<string, QuestionAnswer>) => Promise<void>;
  onCancelPending: (pendingId: string) => void;
  onRetry: () => void;
}) {
  const now = useMinuteClock();
  const list = useRef<FlatList<SessionItem>>(null);
  const headerHeight = useHeaderHeight();
  const [scroll] = useState(() => new ScrollFollow());
  const viewport = useRef(0);
  const contentHeight = useRef(0);
  // 离底部远（翻到了上面）时右下角浮出“最新消息”按钮；期间有新内容时按钮上加一个点。
  const [away, setAway] = useState(false);
  const [fresh, setFresh] = useState(false);
  const lastKey = useRef<string | undefined>(undefined);
  // 运行状态一直在末尾，不算新内容。
  const last = items.findLast((item) => item.kind !== 'live');
  // 刚发出的消息总要看见，即使之前翻到了上面。
  if (last?.key !== lastKey.current) {
    lastKey.current = last?.key;
    if (last?.kind === 'user' || last?.kind === 'pending') scroll.jump();
  }
  useEffect(() => {
    if (last !== undefined && !scroll.following) setFresh(true);
  }, [last, scroll]);
  // 自己算偏移：FlatList 的 scrollToEnd 按单元格估算，不算底部给输入框留的内边距。
  // 列表铺到导航栏下面，内容加导航栏高度超出一屏才滚，否则会把开头推到导航栏下。
  const toEnd = (animated: boolean) => {
    if (contentHeight.current + headerHeight > viewport.current)
      list.current?.scrollToOffset({
        offset: contentHeight.current - viewport.current,
        animated,
      });
  };
  const jump = () => {
    scroll.jump();
    setFresh(false);
    toEnd(true);
  };
  return (
    <View
      style={styles.flex}
      onLayout={(e) => {
        // 键盘弹起时页面变矮：跟着底部时滚回底部，最新的内容不被键盘挡住。
        viewport.current = e.nativeEvent.layout.height;
        if (scroll.sticks) toEnd(false);
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
        onScrollBeginDrag={() => scroll.beginDrag()}
        onScrollEndDrag={(e) => scroll.endDrag(metrics(e), e.nativeEvent.velocity?.y ?? 0)}
        onMomentumScrollEnd={(e) => scroll.momentumEnd(metrics(e))}
        scrollEventThrottle={100}
        onScroll={(e) => {
          const far = showsLatest(metrics(e));
          setAway(far);
          if (!far) setFresh(false);
        }}
        onContentSizeChange={(_, height) => {
          contentHeight.current = height;
          if (scroll.sticks) toEnd(false);
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
            <View style={styles.emptyBox}>
              <Text style={[styles.emptyText, { color: theme.mutedForeground }]}>
                {failed ? t('thread.unavailable') : t('thread.empty')}
              </Text>
              {failed && (
                <Button
                  kind="secondary"
                  title={t('computer.retry')}
                  icon={{ ios: 'arrow.clockwise', android: 'refresh' }}
                  onPress={onRetry}
                />
              )}
            </View>
          )
        }
        renderItem={({ item }) => (
          <View style={styles.item}>
            <Item
              item={item}
              now={now}
              theme={theme}
              canWrite={canWrite}
              clientId={clientId}
              continuity={continuity}
              onDecide={onDecide}
              onAnswer={onAnswer}
              onCancelPending={onCancelPending}
            />
          </View>
        )}
      />
      {away && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('session.latest')}
          onPress={jump}
          hitSlop={8}
          style={({ pressed }) => [
            styles.latest,
            {
              bottom: bottomInset + 4,
              backgroundColor: theme.card,
              borderColor: theme.border,
              opacity: pressed ? 0.7 : 1,
            },
          ]}
          testID="session-latest"
        >
          <Icon
            name={{ ios: 'arrow.down', android: 'arrow_downward' }}
            size={17}
            weight="semibold"
            color={theme.foreground}
          />
          {fresh && <View style={[styles.latestDot, { backgroundColor: theme.running }]} />}
        </Pressable>
      )}
    </View>
  );
}

function Item({
  item,
  now,
  theme,
  canWrite,
  clientId,
  continuity,
  onDecide,
  onAnswer,
  onCancelPending,
}: {
  item: SessionItem;
  now: Date;
  theme: Theme;
  canWrite: boolean;
  clientId: string | undefined;
  continuity: ContinuityContext;
  onDecide: (approvalId: string, decision: 'approved' | 'rejected') => Promise<void>;
  onAnswer: (questionId: string, answers: Record<string, QuestionAnswer>) => Promise<void>;
  onCancelPending: (pendingId: string) => void;
}) {
  switch (item.kind) {
    case 'handoff':
      return <HandoffRow notice={item.notice} context={continuity} theme={theme} />;
    case 'usage-limit':
      return <UsageLimitCard part={item.part} context={continuity} theme={theme} />;
    case 'assistant':
      return (
        <View style={styles.reply}>
          <Markdown text={item.text} streaming={item.streaming === true} />
        </View>
      );
    case 'thought':
      return <ThoughtRow item={item} theme={theme} />;
    case 'live':
      return <LiveStatus item={item} theme={theme} />;
    case 'user':
      return (
        <PostView
          post={{
            id: item.key,
            author: 'user',
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
          clientId={clientId}
          now={now}
          onDecide={(_, decision) => onDecide(item.approvalId, decision)}
          onOpenThread={() => {}}
          onRetry={() => {}}
        />
      );
    case 'tool':
      return (
        <View style={styles.tool}>
          <Icon name={toolIcon(item.state)} size={14} color={toolColor(theme, item.state)} />
          <Text
            style={[styles.toolText, { color: theme.mutedForeground }]}
            numberOfLines={1}
            ellipsizeMode="middle"
          >
            {item.label}
          </Text>
          <Text style={[styles.toolState, { color: toolColor(theme, item.state) }]}>
            {t(`tool.state.${item.state}`)}
          </Text>
        </View>
      );
    case 'error':
      return (
        <Text style={[styles.note, { color: theme.destructive }]} selectable>
          {item.text}
        </Text>
      );
    case 'relayed':
      return <RelayedCard item={item} theme={theme} />;
    case 'notice':
      return <NoticeChip item={item} theme={theme} />;
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
          {item.notice !== undefined ? (
            <View
              style={[
                styles.chip,
                { borderColor: theme.borderStrong, backgroundColor: theme.background },
              ]}
            >
              <Icon name={NOTICE_ICONS[item.notice.icon]} size={15} color={theme.mutedForeground} />
              <Text style={[styles.chipText, { color: theme.softForeground }]} numberOfLines={1}>
                {item.notice.label}
              </Text>
            </View>
          ) : (
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
          )}
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

const NOTICE_ICONS: Record<NoticeIcon, IconName> = {
  process: { ios: 'apple.terminal', android: 'terminal' },
  repair: { ios: 'wrench.and.screwdriver', android: 'build' },
  opinion: { ios: 'bubble.left.and.bubble.right', android: 'forum' },
  report: { ios: 'arrowshape.turn.up.left', android: 'reply' },
  message: { ios: 'bubble.left.and.bubble.right', android: 'forum' },
};

/** 别的会话发来的消息或回报（同桌面端）：标题一行可收起，下面是发来的会话与正文。 */
function RelayedCard({
  item,
  theme,
}: {
  item: Extract<SessionItem, { kind: 'relayed' }>;
  theme: Theme;
}) {
  const [open, setOpen] = useState(true);
  return (
    <View
      style={[styles.relayed, { borderColor: theme.border, backgroundColor: theme.card }]}
      testID="relayed-message"
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={styles.relayedHeader}
      >
        <Icon name={NOTICE_ICONS[item.icon]} size={15} color={theme.mutedForeground} />
        <Text style={[styles.chipText, { color: theme.softForeground }]} numberOfLines={1}>
          {item.label}
        </Text>
        <Icon
          name={
            open
              ? { ios: 'chevron.down', android: 'expand_more' }
              : { ios: 'chevron.right', android: 'chevron_right' }
          }
          size={12}
          color={theme.mutedForeground}
        />
      </Pressable>
      {open && (
        <View style={styles.relayedBody}>
          {item.source !== undefined && (
            <Text
              style={[styles.relayedSource, { color: theme.mutedForeground }]}
              numberOfLines={1}
            >
              {t('transcript.relayed.from')} {item.source}
            </Text>
          )}
          {item.text.trim() !== '' && <Markdown text={item.text} />}
        </View>
      )}
    </View>
  );
}

/** Host 交给模型的通知（后台进程、自动修复、第二意见）：一行标记，点开看交给模型的全文。 */
function NoticeChip({
  item,
  theme,
}: {
  item: Extract<SessionItem, { kind: 'notice' }>;
  theme: Theme;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View style={styles.notice} testID="notice-message">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={({ pressed }) => [
          styles.chip,
          { borderColor: theme.border, backgroundColor: theme.card, opacity: pressed ? 0.7 : 1 },
        ]}
      >
        <Icon name={NOTICE_ICONS[item.icon]} size={15} color={theme.mutedForeground} />
        <Text style={[styles.chipText, { color: theme.softForeground }]} numberOfLines={1}>
          {item.label}
        </Text>
      </Pressable>
      {open && item.text !== '' && (
        <Text style={[styles.noticeText, { color: theme.mutedForeground }]} selectable>
          {item.text}
        </Text>
      )}
    </View>
  );
}

function toolIcon(state: ToolState) {
  switch (state) {
    case 'awaiting':
      return { ios: 'hand.raised', android: 'front_hand' } as const;
    case 'skipped':
      return { ios: 'minus.circle', android: 'do_not_disturb_on' } as const;
    case 'unknown':
      return { ios: 'questionmark.circle', android: 'help_outline' } as const;
    case 'running':
      return { ios: 'ellipsis.circle', android: 'more_horiz' } as const;
    case 'failed':
      return { ios: 'xmark.circle', android: 'cancel' } as const;
    case 'done':
      return { ios: 'checkmark.circle', android: 'check_circle' } as const;
  }
}

function toolColor(theme: Theme, state: ToolState): string {
  if (state === 'failed') return theme.destructive;
  if (state === 'awaiting' || state === 'unknown') return theme.warning;
  return theme.mutedForeground;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingHorizontal: SPACE.page },
  meta: { fontSize: TEXT.caption, paddingHorizontal: 4, paddingBottom: 8 },
  item: { marginTop: 12 },
  reply: { paddingRight: 24 },
  tool: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  toolText: { flex: 1, fontSize: TEXT.small },
  toolState: { fontSize: TEXT.caption },
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
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: '100%',
    minHeight: 30,
    borderRadius: 15,
    borderWidth: StyleSheet.hairlineWidth,
    paddingLeft: 9,
    paddingRight: 12,
  },
  chipText: { flexShrink: 1, fontSize: TEXT.small },
  notice: { alignItems: 'flex-start', gap: 6 },
  noticeText: { fontSize: TEXT.caption, lineHeight: 18, paddingHorizontal: 4 },
  relayed: {
    maxWidth: '92%',
    borderRadius: 16,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
  },
  relayedHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 36,
    paddingHorizontal: 12,
  },
  relayedBody: { paddingHorizontal: 12, paddingBottom: 10, gap: 4 },
  relayedSource: { fontSize: TEXT.caption },
  empty: { marginTop: 48 },
  emptyBox: { alignItems: 'center', gap: 14, marginTop: 48 },
  emptyText: { fontSize: TEXT.small, textAlign: 'center' },
  latest: {
    position: 'absolute',
    alignSelf: 'center',
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 2px 10px rgba(26, 26, 23, 0.12)',
  },
  latestDot: { position: 'absolute', top: 6, right: 6, width: 8, height: 8, borderRadius: 4 },
  composer: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 12, gap: 6 },
  error: { fontSize: TEXT.small, textAlign: 'center' },
});
