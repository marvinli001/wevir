// 对话底部的输入栏：iOS 26 是浮在内容上的玻璃胶囊，Android 与旧 iOS 是同形状的实底。空着时尾部是听写，有字时换成墨色的发送按钮
// （听写挪到它左边）。会话页与助理页另外用到：前面一枚加照片的按钮、上面一排待发的照片、回合进行中写着“插话 / 排队”的切换（点一下
// 换成另一种，同桌面窄输入框），以及空着时的停止按钮。
// 听写（Host 有 `speech` 时，state/dictation.ts）：点麦克风开始录音，输入框换成录音条（红点与计时），前面 ✕ 丢掉、尾部 ✓ 结束并
// 转写，文字放到光标处，不自动发送。不能听写时麦克风灰着。

import type { PendingDelivery } from '@wevir/protocol';
import { GlassView } from 'expo-glass-effect';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
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
import { type MessageKey, t } from '../i18n';
import { insertDictation, type SpeechClient } from '../lib/dictation';
import { type Dictation, useDictation } from '../state/dictation';
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
  speech,
  sessionId,
  onDictationError,
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
  /** 给了就能听写（Host 支持 `speech`）。 */
  speech?: SpeechClient;
  /** 会话页：Host 开着润色时用这个会话的模型。 */
  sessionId?: string;
  /** 听写失败（`undefined`：清掉上一条）。 */
  onDictationError?: (key: MessageKey | undefined) => void;
}) {
  const theme = useTheme();
  const [text, setText] = useState('');
  const cursor = useRef(0);
  const dictation = useDictation({
    client: speech,
    ...(sessionId !== undefined && { sessionId }),
    onText: (transcript) =>
      setText((current) => {
        const next = insertDictation(current, Math.min(cursor.current, current.length), transcript);
        cursor.current = next.cursor;
        return next.text;
      }),
    onError: (key) => onDictationError?.(key),
  });
  const dictating = dictation.phase !== 'idle';
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  // 高度跟着内容：多行发出后清空时 iOS 的多行输入框不会自己缩回去。
  const [height, setHeight] = useState(INPUT_MIN);
  const uploading = attachments.some((a) => a.uploading);
  const empty = text.trim() === '' && attachments.length === 0;

  const send = () => {
    if (empty || sending || uploading || dictating) return;
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

  const mic = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('dictation.start')}
      accessibilityState={{ disabled: !dictation.available || disabled }}
      onPress={dictation.start}
      disabled={!dictation.available || disabled}
      hitSlop={6}
      style={({ pressed }) => [
        styles.action,
        { opacity: !dictation.available || disabled ? 0.4 : pressed ? 0.5 : 1 },
      ]}
      testID="composer-mic"
    >
      <Icon name={{ ios: 'mic', android: 'mic' }} size={20} color={theme.foreground} />
    </Pressable>
  );

  const action = dictating ? (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        dictation.phase === 'transcribing' ? t('dictation.transcribing') : t('dictation.stop')
      }
      onPress={dictation.stop}
      disabled={dictation.phase !== 'recording'}
      hitSlop={6}
      style={({ pressed }) => [
        styles.action,
        styles.send,
        { backgroundColor: theme.primary, opacity: pressed ? 0.6 : 1 },
      ]}
      testID="composer-dictation-stop"
    >
      {dictation.phase === 'recording' ? (
        <Icon
          name={{ ios: 'checkmark', android: 'check' }}
          size={16}
          weight="bold"
          color={theme.primaryForeground}
        />
      ) : (
        <ActivityIndicator size="small" color={theme.primaryForeground} />
      )}
    </Pressable>
  ) : !empty ? (
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
    mic
  );
  // 有字或回合在跑时尾部是发送 / 停止，听写挪到它左边；不能听写时不占位置。
  const micBeside = !dictating && (!empty || (busy && onStop !== undefined)) && dictation.available;

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
        {dictating ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t('dictation.cancel')}
            onPress={dictation.cancel}
            hitSlop={6}
            style={({ pressed }) => [styles.action, { opacity: pressed ? 0.5 : 1 }]}
            testID="composer-dictation-cancel"
          >
            <Icon name={{ ios: 'xmark', android: 'close' }} size={17} color={theme.foreground} />
          </Pressable>
        ) : (
          onAttach !== undefined && (
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
          )
        )}
        {dictating && <RecordingBar dictation={dictation} />}
        <TextInput
          value={text}
          onChangeText={setText}
          onSelectionChange={(e) => {
            cursor.current = e.nativeEvent.selection.end;
          }}
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
            dictating && styles.hidden,
          ]}
          selectionColor={theme.foreground}
          submitBehavior="newline"
          testID="composer-input"
        />
        {busy && !dictating && delivery !== undefined && onDeliveryChange !== undefined && (
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
        {micBeside && mic}
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

/** 录音条：红点与计时；转写时是“正在转写…”。 */
function RecordingBar({ dictation }: { dictation: Dictation }) {
  const theme = useTheme();
  const [now, setNow] = useState(Date.now());
  const recording = dictation.phase === 'recording';
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [recording]);
  const seconds = Math.max(0, Math.floor((now - (dictation.startedAt ?? now)) / 1000));
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  return (
    <View style={styles.recording} testID="composer-recording">
      {recording && <View style={[styles.dot, { backgroundColor: theme.destructive }]} />}
      <Text
        style={[
          styles.recordingText,
          { color: recording ? theme.foreground : theme.mutedForeground },
        ]}
      >
        {dictation.phase === 'transcribing' ? t('dictation.transcribing') : recording ? clock : ''}
      </Text>
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
  // 录音时输入框留着（字与光标不丢），只是不显示。
  hidden: { position: 'absolute', opacity: 0, width: 0, height: 0 },
  recording: {
    flex: 1,
    height: 38,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 8,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  recordingText: { fontSize: TEXT.body, fontVariant: ['tabular-nums'] },
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
