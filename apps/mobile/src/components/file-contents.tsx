import type { ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, Text } from 'react-native';
import { type MessageKey, t } from '../i18n';
import { type ChangesClient, problemOf } from '../lib/changes';
import type { DiffRow } from '../lib/diff';
import { ChunkedFile, FILE_MAX_LINES, type FileTarget, type FileView } from '../lib/file-reader';
import { SPACE, TEXT, type Theme } from '../theme';
import { CodeView } from './code-view';
import { Markdown } from './markdown';

export function FileContents({
  client,
  target,
  deleted = false,
  line,
  markdown = false,
  header,
  theme,
  bottomInset,
}: {
  client: ChangesClient;
  target: FileTarget;
  deleted?: boolean;
  line?: number | undefined;
  markdown?: boolean;
  header?: ReactElement;
  theme: Theme;
  bottomInset: number;
}) {
  const reader = useRef<ChunkedFile | undefined>(undefined);
  const [view, setView] = useState<FileView | undefined>(undefined);
  const [error, setError] = useState<MessageKey | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const { sessionId, workspaceId, artifactSeq, path } = target;

  const readMore = useCallback(() => {
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
  }, []);

  useEffect(() => {
    setView(undefined);
    setError(undefined);
    if (deleted) return;
    if (!client.canRead) {
      setError('changes.forbidden');
      return;
    }
    if (!client.supportsFiles) {
      setError('changes.file.unsupported');
      return;
    }
    const current = new ChunkedFile(
      (params) => client.request('files.read', params, { queue: false }),
      { sessionId, workspaceId, artifactSeq, path },
    );
    reader.current = current;
    readMore();
    return () => {
      reader.current = undefined;
    };
  }, [client, sessionId, workspaceId, artifactSeq, path, deleted, readMore]);

  useEffect(() => {
    if (line && view && !error && !loading && view.lines.length < line && !reader.current?.done)
      readMore();
  }, [line, view, loading, error, readMore]);

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
  if (markdown && view.eof && !view.capped && view.size <= 1024 * 1024)
    return (
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ padding: SPACE.page }}
      >
        <Markdown text={view.lines.join('\n')} />
      </ScrollView>
    );
  const notes: string[] = [];
  if (line && reader.current?.done && line > view.lines.length)
    notes.push(t('files.lineUnavailable'));
  if (view.capped) notes.push(t('changes.file.capped', { count: FILE_MAX_LINES }));
  if (view.changed) notes.push(t('changes.file.changed'));
  return (
    <CodeView
      rows={rows}
      focusLine={line}
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
export function Placeholder({
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

const styles = StyleSheet.create({
  loading: { marginTop: 48 },
  more: { marginVertical: 16 },
  note: { fontSize: TEXT.caption, paddingHorizontal: SPACE.page + 4, paddingVertical: 12 },
  message: {
    fontSize: TEXT.small,
    textAlign: 'center',
    marginTop: 48,
    paddingHorizontal: SPACE.page * 2,
  },
});
