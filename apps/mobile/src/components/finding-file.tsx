import type { ReviewCommentId, SessionId, WorkspaceId } from '@wevir/protocol';
import { useEffect, useState } from 'react';
import { type MessageKey, t } from '../i18n';
import type { ChangesClient } from '../lib/changes';
import { useTheme } from '../theme';
import { FileContents, Placeholder } from './file-contents';
import { RevisionFile } from './revision-file';

export function FindingFile({
  client,
  sessionId,
  commentId,
}: {
  client: ChangesClient;
  sessionId: SessionId;
  commentId: ReviewCommentId;
}) {
  const theme = useTheme();
  const [location, setLocation] = useState<{
    workspaceId: WorkspaceId;
    path: string;
    line: number;
    revision: string | undefined;
    side: 'old' | 'new';
  }>();
  const [error, setError] = useState<MessageKey>();
  useEffect(() => {
    let live = true;
    setLocation(undefined);
    setError(undefined);
    const resolve = async () => {
      const { session } = await client.request('session.get', { sessionId }, { queue: false });
      if (!live) return;
      const { comments } = await client.request(
        'review.list',
        { sessionId, workspaceId: session.workspaceId },
        { queue: false },
      );
      if (!live) return;
      const comment = comments.find((c) => c.id === commentId);
      if (!comment || comment.anchor.state === 'outdated') {
        setError('files.lineUnavailable');
        return;
      }
      const old = comment.side === 'old';
      setLocation({
        workspaceId: session.workspaceId,
        path: old ? (comment.previousPath ?? comment.path) : comment.path,
        side: comment.side,
        line: comment.anchor.startLine ?? comment.startLine,
        revision: old ? comment.base : comment.head,
      });
    };
    void resolve().catch(() => {
      if (live) setError('changes.file.failed');
    });
    return () => {
      live = false;
    };
  }, [client, sessionId, commentId]);
  if (!location) return <Placeholder theme={theme} text={error && t(error)} />;
  if (location.revision)
    return <RevisionFile client={client} sessionId={sessionId} {...location} bottomInset={20} />;
  return (
    <FileContents
      client={client}
      target={{ sessionId, path: location.path }}
      line={location.line}
      theme={theme}
      bottomInset={20}
    />
  );
}
