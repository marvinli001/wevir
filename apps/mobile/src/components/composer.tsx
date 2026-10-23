// 对话底部的输入栏：iOS 26 是浮在内容上的玻璃胶囊，Android 与旧 iOS 是同形状的实底。空着时尾部是语音（以后做，先不可按），
// 有字时换成墨色的发送按钮。

import { GlassView } from 'expo-glass-effect';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { t } from '../i18n';
import { TEXT, useTheme } from '../theme';
import { GLASS, Icon } from './ui';

export function Composer({
  onSend,
  disabled = false,
}: {
  onSend: (text: string) => Promise<void>;
  disabled?: boolean;
}) {
  const theme = useTheme();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const empty = text.trim() === '';

  const send = () => {
    if (empty || sending) return;
    const value = text;
    setSending(true);
    setText('');
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    onSend(value)
      .catch((error: unknown) => {
        console.warn('[wevir] could not send', error);
        setText(value);
      })
      .finally(() => setSending(false));
  };

  const content = (
    <>
      <TextInput
        value={text}
        onChangeText={setText}
        placeholder={t('bot.message')}
        placeholderTextColor={theme.mutedForeground}
        editable={!disabled}
        multiline
        style={[styles.input, { color: theme.foreground }]}
        selectionColor={theme.foreground}
        submitBehavior="newline"
      />
      {empty ? (
        <View
          accessibilityRole="button"
          accessibilityLabel={t('bot.voice')}
          accessibilityState={{ disabled: true }}
          style={[styles.action, { opacity: 0.4 }]}
        >
          <Icon name={{ ios: 'mic', android: 'mic' }} size={20} color={theme.foreground} />
        </View>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('bot.send')}
          onPress={send}
          disabled={sending}
          hitSlop={6}
          style={({ pressed }) => [
            styles.action,
            styles.send,
            { backgroundColor: theme.primary, opacity: pressed || sending ? 0.6 : 1 },
          ]}
        >
          <Icon
            name={{ ios: 'arrow.up', android: 'arrow_upward' }}
            size={17}
            weight="bold"
            color={theme.primaryForeground}
          />
        </Pressable>
      )}
    </>
  );

  if (GLASS) {
    return (
      <GlassView glassEffectStyle="regular" isInteractive style={styles.bar}>
        {content}
      </GlassView>
    );
  }
  return (
    <View
      style={[
        styles.bar,
        {
          backgroundColor: theme.card,
          borderColor: theme.border,
          borderWidth: StyleSheet.hairlineWidth,
        },
        !theme.dark && styles.shadow,
      ]}
    >
      {content}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    minHeight: 50,
    borderRadius: 25,
    borderCurve: 'continuous',
    paddingLeft: 6,
    paddingRight: 6,
    paddingVertical: 6,
  },
  shadow: { boxShadow: '0 2px 12px rgba(26, 26, 23, 0.08)' },
  input: {
    flex: 1,
    fontSize: TEXT.body,
    lineHeight: 21,
    maxHeight: 132,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 8,
  },
  action: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  send: { borderRadius: 19 },
});
