import {
  type AutoContinueState,
  type ChatPartOf,
  type ContinuityNotice,
  usageLimitState,
} from '@wevir/client-sdk';
import type { AccountState, ProviderProfile, TurnId } from '@wevir/protocol';
import { useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '../i18n';
import { clockLabel, continuityView, modelLabel } from '../lib/continuity';
import { RADIUS, SPACE, TEXT, type Theme } from '../theme';
import { SourceIcon } from './source-icon';
import { Button, Icon } from './ui';

export interface ContinuityContext {
  providers: readonly ProviderProfile[];
  accounts?: readonly AccountState[];
  autoContinue?: AutoContinueState;
  cancelAutoContinue?: (turnId: TurnId) => Promise<void>;
}

export function HandoffRow({
  notice,
  context,
  theme,
}: {
  notice: ContinuityNotice;
  context: ContinuityContext;
  theme: Theme;
}) {
  const [open, setOpen] = useState(false);
  const insets = useSafeAreaInsets();
  const view = continuityView(notice, context.providers, context.accounts);
  const color = notice.reason === 'usage_limit' ? theme.running : theme.mutedForeground;
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          notice.reason === 'usage_limit'
            ? `${view.label} · ${t('handoff.reason.usage_limit')}`
            : view.label
        }
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(true)}
        style={({ pressed }) => [styles.transition, { opacity: pressed ? 0.6 : 1 }]}
        testID="handoff-notice"
      >
        <SourceIcon provider={view.from} color={color} />
        <Text style={[styles.transitionText, { color }]} numberOfLines={1}>
          {view.label}
        </Text>
        <SourceIcon provider={view.to} color={color} />
        {notice.reason === 'usage_limit' && (
          <Icon name={{ ios: 'arrow.triangle.branch', android: 'route' }} size={15} color={color} />
        )}
        <Icon name={{ ios: 'chevron.right', android: 'chevron_right' }} size={12} color={color} />
      </Pressable>
      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setOpen(false)}
      >
        <View
          style={[
            styles.detail,
            {
              backgroundColor: theme.background,
              paddingTop: Platform.OS === 'ios' ? SPACE.page : insets.top + SPACE.page,
              paddingBottom: insets.bottom,
            },
          ]}
        >
          <View style={styles.detailHeader}>
            <Text style={[styles.title, { color: theme.foreground }]}>
              {t('handoff.detail.title')}
            </Text>
            <Button kind="secondary" title={t('continuity.close')} onPress={() => setOpen(false)} />
          </View>
          <ScrollView contentContainerStyle={styles.detailBody} testID="handoff-detail">
            {view.rows.map((row) => (
              <View key={row.key} style={styles.detailRow}>
                <Text style={[styles.label, styles.detailLabel, { color: theme.mutedForeground }]}>
                  {row.label}
                </Text>
                <Text
                  selectable
                  style={[
                    styles.value,
                    styles.detailValue,
                    {
                      color:
                        row.tone === 'warning'
                          ? theme.warning
                          : row.tone === 'success'
                            ? theme.success
                            : theme.foreground,
                    },
                  ]}
                >
                  {row.value}
                </Text>
              </View>
            ))}
            {notice.at !== undefined && (
              <Text style={[styles.caption, { color: theme.mutedForeground }]}>
                {clockLabel(notice.at)}
              </Text>
            )}
            {notice.kind === 'handoff' && notice.context !== undefined && (
              <View style={styles.context}>
                <Text style={[styles.label, { color: theme.mutedForeground }]}>
                  {t('handoff.detail.context')}
                </Text>
                <Text selectable style={[styles.value, { color: theme.foreground }]}>
                  {notice.context}
                </Text>
              </View>
            )}
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}

export function UsageLimitCard({
  part,
  context,
  theme,
}: {
  part: ChatPartOf<'error'>;
  context: ContinuityContext;
  theme: Theme;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const { armed } = usageLimitState(part, context.autoContinue);
  const limit = part.usageLimit;
  if (limit === undefined) return null;
  const cancel = async () => {
    if (!armed || !context.cancelAutoContinue) return;
    setBusy(true);
    setFailed(false);
    try {
      await context.cancelAutoContinue(armed.turnId);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View
      style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}
      testID="usage-limit-card"
    >
      <View style={styles.cardHeader}>
        <Icon
          name={{ ios: 'gauge.with.dots.needle.100percent', android: 'speed' }}
          size={18}
          color={theme.warning}
        />
        <Text style={[styles.title, { color: theme.foreground }]}>{t('usageLimit.title')}</Text>
      </View>
      <Text style={[styles.caption, { color: theme.mutedForeground }]}>
        {limit.resetsAt === undefined
          ? t('usageLimit.resetUnknown')
          : t('usageLimit.resets', { time: clockLabel(limit.resetsAt) })}
      </Text>
      <Text
        style={[styles.value, { color: part.routedTo ? theme.running : theme.mutedForeground }]}
      >
        {part.routedTo
          ? t('usageLimit.routed', {
              target: modelLabel(context.providers, part.routedTo, context.accounts),
            })
          : t('usageLimit.notRouted')}
      </Text>
      <Text style={[styles.value, { color: theme.mutedForeground }]} testID="usage-limit-schedule">
        {armed
          ? t('usageLimit.resumeAt', { time: clockLabel(armed.resumeAt) })
          : t('usageLimit.notScheduled')}
      </Text>
      {part.resumedAt !== undefined && (
        <Text style={[styles.caption, { color: theme.mutedForeground }]}>
          {t('usageLimit.resumed', { time: clockLabel(part.resumedAt) })}
        </Text>
      )}
      {armed && context.cancelAutoContinue && (
        <Button
          kind="secondary"
          title={t('usageLimit.cancel')}
          disabled={busy}
          onPress={() => void cancel()}
        />
      )}
      {failed && (
        <Text style={[styles.caption, { color: theme.destructive }]}>
          {t('usageLimit.cancelFailed')}
        </Text>
      )}
      <Text selectable style={[styles.caption, { color: theme.mutedForeground }]}>
        {part.message}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  transition: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 12,
    minHeight: 44,
  },
  transitionText: { fontSize: TEXT.caption, flexShrink: 1 },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: RADIUS.card,
    borderCurve: 'continuous',
    padding: 16,
    gap: 10,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: TEXT.title, fontWeight: '600', flexShrink: 1 },
  caption: { fontSize: TEXT.caption, lineHeight: 18 },
  value: { fontSize: TEXT.small, lineHeight: 21, flexShrink: 1 },
  label: { fontSize: TEXT.small, lineHeight: 21 },
  detail: { flex: 1, paddingHorizontal: SPACE.page },
  detailHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingBottom: 16,
  },
  detailBody: { gap: 10, paddingBottom: SPACE.section },
  detailRow: { flexDirection: 'row', gap: 16 },
  detailLabel: { width: 104 },
  detailValue: { flex: 1 },
  context: { gap: 8, paddingTop: 8 },
});
