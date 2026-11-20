import type { SessionId, WorkspaceId } from '@wevir/protocol';
import { type ReactElement, useEffect, useState } from 'react';
import { type MessageKey, t } from '../i18n';
import type { ChangesClient } from '../lib/changes';
import type { DiffRow } from '../lib/diff';
import { useTheme } from '../theme';
import { CodeView } from './code-view';
import { Placeholder } from './file-contents';

export function RevisionFile({
  client,
  workspaceId,
  sessionId,
  path,
  revision,
  side = 'new',
  header,
  line,
  bottomInset,
}: {
  client: ChangesClient;
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  path: string;
  revision: string | undefined;
  side?: 'old' | 'new';
  header?: ReactElement;
  line?: number | undefined;
  bottomInset: number;
}) {
  const theme = useTheme();
  const [rows, setRows] = useState<DiffRow[]>();
  const [error, setError] = useState<MessageKey>();
  useEffect(() => {
    let live = true;
    setRows(undefined);
    setError(undefined);
    if (!revision) {
      setError('changes.file.failed');
      return;
    }
    client
      .request(
        'workspace.diffFile',
        {
          workspaceId,
          sessionId,
          ...(side === 'old'
            ? { oldPath: path, oldRev: revision }
            : { newPath: path, newRev: revision }),
        },
        { queue: false },
      )
      .then(
        (result) => {
          if (!live) return;
          const contents = side === 'old' ? result.oldContents : result.newContents;
          if (contents === undefined) {
            setError(
              result.unavailable === 'too_large'
                ? 'changes.tooLarge'
                : result.unavailable === 'binary'
                  ? 'changes.binary'
                  : 'changes.file.failed',
            );
            return;
          }
          const lines = contents.split(/\r?\n/);
          if (lines.at(-1) === '') lines.pop();
          setRows(lines.map((text, index) => ({ kind: 'context', text, newLine: index + 1 })));
        },
        () => {
          if (live) setError('changes.file.failed');
        },
      );
    return () => {
      live = false;
    };
  }, [client, workspaceId, sessionId, path, revision, side]);
  if (error || !rows) return <Placeholder theme={theme} header={header} text={error && t(error)} />;
  if (line && line > rows.length)
    return <Placeholder theme={theme} header={header} text={t('files.lineUnavailable')} />;
  return (
    <CodeView
      theme={theme}
      mode="file"
      rows={rows}
      focusLine={line}
      header={header}
      bottomInset={bottomInset}
    />
  );
}
