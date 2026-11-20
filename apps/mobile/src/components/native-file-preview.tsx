import { randomUUID } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, View } from 'react-native';
import { type MessageKey, t } from '../i18n';
import { type ChangesClient, problemOf } from '../lib/changes';
import { decodeBase64, FILE_CHUNK_BYTES, type FileTarget } from '../lib/file-reader';
import { SPACE, useTheme } from '../theme';
import { Button } from './ui';

let clearedOldPreviews = false;

export function nativePreviewKind(name: string, mime?: string) {
  if (
    /^image\/(png|jpeg|gif|webp|bmp|heic|heif|avif)$/i.test(mime ?? '') ||
    /\.(png|jpe?g|gif|webp|bmp|heic|heif|avif)$/i.test(name)
  )
    return 'image';
  if (
    /^application\/pdf$|^(audio|video)\//i.test(mime ?? '') ||
    /\.(pdf|docx?|xlsx?|pptx?|od[stp]|rtf|mp[34]|m4[av]|mov|wav)$/i.test(name)
  )
    return 'document';
  return undefined;
}

export function NativeFilePreview({
  client,
  target,
  name,
  mime,
  image,
}: {
  client: ChangesClient | undefined;
  target: FileTarget;
  name: string;
  mime: string | undefined;
  image: boolean;
}) {
  const theme = useTheme();
  const [ready, setReady] = useState<File>();
  const [problem, setProblem] = useState<MessageKey>();
  const [opening, setOpening] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const live = useRef(false);
  const completed = useRef<Directory | undefined>(undefined);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      if (completed.current?.exists) completed.current.delete();
      completed.current = undefined;
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry starts a new download of this file.
  useEffect(() => {
    if (!client || completed.current) return;
    let current = true;
    setReady(undefined);
    setProblem(undefined);
    const root = new Directory(Paths.cache, 'wevir-file-previews');
    const dir = new Directory(root, randomUUID());
    const ext = /\.([a-z0-9]{1,10})$/i.exec(name)?.[1] ?? 'bin';
    const file = new File(dir, `preview.${ext}`);
    const load = async () => {
      // 系统查看器可能在 App 退出后仍持有上一轮的临时副本。
      if (!clearedOldPreviews) {
        if (root.exists) root.delete();
        clearedOldPreviews = true;
      }
      dir.create({ intermediates: true });
      file.create();
      let offset = 0;
      let mtime: number | undefined;
      while (current) {
        const chunk = await client.request(
          'files.read',
          { ...target, offset, length: FILE_CHUNK_BYTES },
          { queue: false },
        );
        if (!current) return;
        if (mtime !== undefined && mtime !== chunk.mtimeMs) {
          setProblem('changes.file.changed');
          return;
        }
        mtime = chunk.mtimeMs;
        const bytes = decodeBase64(chunk.data);
        if (chunk.offset !== offset || (!bytes.length && !chunk.eof))
          throw new Error('Invalid file chunk');
        file.write(bytes, { append: true });
        offset += bytes.length;
        if (chunk.eof) break;
      }
      if (!image && !(await file.canPreview(mime ? { mimeType: mime } : {}))) {
        if (current) setProblem('files.noInlinePreview');
        return;
      }
      if (current) {
        completed.current = dir;
        setReady(file);
      }
    };
    void load().catch((reason) => {
      if (current)
        setProblem(problemOf(reason) === 'forbidden' ? 'changes.forbidden' : 'changes.file.failed');
    });
    return () => {
      current = false;
      if (completed.current !== dir && dir.exists) dir.delete();
    };
  }, [client, target, name, mime, image, attempt]);
  const open = async () => {
    if (!ready || opening) return;
    setOpening(true);
    try {
      await ready.preview({ title: name, ...(mime && { mimeType: mime }) });
    } catch {
      if (live.current) setProblem('files.noInlinePreview');
    } finally {
      if (live.current) setOpening(false);
    }
  };
  if (ready && image && !problem)
    return (
      <Image
        source={{ uri: ready.uri }}
        resizeMode="contain"
        accessibilityLabel={name}
        style={styles.image}
        onError={() => setProblem('files.noInlinePreview')}
      />
    );
  return (
    <View style={styles.body}>
      {!client && !ready ? (
        <Text style={{ color: theme.foreground }}>{t('thread.unavailable')}</Text>
      ) : problem ? (
        <>
          <Text style={{ color: theme.foreground }}>{t(problem)}</Text>
          {problem === 'changes.file.failed' && (
            <Button title={t('computer.retry')} onPress={() => setAttempt((n) => n + 1)} />
          )}
        </>
      ) : ready ? (
        <Button title={t('changes.openFile')} disabled={opening} onPress={() => void open()} />
      ) : (
        <ActivityIndicator color={theme.mutedForeground} />
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  image: { flex: 1 },
  body: { flex: 1, padding: SPACE.page, gap: 10, justifyContent: 'center', alignItems: 'center' },
});
