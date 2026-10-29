// 助理时间线上的一条：用户的话是右侧的气泡，助理的回答是不带气泡的正文，Host 的说明是居中的小字；卡片是实底的圆角卡：
// “开始前需要”、晨间简报、审批（原样展示将要发出的内容，批准 / 拒绝）、线程（它开出的会话与实时状态）、交给用户的文件、提议（采纳 / 忽略）。
// 别的助理说的（群里的成员、发来消息的助理）上面一行是它的小头像与名字；发给别的助理的标“发给 …”。帖子里的图片是一排缩略图；
// 开在用户项目里的线程（0.134.0）状态后写项目名。

import { type ReactNode, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { formatBytes, type MessageKey, t, timeAgo } from '../i18n';
import { ApprovalNotVerifiedError } from '../lib/approval-gate';
import type { BotCard, BotPost, Decision, NeedKind, ThreadStatus } from '../lib/bots';
import { RADIUS, TEXT, type Theme, useTheme } from '../theme';
import { BotAvatar } from './bot-avatar';
import { Markdown } from './markdown';
import { type LoadImage, PostImages } from './post-images';
import { Button, Chevron, Icon, type IconName } from './ui';

type Decide = (decision: Exclude<Decision, 'pending'>) => Promise<void>;

export function PostView({
  post,
  now,
  onDecide,
  onOpenThread,
  onRetry,
  onLoadImage,
}: {
  post: BotPost;
  now: Date;
  onDecide: (post: BotPost, decision: Exclude<Decision, 'pending'>) => Promise<void>;
  onOpenThread: (sessionId: string) => void;
  /** 读帖子里的一张图片，给本机文件的 URI；不给时不画图片（会话页借用这里的文字与审批）。 */
  onLoadImage?: LoadImage;
  /** 群没有协调者，不给重试。 */
  onRetry?: () => void;
}) {
  const { card } = post;
  const decide: Decide = (decision) => onDecide(post, decision);
  switch (card.kind) {
    case 'text':
      return <TextPost post={post} text={card.text} />;
    case 'brief':
      return <BriefCard card={card} at={timeAgo(post.createdAt, now)} />;
    case 'approval':
      return <ApprovalCard card={card} at={timeAgo(post.createdAt, now)} onDecide={decide} />;
    case 'thread':
      return <ThreadCard card={card} onPress={() => onOpenThread(card.sessionId)} />;
    case 'file':
      return <FileCard card={card} />;
    case 'images':
      return onLoadImage === undefined ? null : (
        <PostImages
          images={card.images}
          align={post.author === 'user' ? 'end' : 'start'}
          load={onLoadImage}
        />
      );
    case 'suggestion':
      return <SuggestionCard card={card} onDecide={decide} />;
    case 'needs':
      return <NeedsCard card={card} />;
    case 'notice':
      return (
        <Notice
          reason={card.reason}
          {...(card.about !== undefined && { about: card.about })}
          {...(onRetry !== undefined && { onRetry })}
        />
      );
  }
}

function TextPost({ post, text }: { post: BotPost; text: string }) {
  const theme = useTheme();
  const author = post.author;
  if (author === 'user') {
    return (
      <View style={[styles.bubble, { backgroundColor: theme.dark ? theme.muted : theme.card }]}>
        <Text style={[styles.body, { color: theme.foreground }]} selectable>
          {text}
        </Text>
      </View>
    );
  }
  if (author === 'host') {
    return <Text style={[styles.host, { color: theme.mutedForeground }]}>{text}</Text>;
  }
  return (
    <View style={styles.reply}>
      {post.speaker !== undefined && (
        <View style={styles.speaker}>
          <BotAvatar avatar={post.speaker.avatar} size={18} />
          <Text style={[styles.speakerName, { color: theme.softForeground }]} numberOfLines={1}>
            {post.speaker.name}
          </Text>
        </View>
      )}
      {post.to !== undefined && (
        <Text style={[styles.to, { color: theme.mutedForeground }]} numberOfLines={1}>
          {t('bot.to', { name: post.to })}
        </Text>
      )}
      <Markdown text={text} />
    </View>
  );
}

/** Host 的说明：预算用完、恢复、出错（出错时附重试），以及按规矩做完告知、拦下交给用户、拦下的转账交易（0.132.0）。 */
function Notice({
  reason,
  about,
  onRetry,
}: {
  reason: Extract<BotCard, { kind: 'notice' }>['reason'];
  /** 群里：说的是哪个成员。 */
  about?: string;
  onRetry?: () => void;
}) {
  const theme = useTheme();
  return (
    <Text
      style={[
        styles.host,
        {
          color:
            reason === 'failed' || reason === 'blocked' ? theme.destructive : theme.mutedForeground,
        },
      ]}
    >
      {about === undefined ? '' : `${about} · `}
      {t(`bot.notice.${reason}`)}
      {reason === 'failed' && onRetry !== undefined && (
        <Text
          style={[styles.retry, { color: theme.foreground }]}
          onPress={onRetry}
          suppressHighlighting
        >
          {`  ${t('bot.retry')}`}
        </Text>
      )}
    </Text>
  );
}

/** 卡片：实底圆角，顶部一行小标题（图标、名称、时间）。 */
function Card({
  icon,
  label,
  at,
  tone,
  children,
}: {
  icon: IconName;
  label: string;
  at?: string;
  tone?: string;
  children: ReactNode;
}) {
  const theme = useTheme();
  const color = tone ?? theme.mutedForeground;
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.card, borderColor: theme.dark ? theme.border : 'transparent' },
        !theme.dark && styles.cardShadow,
      ]}
    >
      <View style={styles.cardHead}>
        <Icon name={icon} size={15} color={color} weight="semibold" />
        <Text style={[styles.cardLabel, { color }]} numberOfLines={1}>
          {label}
        </Text>
        {at !== undefined && (
          <Text style={[styles.cardTime, { color: theme.mutedForeground }]}>{at}</Text>
        )}
      </View>
      {children}
    </View>
  );
}

function BriefCard({ card, at }: { card: Extract<BotCard, { kind: 'brief' }>; at: string }) {
  const theme = useTheme();
  const sections = [
    { title: t('bot.brief.todo'), items: card.todo, color: theme.foreground },
    { title: t('bot.brief.done'), items: card.done, color: theme.success },
    { title: t('bot.brief.decide'), items: card.decide, color: theme.warning },
  ].filter((s) => s.items.length > 0);
  return (
    <Card icon={{ ios: 'sun.horizon', android: 'wb_twilight' }} label={t('bot.brief')} at={at}>
      {sections.map((section) => (
        <View key={section.title} style={styles.briefSection}>
          <Text style={[styles.briefTitle, { color: theme.mutedForeground }]}>{section.title}</Text>
          {section.items.map((item) => (
            <View key={item} style={styles.briefItem}>
              <View style={[styles.briefDot, { backgroundColor: section.color }]} />
              <Text style={[styles.briefText, { color: theme.foreground }]}>{item}</Text>
            </View>
          ))}
        </View>
      ))}
    </Card>
  );
}

function ApprovalCard({
  card,
  at,
  onDecide,
}: {
  card: Extract<BotCard, { kind: 'approval' }>;
  at: string;
  onDecide: Decide;
}) {
  const theme = useTheme();
  const pending = card.decision === 'pending';
  return (
    <Card
      icon={{ ios: 'hand.raised', android: 'front_hand' }}
      label={card.tool !== '' ? `${t('bot.approval')} · ${card.tool}` : t('bot.approval')}
      at={at}
      tone={pending ? theme.warning : undefined}
    >
      {(card.target !== undefined || card.subject !== undefined) && (
        <View style={styles.fields}>
          {card.target !== undefined && <Field label={t('bot.approval.to')} value={card.target} />}
          {card.subject !== undefined && (
            <Field label={t('bot.approval.subject')} value={card.subject} />
          )}
        </View>
      )}
      <View style={[styles.quote, { backgroundColor: theme.muted }]}>
        <Text style={[styles.quoteText, { color: theme.foreground }]} selectable>
          {card.text}
        </Text>
      </View>
      <Decisions
        decision={card.decision}
        accept={t('bot.approve')}
        reject={t('bot.reject')}
        accepted={t('bot.approved')}
        rejected={t('bot.rejected')}
        onDecide={onDecide}
      />
    </Card>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: theme.mutedForeground }]}>{label}</Text>
      <Text style={[styles.fieldValue, { color: theme.foreground }]} numberOfLines={2} selectable>
        {value}
      </Text>
    </View>
  );
}

/** 两个按钮；决定后换成一行结果。按下后到结果回来之前两个都不能再按。 */
function Decisions({
  decision,
  accept,
  reject,
  accepted,
  rejected,
  onDecide,
}: {
  decision: Decision;
  accept: string;
  reject: string;
  accepted: string;
  rejected: string;
  onDecide: Decide;
}) {
  const theme = useTheme();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<MessageKey>();
  if (decision !== 'pending') {
    const yes = decision === 'approved';
    return (
      <View style={styles.result}>
        <Icon
          name={
            yes
              ? { ios: 'checkmark.circle.fill', android: 'check_circle' }
              : { ios: 'xmark.circle', android: 'cancel' }
          }
          size={16}
          color={yes ? theme.success : theme.mutedForeground}
        />
        <Text style={[styles.resultText, { color: yes ? theme.success : theme.mutedForeground }]}>
          {yes ? accepted : rejected}
        </Text>
      </View>
    );
  }
  const press = (value: Exclude<Decision, 'pending'>) => {
    setBusy(true);
    setFailed(undefined);
    onDecide(value)
      .catch((error: unknown) => {
        // 高风险审批没通过本人验证（取消，或手机没设锁屏）也要说出来，不然点了没反应。
        if (error instanceof ApprovalNotVerifiedError) setFailed('lock.notVerified');
        else {
          setFailed('inbox.failed');
          console.warn('[wevir] decision failed', error);
        }
      })
      .finally(() => setBusy(false));
  };
  return (
    <View style={styles.decide}>
      <View style={styles.actions}>
        <View style={styles.action}>
          <Button
            kind="secondary"
            title={reject}
            disabled={busy}
            onPress={() => press('rejected')}
          />
        </View>
        <View style={styles.action}>
          <Button title={accept} disabled={busy} onPress={() => press('approved')} />
        </View>
      </View>
      {failed !== undefined && (
        <Text style={[styles.failed, { color: theme.destructive }]}>{t(failed)}</Text>
      )}
    </View>
  );
}

function threadColor(theme: Theme, status: ThreadStatus): string {
  switch (status) {
    case 'working':
    case 'replied':
      return theme.running;
    case 'waiting':
      return theme.warning;
    case 'failed':
      return theme.destructive;
    case 'idle':
    case 'resolved':
      return theme.mutedForeground;
  }
}

function ThreadCard({
  card,
  onPress,
}: {
  card: Extract<BotCard, { kind: 'thread' }>;
  onPress: () => void;
}) {
  const theme = useTheme();
  const color = threadColor(theme, card.status);
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      android_ripple={{ color: theme.muted }}
      style={({ pressed }) => [
        styles.card,
        styles.threadCard,
        { backgroundColor: theme.card, borderColor: theme.dark ? theme.border : 'transparent' },
        !theme.dark && styles.cardShadow,
        pressed && { opacity: 0.7 },
      ]}
    >
      <View style={[styles.tile, { backgroundColor: theme.muted }]}>
        {card.status === 'working' ? (
          <ActivityIndicator size="small" color={color} />
        ) : (
          <Icon
            name={{ ios: 'chevron.left.forwardslash.chevron.right', android: 'code' }}
            size={16}
            color={color}
            weight="semibold"
          />
        )}
      </View>
      <View style={styles.threadText}>
        <Text style={[styles.threadTitle, { color: theme.foreground }]} numberOfLines={1}>
          {card.title}
        </Text>
        <Text style={[styles.threadMeta, { color }]} numberOfLines={1}>
          {t(`bot.thread.${card.status}`)}
          {card.project !== undefined && (
            <Text style={{ color: theme.mutedForeground }}>{` · ${card.project}`}</Text>
          )}
        </Text>
        {card.line !== undefined && (
          <Text style={[styles.threadLine, { color: theme.softForeground }]} numberOfLines={1}>
            {card.line}
          </Text>
        )}
      </View>
      <Chevron color={theme.borderStrong} />
    </Pressable>
  );
}

/** 助理交给用户的文件：在电脑上，手机只列名字与大小。 */
function FileCard({ card }: { card: Extract<BotCard, { kind: 'file' }> }) {
  const theme = useTheme();
  return (
    <View
      style={[
        styles.card,
        styles.threadCard,
        { backgroundColor: theme.card, borderColor: theme.dark ? theme.border : 'transparent' },
        !theme.dark && styles.cardShadow,
      ]}
    >
      <View style={[styles.tile, { backgroundColor: theme.muted }]}>
        <Icon
          name={{ ios: 'doc.text', android: 'description' }}
          size={17}
          color={theme.foreground}
        />
      </View>
      <View style={styles.threadText}>
        <Text style={[styles.threadTitle, { color: theme.foreground }]} numberOfLines={1}>
          {card.name}
        </Text>
        <Text style={[styles.threadMeta, { color: theme.mutedForeground }]} numberOfLines={1}>
          {`${t('bot.file')} · ${formatBytes(card.size)}`}
        </Text>
      </View>
    </View>
  );
}

function SuggestionCard({
  card,
  onDecide,
}: {
  card: Extract<BotCard, { kind: 'suggestion' }>;
  onDecide: Decide;
}) {
  const theme = useTheme();
  return (
    <Card icon={{ ios: 'lightbulb', android: 'lightbulb' }} label={t('bot.suggestion')}>
      <Text style={[styles.body, { color: theme.foreground }]}>{card.text}</Text>
      <Decisions
        decision={card.decision}
        accept={t('bot.accept')}
        reject={t('bot.dismiss')}
        accepted={t('bot.accepted')}
        rejected={t('bot.dismissed')}
        onDecide={onDecide}
      />
    </Card>
  );
}

const NEED_ICONS: Record<NeedKind, IconName> = {
  connector: { ios: 'puzzlepiece.extension', android: 'extension' },
  folder: { ios: 'folder', android: 'folder' },
  login: { ios: 'person.badge.key', android: 'key' },
  other: { ios: 'ellipsis.circle', android: 'more_horiz' },
};

/** “开始前需要”：每项一行，有了的打勾。授权要在电脑上做，手机只列出来。 */
function NeedsCard({ card }: { card: Extract<BotCard, { kind: 'needs' }> }) {
  const theme = useTheme();
  return (
    <Card icon={{ ios: 'checklist', android: 'checklist' }} label={t('bot.needs')}>
      {card.items.map((item) => (
        <View key={`${item.kind}:${item.label}`} style={styles.need}>
          <Icon name={NEED_ICONS[item.kind]} size={17} color={theme.softForeground} />
          <View style={styles.threadText}>
            <Text style={[styles.needLabel, { color: theme.foreground }]}>{item.label}</Text>
            {item.detail !== undefined && (
              <Text style={[styles.threadMeta, { color: theme.mutedForeground }]}>
                {item.detail}
              </Text>
            )}
          </View>
          <Icon
            name={
              item.ready
                ? { ios: 'checkmark.circle.fill', android: 'check_circle' }
                : { ios: 'circle', android: 'radio_button_unchecked' }
            }
            size={18}
            color={item.ready ? theme.success : theme.borderStrong}
          />
        </View>
      ))}
    </Card>
  );
}

const styles = StyleSheet.create({
  body: { fontSize: TEXT.body, lineHeight: 23 },
  reply: { paddingRight: 24 },
  speaker: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  speakerName: { fontSize: TEXT.caption, fontWeight: '600' },
  to: { fontSize: TEXT.caption, marginBottom: 4 },
  bubble: {
    alignSelf: 'flex-end',
    maxWidth: '82%',
    borderRadius: 20,
    borderCurve: 'continuous',
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  host: { fontSize: TEXT.caption, textAlign: 'center', alignSelf: 'center' },
  retry: { fontWeight: '600' },
  card: {
    borderRadius: 20,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    gap: 12,
  },
  cardShadow: {
    boxShadow: '0 1px 2px rgba(26, 26, 23, 0.04), 0 4px 16px rgba(26, 26, 23, 0.04)',
  },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  cardLabel: { flex: 1, fontSize: TEXT.small, fontWeight: '600' },
  cardTime: { fontSize: TEXT.caption, fontVariant: ['tabular-nums'] },
  briefSection: { gap: 6 },
  briefTitle: { fontSize: TEXT.caption, fontWeight: '600' },
  briefItem: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  briefDot: { width: 6, height: 6, borderRadius: 3, marginTop: 8 },
  briefText: { flex: 1, fontSize: 15, lineHeight: 21 },
  fields: { gap: 4 },
  field: { flexDirection: 'row', gap: 10 },
  fieldLabel: { width: 56, fontSize: TEXT.small },
  fieldValue: { flex: 1, fontSize: TEXT.small, fontWeight: '500' },
  quote: { borderRadius: RADIUS.control, borderCurve: 'continuous', padding: 12 },
  quoteText: { fontSize: 15, lineHeight: 21 },
  decide: { gap: 8 },
  actions: { flexDirection: 'row', gap: 10 },
  failed: { fontSize: TEXT.small },
  action: { flex: 1 },
  result: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  resultText: { fontSize: TEXT.small, fontWeight: '600' },
  threadCard: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14 },
  tile: {
    width: 36,
    height: 36,
    borderRadius: RADIUS.tile,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
  },
  threadText: { flex: 1, gap: 2 },
  threadTitle: { fontSize: TEXT.body, fontWeight: '600', letterSpacing: -0.2 },
  threadMeta: { fontSize: TEXT.small },
  threadLine: { fontSize: TEXT.small },
  need: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 32 },
  needLabel: { fontSize: 15 },
});
