// 对话底部的输入栏：iOS 26 是浮在内容上的玻璃胶囊，Android 与旧 iOS 是同形状的实底。空着时尾部是语音（系统键盘的听写就是语音
// 输入，这枚以后做，先不可按），有字时换成墨色的发送按钮。会话页另外用到：前面一枚加照片的按钮、上面一排待发的照片、回合进行中
// 写着“插话 / 排队”的切换（点一下换成另一种，同桌面窄输入框），以及空着时的停止按钮。

import type { PendingDelivery } from '@wevir/protocol';
import { GlassView } from 'expo-glass-effect';
import * as Haptics from 'expo-haptics';
import { useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { t } from '../i18n';
import { TEXT, useTheme } from '../theme';
import { GLASS, Icon } from './ui';

export interface ComposerAttachment {
  key: string;
  uri: string;
  /** 还在上传。 */
  uploading: boolean;
}

export function Composer({
  onSend,
  disabled = false,
  placeholder,
  onAttach,
  attachments = [],
  onRemoveAttachment,
  busy = false,
  onStop,
  delivery,
  onDeliveryChange,
}: {
  onSend: (text: string) => Promise<void>;
  disabled?: boolean;
  placeholder?: string;
  /** 给了就在前面放一枚加照片的按钮。 */
  onAttach?: () => void;
  attachments?: readonly ComposerAttachment[];
  onRemoveAttachment?: (key: string) => void;
  /** 回合在跑：空着时尾部是停止，发出的消息按 `delivery` 送达。 */
  busy?: boolean;
  onStop?: () => Promise<void>;
  delivery?: PendingDelivery;
  onDeliveryChange?: (delivery: PendingDelivery) => void;
}) {
  const theme = useTheme();
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  // 高度跟着内容：多行发出后清空时 iOS 的多行输入框不会自己缩回去。
  const [height, setHeight] = useState(INPUT_MIN);
  const uploading = attachments.some((a) => a.uploading);
  const empty = text.trim() === '' && attachments.length === 0;

  const send = () => {
    if (empty || sending || uploading) return;
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

  const stop = () => {
    if (onStop === undefined || stopping) return;
    setStopping(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
    onStop()
      .catch((error: unknown) => console.warn('[wevir] could not stop', error))
      .finally(() => setStopping(false));
  };

  const action = !empty ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('bot.send')}
      onPress={send}
      disabled={sending || uploading || disabled}
      hitSlop={6}
      style={({ pressed }) => [
        styles.action,
        styles.send,
        {
          backgroundColor: theme.primary,
          opacity: pressed || sending || uploading ? 0.6 : 1,
        },
      ]}
      testID="composer-send"
    >
      <Icon
        name={{ ios: 'arrow.up', android: 'arrow_upward' }}
        size={17}
        weight="bold"
        color={theme.primaryForeground}
      />
    </Pressable>
  ) : busy && onStop !== undefined ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('session.stop')}
      onPress={stop}
      disabled={stopping || disabled}
      hitSlop={6}
      style={({ pressed }) => [
        styles.action,
        styles.send,
        { backgroundColor: theme.primary, opacity: pressed || stopping ? 0.6 : 1 },
      ]}
      testID="composer-stop"
    >
      <Icon
        name={{ ios: 'stop.fill', android: 'stop' }}
        size={14}
        color={theme.primaryForeground}
      />
    </Pressable>
  ) : (
    <View
      accessibilityRole="button"
      accessibilityLabel={t('bot.voice')}
      accessibilityState={{ disabled: true }}
      style={[styles.action, { opacity: 0.4 }]}
    >
      <Icon name={{ ios: 'mic', android: 'mic' }} size={20} color={theme.foreground} />
    </View>
  );

  const content = (
    <View style={styles.column}>
      {attachments.length > 0 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.attachments}
          keyboardShouldPersistTaps="handled"
        >
          {attachments.map((attachment) => (
            <View key={attachment.key} style={styles.thumbWrap}>
              <Image
                source={{ uri: attachment.uri }}
                style={[styles.thumb, { backgroundColor: theme.muted }]}
              />
              {attachment.uploading ? (
                <View style={styles.thumbOverlay}>
                  <ActivityIndicator size="small" color="#ffffff" />
                </View>
              ) : (
                onRemoveAttachment !== undefined && (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('composer.removePhoto')}
                    hitSlop={8}
                    onPress={() => onRemoveAttachment(attachment.key)}
                    style={[styles.remove, { backgroundColor: theme.foreground }]}
                  >
                    <Icon
                      name={{ ios: 'xmark', android: 'close' }}
                      size={10}
                      weight="bold"
                      color={theme.background}
                    />
                  </Pressable>
                )
              )}
            </View>
          ))}
        </ScrollView>
      )}
      <View style={styles.row}>
        {onAttach !== undefined && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('composer.addPhoto')}
            onPress={onAttach}
            disabled={disabled}
            hitSlop={6}
            style={({ pressed }) => [styles.action, { opacity: pressed || disabled ? 0.5 : 1 }]}
            testID="composer-attach"
          >
            <Icon name={{ ios: 'plus', android: 'add' }} size={20} color={theme.foreground} />
          </Pressable>
        )}
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={placeholder ?? t('bot.message')}
          placeholderTextColor={theme.mutedForeground}
          editable={!disabled}
          multiline
          onContentSizeChange={(e) => setHeight(e.nativeEvent.contentSize.height)}
          style={[
            styles.input,
            onAttach !== undefined && styles.inputAfterAttach,
            {
              color: theme.foreground,
              height: Math.min(INPUT_MAX, Math.max(INPUT_MIN, Math.ceil(height))),
            },
          ]}
          selectionColor={theme.foreground}
          submitBehavior="newline"
          testID="composer-input"
        />
        {busy && delivery !== undefined && onDeliveryChange !== undefined && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t(`composer.delivery.${delivery}`)}
            onPress={() => {
              void Haptics.selectionAsync().catch(() => {});
              onDeliveryChange(delivery === 'steer' ? 'queue' : 'steer');
            }}
            hitSlop={4}
            style={({ pressed }) => [
              styles.delivery,
              { backgroundColor: theme.muted, opacity: pressed ? 0.6 : 1 },
            ]}
            testID="composer-delivery"
          >
            <Icon
              name={{ ios: 'arrow.left.arrow.right', android: 'swap_horiz' }}
              size={11}
              weight="semibold"
              color={theme.softForeground}
            />
            <Text style={[styles.deliveryText, { color: theme.foreground }]}>
              {t(`composer.delivery.${delivery}`)}
            </Text>
          </Pressable>
        )}
        {action}
      </View>
    </View>
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

const INPUT_MIN = 38;
const INPUT_MAX = 132;

const styles = StyleSheet.create({
  bar: {
    minHeight: 50,
    borderRadius: 25,
    borderCurve: 'continuous',
    paddingLeft: 6,
    paddingRight: 6,
    paddingVertical: 6,
  },
  column: { gap: 6 },
  row: { flexDirection: 'row', alignItems: 'flex-end' },
  shadow: { boxShadow: '0 2px 12px rgba(26, 26, 23, 0.08)' },
  input: {
    flex: 1,
    fontSize: TEXT.body,
    lineHeight: 21,
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 8,
  },
  inputAfterAttach: { paddingLeft: 2 },
  action: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  send: { borderRadius: 19 },
  delivery: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 28,
    paddingHorizontal: 10,
    borderRadius: 14,
    marginBottom: 5,
    marginRight: 6,
  },
  deliveryText: { fontSize: TEXT.caption, fontWeight: '600' },
  attachments: { gap: 8, paddingHorizontal: 6, paddingTop: 4 },
  thumbWrap: { width: 56, height: 56 },
  thumb: { width: 56, height: 56, borderRadius: 12, borderCurve: 'continuous' },
  thumbOverlay: {
    ...StyleSheet.absoluteFill,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.35)',
  },
  remove: {
    position: 'absolute',
    top: -4,
    right: -4,
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
