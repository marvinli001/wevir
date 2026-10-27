// 收件箱：所有连着的电脑上等你处理的事合成一个列表（要作答的在前，先到期的在前），每张卡片标出电脑与会话。审批直接批准或拒绝
// （高风险的批准先验证本人），只有一题单选的提问直接点选项，失败回合与自动化可以收起；点卡片进对应的会话或助理。作答撞上别处
// 先处理了或已过期时，卡片换成一行“已在电脑上处理 · 已批准 · 2 分钟前”，点掉为止。离线的电脑列在最后。

import type { InboxItem } from '@wevir/protocol';
import { Stack, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Badge, Button, EmptyState, Icon, type IconName } from '../../../components/ui';
import { locale, type MessageKey, t, timeAgo } from '../../../i18n';
import { ApprovalNotVerifiedError } from '../../../lib/approval-gate';
import {
  expiryOf,
  type InboxEntry,
  inboxTarget,
  isHighRisk,
  quickQuestion,
} from '../../../lib/inbox';
import type { SettledEntry } from '../../../lib/inbox-store';
import { useInbox, useInboxStore } from '../../../state/inbox';
import { useComputers } from '../../../state/registry';
import { RADIUS, SPACE, TEXT, type Theme, useTheme } from '../../../theme';

/** 有会过期的项时每 10 秒走一次，倒计时与“已过期”最多晚 10 秒；没有时按分钟走（只用于“几分钟前”）。 */
function useInboxClock(expiring: boolean): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), expiring ? 10_000 : 60_000);
    return () => clearInterval(timer);
  }, [expiring]);
  return now;
}

export default function InboxScreen() {
  const router = useRouter();
  const inbox = useInbox();
  const { loaded, computers } = useComputers();
  const now = useInboxClock(inbox.entries.some((entry) => entry.item.expiresAt !== undefined));
  const empty = inbox.entries.length === 0 && inbox.settled.length === 0;
  return (
    <>
      <Stack.Screen options={{ title: t('inbox.title') }} />
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
        {inbox.settled.map((settled) => (
          <SettledCard key={`settled:${settled.entry.key}`} settled={settled} now={now} />
        ))}
        {inbox.entries.map((entry) => (
          <EntryCard key={entry.key} entry={entry} now={now} />
        ))}
        {empty &&
          loaded &&
          (computers.length === 0 ? (
            <EmptyState
              icon={{ ios: 'laptopcomputer.and.iphone', android: 'devices' }}
              title={t('computers.empty')}
              action={{
                title: t('computers.add'),
                icon: { ios: 'qrcode.viewfinder', android: 'qr_code_scanner' },
                onPress: () => router.push('/add'),
              }}
            />
          ) : (
            !inbox.loading && (
              <EmptyState icon={{ ios: 'tray', android: 'inbox' }} title={t('inbox.empty')} />
            )
          ))}
        {inbox.unavailable.length > 0 && computers.length > 0 && (
          <Footer
            text={t('inbox.unavailable', {
              names: inbox.unavailable.join(locale().startsWith('zh') ? '、' : ', '),
            })}
          />
        )}
      </ScrollView>
    </>
  );
}

function Footer({ text }: { text: string }) {
  const theme = useTheme();
  return <Text style={[styles.footer, { color: theme.mutedForeground }]}>{text}</Text>;
}

function kindLabel(item: InboxItem): { icon: IconName; label: MessageKey } {
  switch (item.kind) {
    case 'approval':
      return { icon: { ios: 'hand.raised', android: 'front_hand' }, label: 'notify.approval' };
    case 'question':
      return {
        icon: { ios: 'questionmark.bubble', android: 'contact_support' },
        label: 'notify.question',
      };
    case 'turn_failed':
      return {
        icon: { ios: 'exclamationmark.triangle', android: 'warning' },
        label: 'notify.failed',
      };
    case 'automation':
      return {
        icon: { ios: 'clock.arrow.circlepath', android: 'schedule' },
        label: 'notify.automation',
      };
  }
}

function toneOf(theme: Theme, item: InboxItem): string {
  if (item.kind === 'turn_failed' || (item.kind === 'automation' && item.ref.status === 'failed'))
    return theme.destructive;
  if (item.kind === 'approval' || item.kind === 'question') return theme.warning;
  return theme.mutedForeground;
}

/** 卡片的外框：表面色、细描边，与助理的卡片同一种。 */
function Card({ children, onPress }: { children: React.ReactNode; onPress?: () => void }) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole={onPress ? 'button' : undefined}
      disabled={onPress === undefined}
      onPress={onPress}
      android_ripple={{ color: theme.muted }}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: theme.card, borderColor: theme.dark ? theme.border : 'transparent' },
        !theme.dark && styles.cardShadow,
        pressed && { opacity: 0.85 },
      ]}
    >
      {children}
    </Pressable>
  );
}

function EntryCard({ entry, now }: { entry: InboxEntry; now: Date }) {
  const theme = useTheme();
  const router = useRouter();
  const store = useInboxStore();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<MessageKey>();
  const { item } = entry;
  const { icon, label } = kindLabel(item);
  const tone = toneOf(theme, item);
  const expiry = expiryOf(item, now);
  const risky = isHighRisk(item);
  const quick = quickQuestion(item);

  const run = (action: () => Promise<unknown>) => {
    setBusy(true);
    setNote(undefined);
    action()
      .catch((error: unknown) => {
        setNote(error instanceof ApprovalNotVerifiedError ? 'lock.notVerified' : 'inbox.failed');
        if (!(error instanceof ApprovalNotVerifiedError))
          console.warn('[wevir] inbox action failed', error);
      })
      .finally(() => setBusy(false));
  };

  const options = item.kind === 'approval' ? item.ref.options : [];
  const allow =
    options.find((o) => o.category === 'allow' && o.kind.endsWith('_once')) ??
    options.find((o) => o.category === 'allow');
  const reject =
    options.find((o) => o.category === 'reject' && o.kind.endsWith('_once')) ??
    options.find((o) => o.category === 'reject');

  return (
    <Card onPress={() => router.push(inboxTarget(entry))}>
      <View style={styles.head}>
        <Icon name={icon} size={15} color={tone} weight="semibold" />
        <Text style={[styles.label, { color: tone }]} numberOfLines={1}>
          {`${t(label)} · ${entry.computerName}`}
        </Text>
        <Text style={[styles.time, { color: theme.mutedForeground }]}>
          {timeAgo(item.createdAt, now)}
        </Text>
      </View>
      <Text style={[styles.title, { color: theme.foreground }]} numberOfLines={2}>
        {item.title}
      </Text>
      {item.summary !== '' && (
        <View style={[styles.quote, { backgroundColor: theme.muted }]}>
          <Text
            style={[
              styles.quoteText,
              { color: theme.foreground },
              item.kind === 'approval' && styles.mono,
            ]}
            numberOfLines={4}
            selectable
          >
            {item.summary}
          </Text>
        </View>
      )}
      {(risky || expiry.kind !== 'none') && (
        <View style={styles.meta}>
          {risky && <Badge text={t('inbox.highRisk')} color={theme.destructive} />}
          {expiry.kind !== 'none' && (
            <Text style={[styles.metaText, { color: theme.warning }]}>
              {expiry.kind === 'expired'
                ? t('inbox.expired')
                : t('inbox.expiresIn', { n: expiry.minutes })}
            </Text>
          )}
        </View>
      )}
      {item.kind === 'approval' && allow !== undefined && reject !== undefined && (
        <View style={styles.actions}>
          <View style={styles.action}>
            <Button
              kind="secondary"
              title={t('bot.reject')}
              disabled={busy || expiry.kind === 'expired'}
              onPress={() => run(() => store.respondApproval(entry, reject.optionId))}
            />
          </View>
          <View style={styles.action}>
            <Button
              title={t('bot.approve')}
              {...(risky && { icon: { ios: 'faceid', android: 'fingerprint' } as const })}
              disabled={busy || expiry.kind === 'expired'}
              onPress={() => run(() => store.respondApproval(entry, allow.optionId))}
            />
          </View>
        </View>
      )}
      {quick !== undefined && (
        <View style={styles.options}>
          {quick.options.map((option) => (
            <Button
              key={option}
              kind="secondary"
              title={option}
              disabled={busy}
              onPress={() =>
                run(() => store.answerQuestion(entry, { [quick.id]: { answers: [option] } }))
              }
            />
          ))}
        </View>
      )}
      {item.kind === 'question' && quick === undefined && (
        <Text style={[styles.metaText, { color: theme.mutedForeground }]}>
          {t('inbox.answerInSession')}
        </Text>
      )}
      {(item.kind === 'turn_failed' || item.kind === 'automation') && (
        <View style={styles.dismiss}>
          <Button
            kind="secondary"
            title={t('inbox.dismiss')}
            disabled={busy}
            onPress={() => run(() => store.dismiss(entry))}
          />
        </View>
      )}
      {note !== undefined && (
        <Text style={[styles.metaText, { color: theme.destructive }]}>{t(note)}</Text>
      )}
    </Card>
  );
}

/** “已在电脑上处理 · 已批准 · 2 分钟前”；规则、过期、取消只说一句。 */
function outcomeLine(outcome: SettledEntry['outcome'], now: Date): string {
  const parts = [t(`inbox.elsewhere.${outcome.by}`)];
  if (outcome.by !== 'timeout' && outcome.by !== 'cancelled' && outcome.by !== 'rule')
    parts.push(t(`inbox.result.${outcome.result}`));
  if (outcome.at !== undefined) parts.push(timeAgo(outcome.at, now));
  return parts.join(' · ');
}

function SettledCard({ settled, now }: { settled: SettledEntry; now: Date }) {
  const theme = useTheme();
  const store = useInboxStore();
  const { entry, outcome } = settled;
  const { icon, label } = kindLabel(entry.item);
  return (
    <Card>
      <View style={styles.head}>
        <Icon name={icon} size={15} color={theme.mutedForeground} weight="semibold" />
        <Text style={[styles.label, { color: theme.mutedForeground }]} numberOfLines={1}>
          {`${t(label)} · ${entry.computerName}`}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('inbox.close')}
          hitSlop={12}
          onPress={() => store.acknowledge(entry.key)}
        >
          <Icon name={{ ios: 'xmark', android: 'close' }} size={14} color={theme.mutedForeground} />
        </Pressable>
      </View>
      <Text style={[styles.title, { color: theme.softForeground }]} numberOfLines={1}>
        {entry.item.title}
      </Text>
      <View style={styles.meta}>
        <Icon
          name={{ ios: 'checkmark.circle', android: 'check_circle' }}
          size={15}
          color={theme.mutedForeground}
        />
        <Text style={[styles.metaText, { color: theme.mutedForeground }]}>
          {outcomeLine(outcome, now)}
        </Text>
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: SPACE.page, paddingBottom: 120, gap: 12 },
  card: {
    borderRadius: 20,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    padding: 16,
    gap: 10,
  },
  cardShadow: {
    boxShadow: '0 1px 2px rgba(26, 26, 23, 0.04), 0 4px 16px rgba(26, 26, 23, 0.04)',
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  label: { flex: 1, fontSize: TEXT.small, fontWeight: '600' },
  time: { fontSize: TEXT.caption, fontVariant: ['tabular-nums'] },
  title: { fontSize: TEXT.body, fontWeight: '600', lineHeight: 21 },
  quote: { borderRadius: RADIUS.control, borderCurve: 'continuous', padding: 12 },
  quoteText: { fontSize: 15, lineHeight: 21 },
  mono: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 14 },
  meta: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  metaText: { fontSize: TEXT.small },
  actions: { flexDirection: 'row', gap: 10 },
  action: { flex: 1 },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  dismiss: { alignSelf: 'flex-start' },
  footer: { fontSize: TEXT.small, textAlign: 'center', marginTop: 12 },
});
