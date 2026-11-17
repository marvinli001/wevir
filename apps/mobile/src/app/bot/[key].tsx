// 一个助理的对话：大标题是助理的名字，列表顶上是它的头像、职责、所在电脑与状态；往下是它自己的时间线（打开时停在最新一条），
// 往上翻到顶再下拉加载更早的。底部是输入栏，键盘弹起时跟着上移。工作中时末尾有一枚在跳的头像。
// 助理群（0.133.0）用同一页：顶上是叠放的成员头像与成员名，输入栏上面一排成员可点选（选中的就是这条 @ 的人）；右上角改群名与成员，
// 没有重试。
// 输入栏（0.135.0，Host 有 `channel_composer` 时）同会话页：前面一枚加照片的按钮，协调者（群里是成员）在回、输入栏空着时尾部是停止。
// Host 有 `speech` 时能听写。帖子里的图片按需读进缓存（lib/image-cache.ts）。

import { ClientClosedError, ConnectionLostError } from '@wevir/client-sdk';
import type { ChannelPost, UserImagePart } from '@wevir/protocol';
import * as Clipboard from 'expo-clipboard';
import { Stack, useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActionSheetIOS,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  type NativeScrollEvent,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BotAvatar } from '../../components/bot-avatar';
import { ChatPost, PostView, TypingBubble } from '../../components/bot-cards';
import { botPose, botStateColor, GroupAvatar } from '../../components/bot-row';
import { Composer } from '../../components/composer';
import { HeaderButton } from '../../components/header-button';
import { useActionSheet } from '../../components/sheets';
import { Icon } from '../../components/ui';
import { joinNames, locale, type MessageKey, t } from '../../i18n';
import {
  BOT_REACTIONS,
  type Bot,
  type BotPost,
  type BotTimelineRow,
  botPostQuote,
  botTimeLabel,
  botTimelineRows,
  type Decision,
  showsBotQuote,
  timelineViews,
} from '../../lib/bots';
import { cachedImage } from '../../lib/image-cache';
import { keyboardOverlap } from '../../lib/keyboard';
import { sendErrorKey } from '../../lib/session-actions';
import { useBot, useBotAccess, useBotProjects, useBotStore, useTimeline } from '../../state/bots';
import { useMinuteClock } from '../../state/clock';
import { acknowledgeDraft, loadDraft } from '../../state/drafts';
import { usePhotoAttachments } from '../../state/photo-attachments';
import { useReducedMotion } from '../../state/reduced-motion';
import { useComputer } from '../../state/registry';
import { SPACE, TEXT, useTheme } from '../../theme';

/** 隔了这么久的两条之间插一行时间。 */
const GAP_MS = 30 * 60_000;

/** 展开的大标题与导航栏在安全区下面占的高度（约值）。 */
const LARGE_TITLE = 100;

export default function BotScreen() {
  const { key, seq } = useLocalSearchParams<{ key: string; seq?: string }>();
  const bot = useBot(key);
  if (bot === undefined) return null;
  return (
    <BotChat
      bot={bot}
      targetSeq={seq !== undefined && /^[1-9]\d*$/.test(seq) ? Number(seq) : undefined}
    />
  );
}

type Item =
  | { kind: 'time'; key: string; at: string }
  | ({ kind: 'post'; key: string } & BotTimelineRow);

function items(posts: readonly BotPost[]): Item[] {
  const out: Item[] = [];
  let previous = 0;
  for (const post of posts) {
    const at = Date.parse(post.createdAt);
    if (at - previous >= GAP_MS)
      out.push({ kind: 'time', key: `t:${post.id}`, at: post.createdAt });
    previous = at;
    out.push({ kind: 'post', key: post.id, post, first: true, last: true, separator: false });
  }
  return out;
}

/** 今天的只写时刻，更早的带日期。 */
function clock(iso: string, now: Date): string {
  const date = new Date(iso);
  const sameDay = date.toDateString() === now.toDateString();
  return date.toLocaleString(
    locale(),
    sameDay
      ? { hour: '2-digit', minute: '2-digit' }
      : { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
  );
}

/** 用原生 ScrollView 的滚到底：它按真实的内容高度与内边距算，FlatList 记的尺寸可能还没更新。 */
function scrollToEnd(list: FlatList<Item> | null, animated: boolean) {
  const scroll = list?.getScrollResponder() as
    | { scrollToEnd: (options: { animated: boolean }) => void }
    | undefined;
  scroll?.scrollToEnd({ animated });
}

function BotChat({ bot, targetSeq }: { bot: Bot; targetSeq: number | undefined }) {
  const computer = useComputer(bot.computer);
  const theme = useTheme();
  const router = useRouter();
  const navigation = useNavigation();
  const store = useBotStore();
  const timeline = useTimeline(bot.key);
  const draftKey = `${computer?.record.routeId ?? 'unassigned'}/bot:${bot.id}`;
  useEffect(() => {
    void loadDraft(draftKey)
      .then((draft) => {
        if (
          draft.clientMessageId &&
          timeline.posts.some((post) => post.clientPostId === draft.clientMessageId)
        )
          return acknowledgeDraft(draftKey, draft.clientMessageId);
      })
      .catch((reason: unknown) => console.warn('[wevir] draft reconciliation', reason));
  }, [draftKey, timeline.posts]);
  const now = useMinuteClock();
  const reducedMotion = useReducedMotion();
  const [focused, setFocused] = useState(false);
  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );
  const [reply, setReply] = useState<ChannelPost>();
  const [scrollTarget, setScrollTarget] = useState<string>();
  const [highlighted, setHighlighted] = useState<string>();
  const [actionSheet, showActions] = useActionSheet();
  const locatedSeq = useRef<number | undefined>(undefined);
  const scrollRetry = useRef<ReturnType<typeof setTimeout>>(undefined);
  const insets = useSafeAreaInsets();
  const list = useRef<FlatList<Item>>(null);
  const [composerHeight, setComposerHeight] = useState(64);
  const [keyboard, setKeyboard] = useState(0);
  // 停在底部时新内容到了跟着滚到底；用户往上翻开就不跟了，回到底部再跟。
  const pinned = useRef(true);
  const settled = useRef(false);
  const dragging = useRef(false);
  const viewport = useRef(0);
  const content = useRef(0);
  const top = insets.top;
  // 一屏放得下时不滚：滚到底会越过大标题，把头像那块推到导航栏下面。
  const follow = useCallback(
    (animated: boolean) => {
      if (content.current + top + LARGE_TITLE < viewport.current) return;
      scrollToEnd(list.current, animated);
    },
    [top],
  );

  useEffect(() => {
    store
      .open(bot.key)
      .catch((error: unknown) => console.warn('[wevir] could not open bot', error));
  }, [store, bot.key]);

  // 停在对话里时新来的消息算已读。
  const lastSeq = timeline.posts.at(-1)?.seq;
  useEffect(() => {
    if (focused && lastSeq !== undefined) void store.markRead(bot.key).catch(() => {});
  }, [store, bot.key, lastSeq, focused]);

  useEffect(() => {
    const show = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      (e) => {
        setKeyboard(keyboardOverlap(e));
        requestAnimationFrame(() => follow(true));
      },
    );
    const hide = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => setKeyboard(0),
    );
    return () => {
      show.remove();
      hide.remove();
    };
  }, [follow]);

  // 推入的动画里大标题收起，内容的上内边距跟着变，之前滚到底的位置会差一截：动画结束后再滚一次。
  useEffect(
    () =>
      navigation.addListener('transitionEnd' as never, () => {
        if (pinned.current) follow(false);
      }),
    [navigation, follow],
  );

  const loadOlder = useCallback(() => {
    store.loadOlder(bot.key).catch((error: unknown) => console.warn('[wevir] older posts', error));
  }, [store, bot.key]);

  const decide = useCallback(
    async (post: BotPost, decision: Exclude<Decision, 'pending'>) => {
      if (post.card.kind === 'approval') {
        await store.respondApproval(bot.key, post.id, decision);
      } else if (post.card.kind === 'suggestion') {
        await store.respondSuggestion(
          bot.key,
          post.id.replace(/:card$/, ''),
          decision === 'approved',
        );
      }
    },
    [store, bot.key],
  );

  const retry = useCallback(() => {
    store.wake(bot.key).catch((error: unknown) => console.warn('[wevir] wake failed', error));
  }, [store, bot.key]);

  // 线程是那台电脑上的一个会话。
  const openThread = useCallback(
    (sessionId: string) => {
      router.push({
        pathname: '/session/[key]',
        params: { key: `${bot.computer}/${sessionId}`, botKey: bot.key },
      });
    },
    [router, bot.computer, bot.key],
  );

  const group = bot.kind === 'group';
  const access = useBotAccess(bot.key);
  const chat = access.chat && !group;
  const [error, setError] = useState<MessageKey>();
  // Android 的系统相册与相机是另一个 Activity：选照片时 App 进了后台、连接断开，等这台电脑重新连上（最多 15 秒）再传。
  const upload = async (mimeType: Parameters<typeof store.uploadImage>[1], data: string) => {
    for (let waited = 0; ; waited += 250) {
      try {
        return await store.uploadImage(bot.key, mimeType, data);
      } catch (e) {
        if (waited >= 15_000 || store.access(bot.key).online) throw e;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
  const photos = usePhotoAttachments({ upload, onError: setError });
  // 群里点选的成员：这条消息 @ 他们；发出后清掉。
  const [mentions, setMentions] = useState<readonly string[]>([]);
  const send = useCallback(
    async (text: string, clientMessageId: string) => {
      pinned.current = true;
      setError(undefined);
      try {
        await store.send(
          bot.key,
          text,
          mentions,
          photos.images,
          clientMessageId,
          chat ? reply?.id : undefined,
        );
      } catch (e) {
        // 电脑不在线时 store 直接抛错：说出来，输入栏把字放回去。
        setError(store.access(bot.key).online ? sendErrorKey(e) : 'newSession.offline');
        throw e;
      }
      setMentions([]);
      setReply(undefined);
      photos.clear();
    },
    [store, bot.key, mentions, photos, reply, chat],
  );
  const stop = useCallback(() => store.stop(bot.key), [store, bot.key]);
  const speech = useMemo(() => store.speech(bot.key), [store, bot.key]);
  const projects = useBotProjects(bot.key);
  const loadImage = useCallback(
    (image: UserImagePart) =>
      cachedImage(bot.computer, image, (write) => store.readImage(bot.key, image.imageId, write)),
    [store, bot.key, bot.computer],
  );

  const track = (e: NativeScrollEvent) => {
    const bottom = e.contentSize.height + e.contentInset.bottom - e.layoutMeasurement.height;
    pinned.current = bottom - e.contentOffset.y < 120;
  };

  // 帖子里说话的助理按同一台电脑上的列表找；列表变了 bot 也会换，跟着重算。
  const data = useMemo(() => {
    const posts = timelineViews(timeline, store.directory(bot.key), projects);
    if (!chat) return items(posts);
    return botTimelineRows(posts).flatMap((row): Item[] => [
      ...(row.separator
        ? [{ kind: 'time' as const, key: `t:${row.post.id}`, at: row.post.createdAt }]
        : []),
      { kind: 'post', key: row.post.id, ...row },
    ]);
  }, [timeline, store, bot, projects, chat]);
  const jump = useCallback(
    async (postId: string) => {
      pinned.current = false;
      setScrollTarget(postId);
      try {
        await store.findPost(bot.key, postId);
      } catch {
        setError('bot.locateFailed');
      }
    },
    [store, bot.key],
  );

  useEffect(() => {
    if (
      targetSeq === undefined ||
      !access.online ||
      locatedSeq.current === targetSeq ||
      timeline.loading ||
      timeline.loadingOlder
    )
      return;
    pinned.current = false;
    const target = timeline.posts.find((post) => post.seq === targetSeq);
    if (target !== undefined) {
      locatedSeq.current = targetSeq;
      setScrollTarget(target.id);
      return;
    }
    const connectionVersion = access.connectionVersion;
    void store.loadThrough(bot.key, targetSeq).catch((error: unknown) => {
      if (store.access(bot.key).connectionVersion !== connectionVersion) return;
      if (error instanceof ConnectionLostError || error instanceof ClientClosedError) return;
      console.warn('[wevir] could not locate bot post', error);
      setError('bot.locateFailed');
    });
  }, [
    store,
    bot.key,
    targetSeq,
    access.online,
    access.connectionVersion,
    timeline.loading,
    timeline.loadingOlder,
    timeline.posts,
  ]);

  useEffect(() => {
    if (scrollTarget === undefined || !access.online || timeline.loading || timeline.loadingOlder)
      return;
    const index = data.findIndex(
      (item) => item.kind === 'post' && item.post.sourceId === scrollTarget,
    );
    if (index < 0) {
      if (timeline.hasMore) {
        const connectionVersion = access.connectionVersion;
        void store.findPost(bot.key, scrollTarget).catch((error: unknown) => {
          if (
            store.access(bot.key).connectionVersion !== connectionVersion ||
            error instanceof ConnectionLostError ||
            error instanceof ClientClosedError
          )
            return;
          setError('bot.locateFailed');
        });
      } else {
        setError('bot.locateFailed');
        setScrollTarget(undefined);
      }
      return;
    }
    pinned.current = false;
    setError(undefined);
    setHighlighted(scrollTarget);
    list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: !reducedMotion });
    setScrollTarget(undefined);
  }, [
    data,
    scrollTarget,
    timeline.loading,
    timeline.loadingOlder,
    timeline.hasMore,
    reducedMotion,
    store,
    bot.key,
    access.online,
    access.connectionVersion,
  ]);

  useEffect(() => {
    if (highlighted === undefined) return;
    const timer = setTimeout(() => setHighlighted(undefined), 1800);
    return () => clearTimeout(timer);
  }, [highlighted]);
  useEffect(() => () => clearTimeout(scrollRetry.current), []);

  const react = async (post: BotPost, emoji: string) => {
    if (!access.canWrite) return;
    try {
      await store.react(
        bot.key,
        post.sourceId ?? post.id,
        timeline.posts
          .find((p) => p.id === (post.sourceId ?? post.id))
          ?.reactions?.some((r) => r.by === 'user' && r.emoji === emoji)
          ? null
          : emoji,
      );
    } catch {
      setError('bot.actionFailed');
    }
  };
  const menu = (post: BotPost) => {
    const source = timeline.posts.find((p) => p.id === post.sourceId);
    if (source === undefined) return;
    const actions = [
      ...(access.canWrite
        ? [
            { label: t('bot.reply'), onPress: () => setReply(source) },
            ...BOT_REACTIONS.map((emoji) => ({
              label: emoji,
              onPress: () => void react(post, emoji),
            })),
          ]
        : []),
      {
        label: t('bot.copy'),
        onPress: () => {
          void Clipboard.setStringAsync(
            source.content.flatMap((p) => (p.type === 'text' ? [p.text] : [])).join('\n'),
          ).catch(() => setError('bot.actionFailed'));
        },
      },
    ];
    if (Platform.OS === 'ios')
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [...actions.map((action) => action.label), t('add.cancel')],
          cancelButtonIndex: actions.length,
          userInterfaceStyle: theme.dark ? 'dark' : 'light',
        },
        (index) => actions[index]?.onPress(),
      );
    else showActions(actions);
  };
  const stateColor = botStateColor(theme, bot.state);
  const bottom = keyboard > 0 ? 8 : Math.max(insets.bottom, 8);

  return (
    <>
      {actionSheet}
      <Stack.Screen options={{ title: bot.name }} />
      <HeaderButton
        sf="slider.horizontal.3"
        md="tune"
        label={t(group ? 'group.edit' : access.panel ? 'bot.profile' : 'editBot.title')}
        onPress={() =>
          router.push({
            pathname: group ? '/edit-group' : access.panel ? '/bot-profile' : '/edit-bot',
            params: { key: bot.key },
          })
        }
      />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        {/* Android 全面屏（edge-to-edge）下窗口不随键盘缩小，KeyboardAvoidingView 也算不准：按键盘高度自己让开。 */}
        <View style={[styles.flex, Platform.OS === 'android' && { marginBottom: keyboard }]}>
          <FlatList
            ref={list}
            data={data}
            keyExtractor={(item) => item.key}
            onScrollToIndexFailed={({ index, averageItemLength }) => {
              list.current?.scrollToOffset({ offset: averageItemLength * index, animated: false });
              clearTimeout(scrollRetry.current);
              scrollRetry.current = setTimeout(
                () => list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: false }),
                120,
              );
            }}
            contentInsetAdjustmentBehavior="automatic"
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            initialNumToRender={60}
            maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
            contentContainerStyle={[styles.content, { paddingBottom: composerHeight + 16 }]}
            onLayout={(e) => {
              viewport.current = e.nativeEvent.layout.height;
            }}
            onContentSizeChange={(_, height) => {
              content.current = height;
              if (!pinned.current || timeline.loading || data.length === 0) return;
              if (
                scrollTarget !== undefined ||
                highlighted !== undefined ||
                (targetSeq !== undefined && !settled.current)
              )
                return;
              follow(settled.current);
              settled.current = true;
            }}
            onScrollBeginDrag={() => {
              dragging.current = true;
            }}
            onScrollEndDrag={(e) => {
              dragging.current = false;
              track(e.nativeEvent);
            }}
            onMomentumScrollEnd={(e) => track(e.nativeEvent)}
            // 只认用户的拖动；自己滚到底的动画途中不算离开底部。
            onScroll={(e) => dragging.current && track(e.nativeEvent)}
            scrollEventThrottle={100}
            refreshControl={
              timeline.hasMore ? (
                <RefreshControl
                  refreshing={timeline.loadingOlder}
                  onRefresh={loadOlder}
                  tintColor={theme.mutedForeground}
                  colors={[theme.foreground]}
                  progressBackgroundColor={theme.card}
                />
              ) : undefined
            }
            ListHeaderComponent={
              <View style={styles.profile}>
                {group ? (
                  <GroupAvatar bot={bot} size={64} />
                ) : (
                  <BotAvatar avatar={bot.avatar} size={64} pose={botPose(bot.state)} />
                )}
                <View style={styles.profileText}>
                  <Text style={[styles.description, { color: theme.softForeground }]}>
                    {group ? joinNames(bot.members.map((member) => member.name)) : bot.description}
                  </Text>
                  <Text style={[styles.meta, { color: theme.mutedForeground }]} numberOfLines={1}>
                    {bot.computerName}
                    <Text
                      style={{ color: stateColor }}
                    >{` · ${t(`bots.state.${bot.state}`)}`}</Text>
                  </Text>
                </View>
              </View>
            }
            ListFooterComponent={
              chat ? (
                bot.answering ? (
                  <TypingBubble bot={bot} />
                ) : undefined
              ) : bot.state === 'working' ? (
                <View style={styles.working}>
                  <BotAvatar avatar={bot.avatar} size={22} pose="working" />
                  <Text style={[styles.meta, { color: theme.mutedForeground }]}>
                    {t('bots.state.working')}
                  </Text>
                </View>
              ) : undefined
            }
            renderItem={({ item }) =>
              item.kind === 'time' ? (
                <Text style={[styles.time, { color: theme.mutedForeground }]}>
                  {chat ? botTimeLabel(item.at, now) : clock(item.at, now)}
                </Text>
              ) : chat &&
                item.post.author !== 'host' &&
                ['text', 'images'].includes(item.post.card.kind) ? (
                <ChatPost
                  row={item}
                  bot={bot}
                  onLoadImage={loadImage}
                  highlighted={highlighted === item.post.sourceId}
                  {...(showsBotQuote(item.post, timeline.posts) && {
                    quote:
                      botPostQuote(
                        timeline.posts.find((p) => p.id === item.post.replyTo) ?? { content: [] },
                      ) || t('bot.earlierMessage'),
                  })}
                  onQuote={() => item.post.replyTo !== undefined && void jump(item.post.replyTo)}
                  onLongPress={() => menu(item.post)}
                  onReact={(emoji) => void react(item.post, emoji)}
                  onReplies={() => {
                    const first = timeline.posts.find((p) => p.replyTo === item.post.sourceId);
                    if (first) void jump(first.id);
                  }}
                />
              ) : (
                <View style={styles.post}>
                  <PostView
                    compactThread={chat}
                    post={item.post}
                    now={now}
                    onDecide={decide}
                    onOpenThread={openThread}
                    onLoadImage={loadImage}
                    {...(!group && { onRetry: retry })}
                  />
                </View>
              )
            }
          />
          <View
            style={[styles.composer, { paddingBottom: bottom }]}
            onLayout={(e) => setComposerHeight(e.nativeEvent.layout.height)}
          >
            {group && bot.members.length > 0 && (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={styles.members}
              >
                {bot.members.map((member) => {
                  const on = mentions.includes(member.id);
                  return (
                    <Pressable
                      key={member.id}
                      accessibilityRole="button"
                      accessibilityState={{ selected: on }}
                      accessibilityLabel={t('bot.mention', { name: member.name })}
                      onPress={() =>
                        setMentions((current) =>
                          on ? current.filter((id) => id !== member.id) : [...current, member.id],
                        )
                      }
                      style={[
                        styles.member,
                        {
                          backgroundColor: on ? theme.primary : theme.card,
                          borderColor: on ? theme.primary : theme.border,
                        },
                      ]}
                    >
                      <BotAvatar avatar={member.avatar} size={18} />
                      <Text
                        style={[
                          styles.memberName,
                          { color: on ? theme.primaryForeground : theme.foreground },
                        ]}
                        numberOfLines={1}
                      >
                        {`@${member.name}`}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
            )}
            {chat && reply !== undefined && (
              <View
                style={[styles.quote, { backgroundColor: theme.card, borderColor: theme.border }]}
              >
                <Text
                  style={[styles.quoteText, { color: theme.mutedForeground }]}
                  numberOfLines={1}
                >
                  {botPostQuote(reply) || t('bot.image')}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('add.cancel')}
                  onPress={() => setReply(undefined)}
                  hitSlop={10}
                >
                  <Icon
                    name={{ ios: 'xmark', android: 'close' }}
                    size={16}
                    color={theme.mutedForeground}
                  />
                </Pressable>
              </View>
            )}
            {error !== undefined && (
              <Text style={[styles.error, { color: theme.destructive }]} testID="bot-error">
                {t(error)}
              </Text>
            )}
            <Composer
              key={computer?.record.routeId ?? bot.key}
              draftKey={`${computer?.record.routeId ?? 'unassigned'}/bot:${bot.id}`}
              canSend={access.online && access.canWrite}
              onSend={send}
              {...(group && { placeholder: t('bot.groupPlaceholder', { name: bot.name }) })}
              {...(access.composer && {
                attachMenu: photos.menu,
                attachments: photos.attachments,
                onRemoveAttachment: photos.remove,
                busy: bot.answering,
                onStop: stop,
              })}
              {...(access.speech && { speech, onDictationError: setError })}
            />
          </View>
        </View>
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  content: { paddingHorizontal: SPACE.page, paddingTop: 4 },
  profile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    paddingHorizontal: 4,
    paddingBottom: 20,
  },
  profileText: { flex: 1, gap: 4 },
  description: { fontSize: TEXT.body, lineHeight: 22 },
  meta: { fontSize: TEXT.caption },
  time: {
    fontSize: TEXT.caption,
    textAlign: 'center',
    marginTop: 14,
    marginBottom: 2,
    fontVariant: ['tabular-nums'],
  },
  post: { marginTop: 12 },
  working: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 18,
    paddingHorizontal: 2,
  },
  composer: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 12 },
  members: { gap: 8, paddingBottom: 8, paddingHorizontal: 2 },
  member: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  memberName: { fontSize: TEXT.small, fontWeight: '500' },
  quote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
    marginBottom: 6,
  },
  quoteText: { flex: 1, fontSize: TEXT.small },
  error: { fontSize: TEXT.small, textAlign: 'center', paddingBottom: 6 },
});
