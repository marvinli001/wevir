import { useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { type MessageKey, t } from '../i18n';
import { sendErrorKey } from '../lib/session-actions';
import type { SessionItem } from '../lib/session-items';
import { RADIUS, TEXT, useTheme } from '../theme';
import { Button } from './ui';

export type SendDecision = (text: string, clientMessageId: string) => Promise<void>;

export function WrapUpCard({
  item,
  send,
}: {
  item: Extract<SessionItem, { kind: 'wrap-up' }>;
  send?: SendDecision | undefined;
}) {
  const theme = useTheme();
  const submitted = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey>();
  const choose = async (text: string) => {
    if (!send || submitted.current) return;
    submitted.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await send(text, `wrap-${item.turnId}-${item.seq}`);
    } catch (reason) {
      submitted.current = false;
      setBusy(false);
      setError(sendErrorKey(reason));
    }
  };
  return (
    <View
      style={[styles.card, { backgroundColor: theme.card, borderColor: theme.border }]}
      testID="session-wrap-up"
    >
      <Text style={{ color: theme.mutedForeground, fontSize: TEXT.small }}>{item.recap}</Text>
      <Text style={{ color: theme.foreground, fontSize: TEXT.body, fontWeight: '600' }}>
        {item.ask}
      </Text>
      {item.actions.map((action, index) => (
        <Button
          key={action.label}
          kind={index === 0 ? 'primary' : 'secondary'}
          title={action.label}
          disabled={!send || busy}
          onPress={() => void choose(action.message)}
        />
      ))}
      {error && (
        <Text accessibilityRole="alert" style={{ color: theme.foreground }}>
          {t(error)}
        </Text>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  card: { padding: 14, gap: 8, borderRadius: RADIUS.card, borderWidth: StyleSheet.hairlineWidth },
});
