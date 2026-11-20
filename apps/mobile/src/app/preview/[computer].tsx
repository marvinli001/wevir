import type { ReviewCommentId, SessionId, WorkspaceId } from '@wevir/protocol';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useMemo } from 'react';
import { FileContents, Placeholder } from '../../components/file-contents';
import { FindingFile } from '../../components/finding-file';
import { NativeFilePreview, nativePreviewKind } from '../../components/native-file-preview';
import { t } from '../../i18n';
import { splitPath } from '../../lib/diff';
import { useComputer, useRegistry } from '../../state/registry';
import { useTheme } from '../../theme';

export default function FilePreviewScreen() {
  const { computer, path, sessionId, workspaceId, seq, line, mime, comment } =
    useLocalSearchParams<{
      computer: string;
      path: string;
      sessionId?: SessionId;
      workspaceId?: WorkspaceId;
      seq?: string;
      line?: string;
      mime?: string;
      comment?: ReviewCommentId;
    }>();
  const theme = useTheme();
  const snapshot = useComputer(computer);
  const registry = useRegistry();
  const client = snapshot && registry.link(computer)?.changes;
  const target = useMemo(
    () => ({ path, sessionId, workspaceId, ...(seq && { artifactSeq: Number(seq) }) }),
    [path, sessionId, workspaceId, seq],
  );
  const name = splitPath(path ?? '').name;
  const native = nativePreviewKind(name, mime);
  const problem =
    !path || (!sessionId && !workspaceId)
      ? 'files.notFound'
      : !client
        ? 'thread.unavailable'
        : !client.canRead
          ? 'changes.forbidden'
          : !client.supportsFiles
            ? 'changes.file.unsupported'
            : undefined;
  return (
    <>
      <Stack.Screen options={{ title: name, headerLargeTitleEnabled: false }} />
      {snapshot &&
      snapshot.status.kind !== 'removed' &&
      native &&
      !comment &&
      path &&
      (sessionId || workspaceId) &&
      (!client || (client.canRead && client.supportsFiles)) ? (
        <NativeFilePreview
          key={JSON.stringify(target)}
          client={client}
          target={target}
          name={name}
          mime={mime}
          image={native === 'image'}
        />
      ) : problem || !client ? (
        <Placeholder theme={theme} text={t(problem ?? 'thread.unavailable')} />
      ) : comment && sessionId ? (
        <FindingFile client={client} sessionId={sessionId} commentId={comment} />
      ) : (
        <FileContents
          key={JSON.stringify(target)}
          client={client}
          target={target}
          line={line ? Number(line) : undefined}
          markdown={!line && /\.(?:md|markdown)$/i.test(name)}
          bottomInset={20}
          theme={theme}
        />
      )}
    </>
  );
}
