// 变更里的一个文件：标题是文件名，下面一行是目录与在列表里的位置；内容是这个文件的 diff，或经 `files.read` 分块读的完整文件
// （滚到底读下一块）。底部浮着“上一个 / 差异·完整文件 / 下一个”，按文件翻页。

import type { TurnId } from '@wevir/protocol';
import { GlassView } from 'expo-glass-effect';
import * as Haptics from 'expo-haptics';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { type ReactNode, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CodeView, Counts } from '../../../components/code-view';
import { FileContents, Placeholder } from '../../../components/file-contents';
import { RevisionFile } from '../../../components/revision-file';
import { GLASS, Icon, type IconName, Segmented } from '../../../components/ui';
import { type MessageKey, t } from '../../../i18n';
import { PROBLEM_TEXT } from '../../../lib/changes';
import { type DiffRow, filePage, noDiffReason, splitPath } from '../../../lib/diff';
import { useChanges } from '../../../state/changes';
import { SPACE, TEXT, type Theme, useTheme } from '../../../theme';

type Mode = 'diff' | 'file';

const BAR_HEIGHT = 48;

export default function ChangedFileScreen() {
  const { key, path, turn } = useLocalSearchParams<{ key: string; path: string; turn?: TurnId }>();
  const router = useRouter();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const state = useChanges(key, { reuse: true, turnId: turn });
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
      state.client && file && turn && (state.changes.diff.head || file.status === 'deleted') ? (
        <RevisionFile
          key={JSON.stringify([turn, path])}
          client={state.client}
          workspaceId={state.changes.workspaceId}
          sessionId={state.sessionId}
          path={file.status === 'deleted' ? (file.previousPath ?? path) : path}
          side={file.status === 'deleted' ? 'old' : 'new'}
          revision={file.status === 'deleted' ? state.changes.diff.base : state.changes.diff.head}
          header={header}
          bottomInset={bottomInset}
        />
      ) : state.client !== undefined && file !== undefined ? (
        <FileContents
          key={`file:${path}`}
          client={state.client}
          target={{ sessionId: state.sessionId, path: file.path }}
          deleted={file.status === 'deleted'}
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
