import type { WevirClient } from '@wevir/client-sdk';
import type { UserFilePart } from '@wevir/protocol';
import { Download, FileText, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { ErrorNote } from '@/components/error-note';
import { describe, useHostConnection } from '@/host/host-connection';
import { currentLocale, t } from '@/i18n';
import { formatFileSize } from './shared-files-model';

export async function readAttachedFile(client: WevirClient, file: UserFilePart): Promise<Blob> {
  const parts: ArrayBuffer[] = [];
  let offset = 0;
  do {
    const chunk = await client.request('file.read', { fileId: file.fileId, offset });
    const bytes = Uint8Array.from(atob(chunk.data), (character) => character.charCodeAt(0));
    if (
      chunk.fileId !== file.fileId ||
      chunk.size !== file.size ||
      chunk.offset !== offset ||
      offset + bytes.length > file.size ||
      (bytes.length === 0 && offset < file.size)
    ) {
      throw new Error(t('message.fileIncomplete'));
    }
    parts.push(bytes.buffer);
    offset += bytes.length;
  } while (offset < file.size);
  return new Blob(parts, { type: 'application/octet-stream' });
}

export function MessageFiles({ files }: { files: readonly UserFilePart[] }) {
  return (
    files.length > 0 && (
      <ul className="mb-1.5 flex max-w-full flex-wrap justify-end gap-1">
        {files.map((file, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 已发送的顺序固定，同一个文件可以附加两次。
          <AttachedFile key={`${file.fileId}:${index}`} file={file} />
        ))}
      </ul>
    )
  );
}

function AttachedFile({ file }: { file: UserFilePart }) {
  const { client } = useHostConnection();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const save = async () => {
    if (!client || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const url = URL.createObjectURL(await readAttachedFile(client, file));
      const link = document.createElement('a');
      link.href = url;
      link.download = file.name.split(/[/\\]/).at(-1) || 'attachment';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) {
      setError(t('sharedFile.failed', { error: describe(reason) }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="min-w-0 max-w-full">
      <button
        type="button"
        disabled={busy || !client?.supports('user_files')}
        onClick={() => void save()}
        title={file.name}
        aria-label={`${t('source.download')} · ${file.name}`}
        aria-busy={busy || undefined}
        className="group/attachment inline-flex max-w-full items-center gap-1.5 rounded-md bg-muted/60 px-2 py-1 text-xs text-soft-foreground outline-none hover:bg-muted focus-visible:focus-ring"
      >
        {busy ? (
          <LoaderCircle aria-hidden className="size-3.5 shrink-0 animate-spin" />
        ) : (
          <FileText aria-hidden className="size-3.5 shrink-0" />
        )}
        <span className="truncate">{file.name}</span>
        <span className="shrink-0 text-muted-foreground">
          {formatFileSize(file.size, currentLocale())}
        </span>
        <Download aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      </button>
      {error && <ErrorNote className="mt-1 text-xs">{error}</ErrorNote>}
    </li>
  );
}
