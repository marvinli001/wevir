// 一个会话的变更（只读）：大标题“变更”，下面一行是分支与对比的默认分支（没有时是“未提交”）、文件数与增删行数，再是改动的文件
// 列表（状态字母、文件名与目录、增删行数），点进去看那个文件的 diff。下拉重读。

import type { DiffFile } from '@wevir/protocol';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import {
  ActivityIndicator,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { Counts, statusColor } from '../../../components/code-view';
import { Button, Chevron, EmptyState, type IconName } from '../../../components/ui';
import { t } from '../../../i18n';
import { type ChangesProblem, PROBLEM_TEXT, statusLetter } from '../../../lib/changes';
import { splitPath } from '../../../lib/diff';
import { useChanges } from '../../../state/changes';
import { RADIUS, SPACE, TEXT, type Theme, useTheme } from '../../../theme';

export default function ChangesScreen() {
  const { key } = useLocalSearchParams<{ key: string }>();
  const router = useRouter();
  const theme = useTheme();
  const state = useChanges(key);
  const { changes, problem } = state;
  const files = changes?.files ?? [];
  const diff = changes?.diff;

  const meta = [
    diff?.branch,
    diff?.baseRef !== undefined
      ? t('changes.against', { base: diff.baseRef })
      : diff !== undefined
        ? t('changes.uncommitted')
        : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(' · ');

  return (
    <>
      <Stack.Screen options={{ title: t('changes.title'), headerLargeTitleEnabled: true }} />
      <FlatList
        data={files}
        keyExtractor={(file) => file.path}
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={state.loading && changes !== undefined}
            onRefresh={state.refresh}
            tintColor={theme.mutedForeground}
          />
        }
        ListHeaderComponent={
          diff !== undefined ? (
            <View style={styles.header}>
              {meta !== '' && (
                <Text
                  style={[styles.meta, { color: theme.mutedForeground }]}
                  numberOfLines={1}
                  ellipsizeMode="middle"
                >
                  {meta}
                </Text>
              )}
              {files.length > 0 && (
                <Text style={[styles.meta, { color: theme.mutedForeground }]}>
                  {t('changes.files', { count: diff.fileCount ?? files.length })}
                  {'  '}
                  <Counts added={diff.added} removed={diff.removed} theme={theme} />
                </Text>
              )}
            </View>
          ) : undefined
        }
        ListEmptyComponent={
          changes !== undefined ? (
            <EmptyState
              icon={{ ios: 'checkmark.circle', android: 'check_circle' }}
              title={t('changes.empty')}
            />
          ) : problem !== undefined ? (
            <Problem problem={problem} onRetry={state.refresh} />
          ) : state.offline ? (
            <Text style={[styles.emptyText, { color: theme.mutedForeground }]}>
              {t('thread.unavailable')}
            </Text>
          ) : (
            <ActivityIndicator style={styles.loading} color={theme.mutedForeground} />
          )
        }
        ListFooterComponent={
          diff?.truncated === true ? (
            <Text style={[styles.footer, { color: theme.mutedForeground }]}>
              {t('changes.truncated')}
            </Text>
          ) : undefined
        }
        renderItem={({ item, index }) => (
          <FileRow
            file={item}
            first={index === 0}
            last={index === files.length - 1}
            theme={theme}
            onPress={() =>
              router.push({
                pathname: '/changes/[key]/file',
                params: { key, path: item.path },
              })
            }
          />
        )}
      />
    </>
  );
}

const PROBLEM_ICON: Record<ChangesProblem, IconName> = {
  forbidden: { ios: 'lock', android: 'lock' },
  unsupported: { ios: 'exclamationmark.circle', android: 'error' },
  not_repo: { ios: 'folder', android: 'folder' },
  failed: { ios: 'exclamationmark.triangle', android: 'warning' },
};

function Problem({ problem, onRetry }: { problem: ChangesProblem; onRetry: () => void }) {
  return (
    <View>
      <EmptyState icon={PROBLEM_ICON[problem]} title={t(PROBLEM_TEXT[problem])} />
      {problem === 'failed' && (
        <View style={styles.retry}>
          <Button
            kind="secondary"
            title={t('computer.retry')}
            icon={{ ios: 'arrow.clockwise', android: 'refresh' }}
            onPress={onRetry}
          />
        </View>
      )}
    </View>
  );
}

function FileRow({
  file,
  first,
  last,
  theme,
  onPress,
}: {
  file: DiffFile;
  first: boolean;
  last: boolean;
  theme: Theme;
  onPress: () => void;
}) {
  const { name, dir } = splitPath(file.path);
  const color = statusColor(theme, file.status);
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.card, borderColor: theme.dark ? theme.border : 'transparent' },
        first && styles.cardFirst,
        last && styles.cardLast,
      ]}
    >
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        android_ripple={{ color: theme.muted }}
        style={({ pressed }) => [
          styles.row,
          pressed && Platform.OS === 'ios' && { backgroundColor: theme.muted },
        ]}
      >
        <View style={[styles.letter, { backgroundColor: `${color}1f` }]}>
          <Text style={[styles.letterText, { color }]}>{statusLetter(file.status)}</Text>
        </View>
        <View style={styles.rowText}>
          <Text style={[styles.name, { color: theme.foreground }]} numberOfLines={1}>
            {name}
          </Text>
          {(dir !== '' || file.previousPath !== undefined) && (
            <Text
              style={[styles.dir, { color: theme.mutedForeground }]}
              numberOfLines={1}
              ellipsizeMode="head"
            >
              {file.previousPath !== undefined ? `${file.previousPath} →` : dir}
            </Text>
          )}
        </View>
        <Text style={styles.counts}>
          {file.binary === true ? (
            <Text style={{ color: theme.mutedForeground }}>{t('changes.binary')}</Text>
          ) : (
            <Counts added={file.added} removed={file.removed} theme={theme} />
          )}
        </Text>
        <Chevron color={theme.borderStrong} />
        {!last && <View style={[styles.separator, { backgroundColor: theme.border }]} />}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: SPACE.page, paddingTop: 4, paddingBottom: 64 },
  header: { paddingHorizontal: 4, paddingBottom: 12, gap: 2 },
  meta: { fontSize: TEXT.caption, fontVariant: ['tabular-nums'] },
  card: { overflow: 'hidden', borderLeftWidth: 1, borderRightWidth: 1, borderCurve: 'continuous' },
  cardFirst: {
    borderTopWidth: 1,
    borderTopLeftRadius: RADIUS.card,
    borderTopRightRadius: RADIUS.card,
  },
  cardLast: {
    borderBottomWidth: 1,
    borderBottomLeftRadius: RADIUS.card,
    borderBottomRightRadius: RADIUS.card,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingLeft: SPACE.page,
    paddingRight: 12,
    minHeight: 56,
    paddingVertical: 8,
  },
  letter: {
    width: 24,
    height: 24,
    borderRadius: 7,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
  },
  letterText: { fontSize: TEXT.caption, fontWeight: '700' },
  rowText: { flex: 1, gap: 1 },
  name: { fontSize: TEXT.body },
  dir: { fontSize: TEXT.caption },
  counts: { fontSize: TEXT.small, fontVariant: ['tabular-nums'] },
  separator: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    left: SPACE.page + 36,
    height: StyleSheet.hairlineWidth,
  },
  loading: { marginTop: 48 },
  emptyText: { fontSize: TEXT.small, textAlign: 'center', marginTop: 48 },
  footer: { fontSize: TEXT.caption, paddingHorizontal: 4, paddingTop: 12 },
  retry: { alignItems: 'center' },
});
