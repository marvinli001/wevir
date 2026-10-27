// 变更里的一个文件：标题是文件名，下面一行是目录与在列表里的位置；内容是这个文件的 diff，或经 `files.read` 分块读的完整文件
// （滚到底读下一块）。底部浮着“上一个 / 差异·完整文件 / 下一个”，按文件翻页。

import type { DiffFile, SessionId } from '@wevir/protocol';
import { GlassView } from 'expo-glass-effect';
import * as Haptics from 'expo-haptics';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { type ReactElement, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CodeView, Counts } from '../../../components/code-view';
import { GLASS, Icon, type IconName, Segmented } from '../../../components/ui';
import { type MessageKey, t } from '../../../i18n';
import { type ChangesClient, PROBLEM_TEXT, problemOf } from '../../../lib/changes';
import { type DiffRow, filePage, noDiffReason, splitPath } from '../../../lib/diff';
import { ChunkedFile, FILE_MAX_LINES, type FileView } from '../../../lib/file-reader';
import { useChanges } from '../../../state/changes';
import { SPACE, TEXT, type Theme, useTheme } from '../../../theme';

type Mode = 'diff' | 'file';

const BAR_HEIGHT = 48;

export default function ChangedFileScreen() {
  const { key, path } = useLocalSearchParams<{ key: string; path: string }>();
  const router = useRouter();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const state = useChanges(key, { reuse: true });
  const [mode, setMode] = useState<Mode>('diff');
  const files = state.changes?.files ?? [];
  const file = files.find((f) => f.path === path);
  const rows = state.changes?.rows.get(path) ?? NO_ROWS;
  const page = filePage(files, path);
  const { name, dir } = splitPath(path);
  const bottomInset = BAR_HEIGHT + insets.bottom + 16;

  const go = (next: string | undefined) => {
    if (next === undefined) return;
    void Haptics.selectionAsync().catch(() => {});
    router.setParams({ path: next });
  };

  const subtitle = [
    dir === '' ? undefined : dir.slice(0, -1),
    page !== undefined
      ? t('changes.position', { index: page.index + 1, count: page.count })
      : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(' · ');

  const header = (
    <View style={styles.header}>
      {subtitle !== '' && (
        <Text
          style={[styles.meta, { color: theme.mutedForeground }]}
          numberOfLines={1}
          ellipsizeMode="head"
        >
          {subtitle}
        </Text>
      )}
      {file !== undefined && (file.added !== undefined || file.removed !== undefined) && (
        <Text style={[styles.meta, { color: theme.mutedForeground }]}>
          <Counts added={file.added} removed={file.removed} theme={theme} />
        </Text>
      )}
    </View>
  );

  let body: ReactNode;
  if (state.changes === undefined) {
    body =
      state.problem !== undefined || state.offline ? (
        <Placeholder text={t(PROBLEM_TEXT[state.problem ?? 'failed'])} theme={theme} />
      ) : (
        <Placeholder theme={theme} />
      );
  } else if (mode === 'diff') {
    const reason = file !== undefined ? noDiffReason(file, rows) : undefined;
    body =
      reason !== undefined ? (
        <Placeholder header={header} text={t(REASON_TEXT[reason])} theme={theme} />
      ) : (
        <CodeView
          key={`diff:${path}`}
          rows={rows}
          mode="diff"
          theme={theme}
          header={header}
          bottomInset={bottomInset}
        />
      );
  } else {
    body =
      state.client !== undefined && file !== undefined ? (
        <FullFile
          key={`file:${path}`}
          client={state.client}
          sessionId={state.sessionId}
          file={file}
          header={header}
          theme={theme}
          bottomInset={bottomInset}
        />
      ) : (
        <Placeholder text={t('changes.file.failed')} theme={theme} />
      );
  }

  return (
    <>
      <Stack.Screen options={{ title: name, headerLargeTitleEnabled: false }} />
      <View style={styles.page}>{body}</View>
      <View style={[styles.bar, { bottom: insets.bottom + 8 }]} pointerEvents="box-none">
        <RoundButton
          icon={{ ios: 'chevron.left', android: 'chevron_left' }}
          label={t('changes.previous')}
          disabled={page?.previous === undefined}
          onPress={() => go(page?.previous)}
          theme={theme}
        />
        <View style={styles.segments}>
          <Segmented<Mode>
            options={[
              { value: 'diff', label: t('changes.view.diff') },
              { value: 'file', label: t('changes.view.file') },
            ]}
            value={mode}
            onChange={setMode}
          />
        </View>
        <RoundButton
          icon={{ ios: 'chevron.right', android: 'chevron_right' }}
          label={t('changes.next')}
          disabled={page?.next === undefined}
          onPress={() => go(page?.next)}
          theme={theme}
        />
      </View>
    </>
  );
}

const NO_ROWS: DiffRow[] = [];

const REASON_TEXT: Record<'binary' | 'too_large' | 'empty', MessageKey> = {
  binary: 'changes.binary',
  too_large: 'changes.tooLarge',
  empty: 'changes.noContent',
};

function FullFile({
  client,
  sessionId,
  file,
  header,
  theme,
  bottomInset,
}: {
  client: ChangesClient;
  sessionId: SessionId;
  file: DiffFile;
  header: ReactElement;
  theme: Theme;
  bottomInset: number;
}) {
  const reader = useRef<ChunkedFile | undefined>(undefined);
  const [view, setView] = useState<FileView | undefined>(undefined);
  const [error, setError] = useState<MessageKey | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const deleted = file.status === 'deleted';

  const readMore = () => {
    const current = reader.current;
    if (current === undefined || current.done) return;
    setLoading(true);
    current
      .next()
      .then((next) => {
        if (reader.current === current) setView(next);
      })
      .catch((e: unknown) => {
        if (reader.current !== current) return;
        setError(problemOf(e) === 'forbidden' ? 'changes.forbidden' : 'changes.file.failed');
      })
      .finally(() => {
        if (reader.current === current) setLoading(false);
      });
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在换文件（组件按路径重建）时开始读。
  useEffect(() => {
    if (deleted) return;
    if (!client.canRead) {
      setError('changes.forbidden');
      return;
    }
    if (!client.supportsFiles) {
      setError('changes.file.unsupported');
      return;
    }
    const current = new ChunkedFile((params) => client.request('files.read', params), {
      sessionId,
      path: file.path,
    });
    reader.current = current;
    readMore();
    return () => {
      reader.current = undefined;
    };
  }, []);

  const rows = useMemo<DiffRow[]>(
    () => (view?.lines ?? []).map((text, index) => ({ kind: 'context', text, newLine: index + 1 })),
    [view?.lines],
  );

  if (deleted || error !== undefined || view?.binary === true) {
    return (
      <Placeholder
        header={header}
        text={t(deleted ? 'changes.file.deleted' : (error ?? 'changes.binary'))}
        theme={theme}
      />
    );
  }
  if (view === undefined) {
    return <Placeholder header={header} theme={theme} />;
  }
  const notes: string[] = [];
  if (view.capped) notes.push(t('changes.file.capped', { count: FILE_MAX_LINES }));
  if (view.changed) notes.push(t('changes.file.changed'));
  return (
    <CodeView
      rows={rows}
      mode="file"
      theme={theme}
      header={header}
      bottomInset={bottomInset}
      onEndReached={readMore}
      footer={
        loading ? (
          <ActivityIndicator style={styles.more} color={theme.mutedForeground} />
        ) : notes.length > 0 ? (
          <Text style={[styles.note, { color: theme.mutedForeground }]}>{notes.join(' · ')}</Text>
        ) : null
      }
    />
  );
}

/** 没有代码可显示时：文件头加一行说明，没给说明时是转圈。放在滚动视图里，iOS 上才会让出透明导航栏的高度。 */
function Placeholder({
  header,
  text,
  theme,
}: {
  header?: ReactElement;
  text?: string;
  theme: Theme;
}) {
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic">
      {header}
      {text !== undefined ? (
        <Text style={[styles.message, { color: theme.mutedForeground }]}>{text}</Text>
      ) : (
        <ActivityIndicator style={styles.loading} color={theme.mutedForeground} />
      )}
    </ScrollView>
  );
}

function RoundButton({
  icon,
  label,
  disabled,
  onPress,
  theme,
}: {
  icon: IconName;
  label: string;
  disabled: boolean;
  onPress: () => void;
  theme: Theme;
}) {
  const glyph = (
    <Icon
      name={icon}
      size={Platform.OS === 'android' ? 24 : 17}
      weight="semibold"
      color={theme.foreground}
    />
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      android_ripple={{ color: theme.borderStrong, borderless: true, radius: 24 }}
      style={{ opacity: disabled ? 0.35 : 1 }}
    >
      {GLASS ? (
        <GlassView isInteractive={!disabled} glassEffectStyle="regular" style={styles.round}>
          {glyph}
        </GlassView>
      ) : (
        <View style={[styles.round, { backgroundColor: theme.muted }]}>{glyph}</View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  header: { paddingHorizontal: SPACE.page + 4, paddingTop: 4, paddingBottom: 10, gap: 2 },
  meta: { fontSize: TEXT.caption, fontVariant: ['tabular-nums'] },
  loading: { marginTop: 48 },
  more: { marginVertical: 16 },
  note: { fontSize: TEXT.caption, paddingHorizontal: SPACE.page + 4, paddingVertical: 12 },
  message: {
    fontSize: TEXT.small,
    textAlign: 'center',
    marginTop: 48,
    paddingHorizontal: SPACE.page * 2,
  },
  bar: {
    position: 'absolute',
    left: SPACE.page,
    right: SPACE.page,
    height: BAR_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  segments: { flex: 1 },
  round: {
    width: BAR_HEIGHT,
    height: BAR_HEIGHT,
    borderRadius: BAR_HEIGHT / 2,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
});
