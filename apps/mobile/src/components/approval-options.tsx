import type { ApprovalOption } from '@wevir/protocol';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { t } from '../i18n';
import { approvalChoices, approvalLabel } from '../lib/approval-options';
import { useRegistry } from '../state/registry';
import { useTheme } from '../theme';
import { Button, Icon } from './ui';

export function ApprovalOptions({
  options,
  computer,
  disabled,
  allowDisabled,
  risky,
  onChoose,
}: {
  computer?: string | undefined;
  options: readonly ApprovalOption[];
  disabled: boolean;
  allowDisabled: boolean;
  risky: boolean;
  onChoose: (id: string) => void;
}) {
  const theme = useTheme();
  const registry = useRegistry();
  const access = computer ? registry.link(computer)?.sessions : undefined;
  const [expanded, setExpanded] = useState(false);
  const { primary, other } = approvalChoices(options);
  const button = (option: ApprovalOption) => {
    const allow = option.category === 'allow';
    const unavailable =
      disabled ||
      !access?.canWrite ||
      (allow && allowDisabled) ||
      (option.optionId.startsWith('codex-policy-') && !access.canWritePolicy);
    const emphasis = primary.includes(option) && allow;
    const color = emphasis ? theme.primaryForeground : theme.foreground;
    const label = approvalLabel(option, options);
    return (
      <Pressable
        key={option.optionId}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled: unavailable }}
        disabled={unavailable}
        onPress={() => onChoose(option.optionId)}
        style={({ pressed }) => [
          styles.choice,
          {
            backgroundColor: emphasis ? theme.primary : theme.muted,
            opacity: unavailable ? 0.4 : pressed ? 0.65 : 1,
          },
        ]}
      >
        {allow && risky && (
          <Icon name={{ ios: 'faceid', android: 'fingerprint' }} size={16} color={color} />
        )}
        <Text style={{ color, flexShrink: 1, fontWeight: '600', textAlign: 'center' }}>
          {label}
        </Text>
      </Pressable>
    );
  };
  return (
    <View style={styles.options}>
      {primary.length > 0 && (
        <View style={styles.row}>
          {primary.map((option) => (
            <View key={option.optionId} style={styles.cell}>
              {button(option)}
            </View>
          ))}
        </View>
      )}
      {other.length > 0 && primary.length > 0 && (
        <Button
          kind="secondary"
          title={t('approval.otherDecisions')}
          disabled={disabled}
          icon={
            expanded
              ? { ios: 'chevron.up', android: 'expand_less' }
              : { ios: 'chevron.down', android: 'expand_more' }
          }
          onPress={() => setExpanded(!expanded)}
        />
      )}
      {(expanded || !primary.length) && other.map(button)}
    </View>
  );
}

const styles = StyleSheet.create({
  choice: {
    minHeight: 46,
    borderRadius: 20,
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  options: { gap: 6 },
  row: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  cell: { flex: 1, minWidth: 110 },
});
