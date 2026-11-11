// 出错与恢复（同桌面端 message-view.tsx 的 ErrorPart 与 recovery-panel.tsx）：消息流里引擎的错误是一张卡片（种类、原文、没有恢复
// 办法时一行提示），最新一个失败的回合可恢复时带“重试”或“继续生成”；会话出错或只读时输入框上方一块说明与能做的事——出错时
// “恢复会话”，只读时“基于历史新建会话”（Host 有 `session_from_history`）与“重试恢复”（导入的会话没有）。

import type { EngineErrorInfo, SessionReadOnly } from '@wevir/protocol';
import { useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { t } from '../i18n';
import type { SessionItem } from '../lib/session-items';
import { TEXT, type Theme } from '../theme';
import { Button, Icon } from './ui';

const MONO = Platform.select({ ios: 'Menlo', default: 'monospace' });

/** 同一时刻只跑一次；跑完（不管成败）再放开。 */
function useOnce(): [boolean, (action: () => Promise<void>) => void] {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const run = (action: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    void action().finally(() => {
      running.current = false;
      setBusy(false);
    });
  };
  return [busy, run];
}

export function ErrorCard({
  item,
  theme,
  onRetry,
}: {
  item: Extract<SessionItem, { kind: 'error' }>;
  theme: Theme;
  /** 这条错误能重试时有。 */
  onRetry: (() => Promise<void>) | undefined;
}) {
  const [busy, run] = useOnce();
  return (
    <View
      accessibilityRole="alert"
      style={[
        styles.card,
        { borderColor: `${theme.destructive}4d`, backgroundColor: `${theme.destructive}0d` },
      ]}
      testID="session-error-card"
    >
      <View style={styles.head}>
        <Icon
          name={{ ios: 'exclamationmark.circle', android: 'error' }}
          size={15}
          color={theme.destructive}
        />
        <Text style={[styles.title, { color: theme.destructive }]}>
          {t(`engineError.category.${item.category}`)}
        </Text>
      </View>
      <Text style={[styles.message, { color: theme.foreground }]} selectable>
        {item.text}
      </Text>
      {item.recovery === undefined && (
        <Text style={[styles.hint, { color: theme.mutedForeground }]}>
          {t(`engineError.hint.${item.category}`)}
        </Text>
      )}
      {onRetry !== undefined && (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={() => run(onRetry)}
          hitSlop={8}
          style={({ pressed }) => [
            styles.retry,
            { borderColor: theme.borderStrong, opacity: pressed || busy ? 0.6 : 1 },
          ]}
          testID="session-retry-turn"
        >
          {busy ? (
            <ActivityIndicator size="small" color={theme.foreground} />
          ) : (
            <Icon
              name={{ ios: 'arrow.clockwise', android: 'refresh' }}
              size={13}
              weight="semibold"
              color={theme.foreground}
            />
          )}
          <Text style={[styles.retryText, { color: theme.foreground }]}>
            {t(item.recovery === 'continue' ? 'engineError.continue' : 'engineError.retry')}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

/**
 * 输入框上方的恢复区：会话出错（不只读）或只读时有，别的时候不画。`onResume` 与 `onFromHistory` 失败时抛出，原因写在下面。
 */
export function RecoveryPanel({
  error,
  readOnly,
  lastError,
  disabled,
  theme,
  onResume,
  onFromHistory,
}: {
  error: boolean;
  readOnly: SessionReadOnly | undefined;
  lastError: EngineErrorInfo | undefined;
  /** 没连上或不能写。 */
  disabled: boolean;
  theme: Theme;
  onResume: () => Promise<void>;
  /** Host 没有 `session_from_history` 时没有。 */
  onFromHistory: (() => Promise<void>) | undefined;
}) {
  const [busy, run] = useOnce();
  const [failure, setFailure] = useState<string>();
  if (readOnly === undefined && !error) return null;
  const imported = readOnly?.reason === 'imported';
  const tone = imported
    ? theme.mutedForeground
    : readOnly !== undefined
      ? theme.destructive
      : theme.warning;
  const attempt = (
    action: () => Promise<void>,
    key: 'recovery.resumeFailed' | 'session.createFailed',
  ) =>
    run(async () => {
      setFailure(undefined);
      try {
        await action();
      } catch (e) {
        setFailure(t(key, { error: e instanceof Error ? e.message : String(e) }));
      }
    });
  return (
    <View
      style={[
        styles.panel,
        { borderColor: `${tone}4d`, backgroundColor: imported ? theme.card : `${tone}0d` },
      ]}
      testID="recovery-panel"
    >
      <View style={styles.head}>
        <Icon
          name={
            readOnly !== undefined
              ? { ios: 'lock', android: 'lock' }
              : { ios: 'exclamationmark.circle', android: 'error' }
          }
          size={15}
          color={imported ? theme.foreground : tone}
        />
        <Text style={[styles.title, { color: imported ? theme.foreground : tone }]}>
          {t(readOnly !== undefined ? 'recovery.readOnlyTitle' : 'recovery.errorTitle')}
        </Text>
      </View>
      {readOnly !== undefined ? (
        <>
          <Text style={[styles.body, { color: theme.foreground }]}>
            {t(`readOnly.${readOnly.reason}`)}
          </Text>
          {readOnly.message !== '' && (
            <Text style={[styles.mono, { color: theme.mutedForeground }]} numberOfLines={3}>
              {t('recovery.engineMessage', { message: readOnly.message })}
            </Text>
          )}
        </>
      ) : (
        lastError !== undefined && (
          <>
            <Text style={[styles.body, { color: theme.foreground }]} numberOfLines={3}>
              {`${t(`engineError.category.${lastError.category}`)}${t('common.colon')}${lastError.message}`}
            </Text>
            <Text style={[styles.hint, { color: theme.mutedForeground }]}>
              {t(`engineError.hint.${lastError.category}`)}
            </Text>
          </>
        )
      )}
      {failure !== undefined && (
        <Text style={[styles.hint, { color: theme.destructive }]} accessibilityRole="alert">
          {failure}
        </Text>
      )}
      <View style={styles.actions}>
        {readOnly !== undefined && onFromHistory !== undefined && (
          <Button
            title={t('recovery.fromHistory')}
            icon={{ ios: 'clock.arrow.circlepath', android: 'history' }}
            disabled={disabled || busy}
            onPress={() => attempt(onFromHistory, 'session.createFailed')}
          />
        )}
        {!imported && (
          <Button
            kind={readOnly !== undefined ? 'secondary' : 'primary'}
            title={
              busy
                ? t('recovery.resuming')
                : t(readOnly !== undefined ? 'recovery.retryResume' : 'recovery.resume')
            }
            icon={{ ios: 'arrow.counterclockwise', android: 'restart_alt' }}
            disabled={disabled || busy}
            onPress={() => attempt(onResume, 'recovery.resumeFailed')}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 14,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4,
  },
  panel: {
    borderRadius: 18,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 4,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { fontSize: TEXT.small, fontWeight: '600' },
  message: { fontFamily: MONO, fontSize: TEXT.caption, lineHeight: 18 },
  mono: { fontFamily: MONO, fontSize: TEXT.caption, lineHeight: 18 },
  body: { fontSize: TEXT.small, lineHeight: 20 },
  hint: { fontSize: TEXT.caption, lineHeight: 17 },
  retry: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 5,
    minHeight: 30,
    marginTop: 6,
    paddingHorizontal: 11,
    borderRadius: 15,
    borderWidth: StyleSheet.hairlineWidth,
  },
  retryText: { fontSize: TEXT.small, fontWeight: '600' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
});
