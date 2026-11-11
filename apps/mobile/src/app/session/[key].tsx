// 一个会话：大标题是会话标题，下面一行是所在电脑与状态；消息流（用户的话是气泡，回答是正文，工具一行），末尾是待批准的审批、
// 等回答的提问（在手机上作答）与还没送达的消息（可取消）。底部是输入栏：发消息、附照片；回合进行中发出的按“插话 / 排队”送达
// （默认取电脑上“回合进行中按回车”的设置），空着时是停止。右上角的菜单：查看改动、改名、归档。打开时停在最新一条。
// 回合进行中消息流末尾是运行状态（components/live-status.tsx），回答逐字放出（components/markdown.tsx）。结束的回合同桌面端
// 收进一行“已处理 2 分 31 秒”（lib/session-items.ts），点它展开过程。

import { ClientClosedError, WevirRpcError } from '@wevir/client-sdk';
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
  TurnOutcome,
} from '@wevir/protocol';
import { SESSION_TITLE_MAX_LENGTH } from '@wevir/protocol';
import { getRandomBytes } from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  LayoutAnimation,
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
import { type LoadImage, PostImages } from '../../components/post-images';
import { QuestionCard } from '../../components/question-card';
import { RenameDialog } from '../../components/sheets';
import { ToolDetailView } from '../../components/tool-detail-view';
import {
  AnswersRow,
  DividerRow,
  FilesCard,
  FindingsCard,
  LineRow,
  type OpenSession,
  OpinionCard,
  TasksCard,
  TodoCard,
} from '../../components/transcript-parts';
import { Button, Icon, type IconName } from '../../components/ui';
import { formatDuration, type MessageKey, t, timeAgo } from '../../i18n';
import { ApprovalUnavailableError } from '../../lib/approval-gate';
import { cachedImage } from '../../lib/image-cache';
import { readImage } from '../../lib/image-read';
import { keyboardOverlap } from '../../lib/keyboard';
import { displayName } from '../../lib/records';
import { ScrollFollow, type ScrollMetrics, showsLatest } from '../../lib/scroll-follow';
import { isBusy, SessionActions, sendErrorKey } from '../../lib/session-actions';
import {
  type NoticeIcon,
  type SessionItem,
  sessionItems,
  type ToolState,
  visibleItems,
} from '../../lib/session-items';
import { type SessionView, SessionWatch } from '../../lib/session-watch';
import { useMinuteClock } from '../../state/clock';
import { usePhotoAttachments } from '../../state/photo-attachments';
import { useReducedMotion } from '../../state/reduced-motion';
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
            {
              // 缓存里的回合在电脑上可能早已结束：回放完之前不画运行状态。
              live: view.offline !== true && view.cachedAt === undefined,
              ...(view.session !== undefined && {
                approvalContext: {
                  cwd: view.session.cwd,
                  ...(view.projectName !== undefined && { projectName: view.projectName }),
                },
              }),
            },
          )
        : [],
    [view.transcript, view.offline, view.cachedAt, view.session, view.projectName, sessionTitles],
  );
  const session = view.session;
  // 回合状态：回放完之后看消息流；之前显示的是缓存，按这次连上后取的快照算，还没取到时不算（不把过时的“运行中”当真）。
  const live =
    view.cachedAt === undefined
      ? (view.transcript ?? session)
      : view.liveSession === true
        ? session
        : undefined;
  const state = live?.state;
  const busy = isBusy(live);
  // 审批挂起时发消息即拒绝并改道（同桌面），Host 要有 `approval_messages`。
  const redirect =
    view.cachedAt === undefined &&
    (view.transcript?.pendingApprovals.length ?? 0) > 0 &&
    client?.supports('approval_messages') === true;
  // 读取后来出错（会话被删、没有权限）：已有内容也提示。连接断了不算，那由连接状态管。
  const watchFailed = view.error instanceof WevirRpcError;
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
  const loadImage = useMemo<LoadImage | undefined>(
    () =>
      client === undefined
        ? undefined
        : (image) =>
            cachedImage(computer, image, (write) => readImage(client, image.imageId, write)),
    [client, computer],
  );
  // 子智能体、任务与第二意见的会话在同一台电脑上。
  const openSession = useCallback(
    (id: string) =>
      router.push({ pathname: '/session/[key]', params: { key: `${computer}/${id}` } }),
    [router, computer],
  );

  const send = useCallback(
    async (text: string) => {
      if (actions === undefined) throw new Error('offline');
      setError(undefined);
      try {
        await actions.send({
          text,
          images: photos.images,
          ...(busy && { delivery }),
          ...((state === 'error' || state === 'closed') && { resume: true }),
          ...(redirect && { declineApproval: true }),
        });
        photos.clear();
      } catch (e) {
        setError(sendErrorKey(e));
        throw e;
      }
    },
    [actions, photos, busy, delivery, state, redirect],
  );

  const archive = () => {
    if (actions === undefined) return;
    actions.archive(!archived).then(
      () => {
        if (archived) {
          // 取消归档不走事件流：重新取快照，标题下与菜单里的“已归档”跟着变。
          void watch.current?.refreshSession().catch(() => {});
          return;
        }
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
            stale={watchFailed && items.length > 0}
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
            onLoadImage={loadImage}
            onOpenSession={openSession}
            onResumePending={() => {
              actions?.resumePending().catch((e: unknown) => setError(sendErrorKey(e)));
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
  stale,
  theme,
  canWrite,
  clientId,
  continuity,
  bottomInset,
  onDecide,
  onAnswer,
  onCancelPending,
  onResumePending,
  onLoadImage,
  onOpenSession,
  onRetry,
}: {
  items: readonly SessionItem[];
  meta: string;
  loading: boolean;
  failed: boolean;
  /** 已有内容，但之后的读取出错：内容可能不是最新的。 */
  stale: boolean;
  theme: Theme;
  canWrite: boolean;
  clientId: string | undefined;
  continuity: ContinuityContext;
  bottomInset: number;
  onDecide: (approvalId: string, decision: 'approved' | 'rejected') => Promise<void>;
  onAnswer: (questionId: string, answers: Record<string, QuestionAnswer>) => Promise<void>;
  onCancelPending: (pendingId: string) => void;
  onResumePending: () => void;
  onLoadImage: LoadImage | undefined;
  onOpenSession: OpenSession;
  onRetry: () => void;
}) {
  const now = useMinuteClock();
  const list = useRef<FlatList<SessionItem>>(null);
  const headerHeight = useHeaderHeight();
  const [scroll] = useState(() => new ScrollFollow());
  const reduced = useReducedMotion();
  // 点过的回合那一行：展开或收起，没点过的照默认（session-items.ts 的 `defaultOpen`）。
  const [open, setOpen] = useState<ReadonlyMap<string, boolean>>(new Map());
  const shown = useMemo(() => visibleItems(items, open), [items, open]);
  const toggle = useCallback(
    (item: Extract<SessionItem, { kind: 'turn' }>) => {
      void Haptics.selectionAsync().catch(() => {});
      if (!reduced) LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      // 展开时不跟着底部滚：留在点的那一行。
      scroll.release();
      setOpen((current) =>
        new Map(current).set(item.key, !(current.get(item.key) ?? item.defaultOpen)),
      );
    },
    [reduced, scroll],
  );
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
        data={shown}
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
          <>
            <Text style={[styles.meta, { color: theme.mutedForeground }]} numberOfLines={1}>
              {meta}
            </Text>
            {stale && (
              <Pressable
                accessibilityRole="button"
                onPress={onRetry}
                hitSlop={8}
                style={styles.staleRow}
                testID="session-stale"
              >
                <Icon
                  name={{ ios: 'exclamationmark.triangle', android: 'warning' }}
                  size={15}
                  color={theme.destructive}
                />
                <Text style={[styles.note, { color: theme.destructive }]}>
                  {t('thread.unavailable')}
                </Text>
                <Text style={[styles.note, styles.cancel, { color: theme.foreground }]}>
                  {t('computer.retry')}
                </Text>
              </Pressable>
            )}
          </>
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
        renderItem={({ item, index }) => (
          <View style={dense(item, shown[index - 1]) ? styles.step : styles.item}>
            <Item
              item={item}
              open={item.kind === 'turn' && (open.get(item.key) ?? item.defaultOpen)}
              onToggle={toggle}
              now={now}
              theme={theme}
              canWrite={canWrite}
              clientId={clientId}
              continuity={continuity}
              onDecide={onDecide}
              onAnswer={onAnswer}
              onCancelPending={onCancelPending}
              onResumePending={onResumePending}
              onLoadImage={onLoadImage}
              onOpenSession={onOpenSession}
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

/** 过程里相邻的思考与工具挨着放（同桌面端的工作组），别的行之间照常隔开。 */
function dense(item: SessionItem, previous: SessionItem | undefined): boolean {
  const step = (entry: SessionItem | undefined) =>
    entry?.kind === 'tool' ||
    entry?.kind === 'thought' ||
    (entry?.kind === 'line' && entry.center !== true);
  return step(item) && step(previous);
}

function Item({
  item,
  open,
  onToggle,
  now,
  theme,
  canWrite,
  clientId,
  continuity,
  onDecide,
  onAnswer,
  onCancelPending,
  onResumePending,
  onLoadImage,
  onOpenSession,
}: {
  item: SessionItem;
  open: boolean;
  onToggle: (item: Extract<SessionItem, { kind: 'turn' }>) => void;
  now: Date;
  theme: Theme;
  canWrite: boolean;
  clientId: string | undefined;
  continuity: ContinuityContext;
  onDecide: (approvalId: string, decision: 'approved' | 'rejected') => Promise<void>;
  onAnswer: (questionId: string, answers: Record<string, QuestionAnswer>) => Promise<void>;
  onCancelPending: (pendingId: string) => void;
  onResumePending: () => void;
  /** 没连着时没有：照片不画。 */
  onLoadImage: LoadImage | undefined;
  onOpenSession: OpenSession;
}) {
  switch (item.kind) {
    case 'turn':
      return <TurnRow item={item} open={open} onToggle={onToggle} theme={theme} />;
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
        <View style={styles.userItem}>
          {item.images !== undefined && onLoadImage !== undefined && (
            <PostImages images={item.images} align="end" load={onLoadImage} />
          )}
          {item.text !== '' && (
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
          )}
        </View>
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
      return item.images !== undefined && onLoadImage !== undefined ? (
        <View style={styles.userItem}>
          <ToolRow item={item} theme={theme} />
          <PostImages images={item.images} align="start" load={onLoadImage} />
        </View>
      ) : (
        <ToolRow item={item} theme={theme} />
      );
    case 'line':
      return <LineRow item={item} theme={theme} onOpenSession={onOpenSession} />;
    case 'divider':
      return <DividerRow item={item} theme={theme} />;
    case 'todo':
      return <TodoCard item={item} theme={theme} />;
    case 'answers':
      return <AnswersRow item={item} theme={theme} />;
    case 'files':
      return <FilesCard item={item} theme={theme} />;
    case 'tasks':
      return <TasksCard item={item} theme={theme} onOpenSession={onOpenSession} />;
    case 'opinion':
      return <OpinionCard item={item} theme={theme} onOpenSession={onOpenSession} />;
    case 'findings':
      return <FindingsCard item={item} theme={theme} />;
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
              {t(item.held ? 'composer.pending.held' : `composer.pending.${item.delivery}`)}
            </Text>
            {canWrite && item.held && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('composer.resumePending')}
                hitSlop={8}
                onPress={onResumePending}
              >
                <Text style={[styles.note, styles.cancel, { color: theme.foreground }]}>
                  {t('composer.resumePending')}
                </Text>
              </Pressable>
            )}
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

const TURN_TONES: Partial<Record<TurnOutcome, keyof Theme>> = {
  failed: 'destructive',
  interrupted: 'warning',
};

/** 结束的回合那一行（同桌面端）：“已处理 2 分 31 秒”与箭头，下面一条细线；点它展开或收起过程。 */
function TurnRow({
  item,
  open,
  onToggle,
  theme,
}: {
  item: Extract<SessionItem, { kind: 'turn' }>;
  open: boolean;
  onToggle: (item: Extract<SessionItem, { kind: 'turn' }>) => void;
  theme: Theme;
}) {
  const tone = TURN_TONES[item.outcome];
  const color = tone !== undefined ? (theme[tone] as string) : theme.mutedForeground;
  return (
    <View testID="session-turn">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => onToggle(item)}
        hitSlop={8}
        style={({ pressed }) => [styles.turn, { opacity: pressed ? 0.6 : 1 }]}
      >
        <Text style={[styles.turnText, { color }]} numberOfLines={1}>
          {t(`turn.header.${item.outcome}`, { duration: formatDuration(item.durationMs) })}
        </Text>
        <Icon
          name={
            open
              ? { ios: 'chevron.down', android: 'expand_more' }
              : { ios: 'chevron.right', android: 'chevron_right' }
          }
          size={11}
          weight="semibold"
          color={theme.mutedForeground}
        />
      </Pressable>
      <View style={[styles.turnRule, { backgroundColor: theme.border }]} />
    </View>
  );
}

const KIND_ICONS: Record<ToolDisplayKind, IconName> = {
  shell: { ios: 'apple.terminal', android: 'terminal' },
  read: { ios: 'doc.text', android: 'description' },
  edit: { ios: 'pencil', android: 'edit' },
  write: { ios: 'square.and.pencil', android: 'edit_note' },
  search: { ios: 'magnifyingglass', android: 'search' },
  fetch: { ios: 'globe', android: 'public' },
  plan: { ios: 'checklist', android: 'checklist' },
  sub_agent: { ios: 'person.2', android: 'group' },
  image: { ios: 'photo', android: 'image' },
  unknown: { ios: 'wrench.and.screwdriver', android: 'build' },
};

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

/**
 * 工具一行（同桌面端工作组里的逐条）：种类图标、动词与对象，命令用等宽字。做完的不写状态，失败、未执行、待批准与状态未知
 * 换成状态图标并在行尾写出；失败的下面一行是结果的第一行。点它展开参数与结果，修改与写文件是改动预览。
 */
function ToolRow({ item, theme }: { item: Extract<SessionItem, { kind: 'tool' }>; theme: Theme }) {
  const [open, setOpen] = useState(false);
  const color = toolColor(theme, item.state);
  const settled = item.state === 'done' || item.state === 'running';
  return (
    <View testID="session-tool">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => {
          void Haptics.selectionAsync().catch(() => {});
          setOpen(!open);
        }}
        hitSlop={6}
        style={({ pressed }) => [styles.tool, { opacity: pressed ? 0.6 : 1 }]}
      >
        <Icon
          name={settled ? KIND_ICONS[item.toolKind] : stateIcon(item.state)}
          size={14}
          color={color}
        />
        <Text style={styles.toolText} numberOfLines={1} ellipsizeMode="middle">
          <Text style={{ color: theme.softForeground }}>{item.verb}</Text>
          {item.target !== undefined && (
            <Text
              style={[
                { color: theme.mutedForeground },
                item.toolKind === 'shell' && styles.toolCommand,
              ]}
            >
              {` ${item.target}`}
            </Text>
          )}
        </Text>
        {!settled && (
          <Text style={[styles.toolState, { color }]}>{t(`tool.state.${item.state}`)}</Text>
        )}
        <Icon
          name={
            open
              ? { ios: 'chevron.down', android: 'expand_more' }
              : { ios: 'chevron.right', android: 'chevron_right' }
          }
          size={11}
          weight="semibold"
          color={theme.mutedForeground}
        />
      </Pressable>
      {item.failure !== undefined && !open && (
        <Text
          style={[styles.toolFailure, { color: theme.destructive }]}
          numberOfLines={2}
          testID="tool-failure"
        >
          {item.failure}
        </Text>
      )}
      {open && <ToolDetailView part={item.part} theme={theme} />}
    </View>
  );
}

function stateIcon(state: ToolState): IconName {
  switch (state) {
    case 'awaiting':
      return { ios: 'hand.raised', android: 'front_hand' };
    case 'skipped':
      return { ios: 'minus.circle', android: 'do_not_disturb_on' };
    case 'failed':
      return { ios: 'xmark.circle', android: 'cancel' };
    default:
      return { ios: 'questionmark.circle', android: 'help_outline' };
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
  step: { marginTop: 8 },
  turn: { flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 24, paddingHorizontal: 4 },
  turnText: { flexShrink: 1, fontSize: TEXT.small, fontVariant: ['tabular-nums'] },
  turnRule: { height: StyleSheet.hairlineWidth, marginTop: 6, marginHorizontal: 4 },
  reply: { paddingRight: 24 },
  tool: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4 },
  toolText: { flex: 1, fontSize: TEXT.small },
  toolCommand: { fontFamily: MONO, fontSize: TEXT.caption },
  toolState: { fontSize: TEXT.caption },
  toolFailure: {
    fontSize: TEXT.caption,
    lineHeight: 17,
    marginTop: 2,
    paddingLeft: 26,
    paddingRight: 4,
  },
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
  userItem: { gap: 6 },
  staleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6 },
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
