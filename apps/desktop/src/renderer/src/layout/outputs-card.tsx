// 会话侧栏的“输出”卡片（desktop-layout.md §12）：这个会话里 Agent 新建、修改、删除的文件与交给用户的文件（outputs-model.ts）。
// 与“变更”（工作区的 git 状态）不同：只算这个会话自己动过的，不在 git 仓库里也有。

import { cn } from 'cn';
import { FileOutput, FilePen, FilePlus, FileX } from 'lucide-react';
import { useMemo } from 'react';
import { useTranscript } from '@/data/workbench-data';
import { useFilesSupported } from '@/files/files-data';
import { openFile } from '@/files/files-store';
import { t } from '@/i18n';
import { type OutputFile, type OutputKind, sessionOutputs } from './outputs-model';
import { usePanes } from './pane-controller';
import { type RailContext, registerRailCard } from './session-rail';

const KIND_ICONS: Record<OutputKind, typeof FilePlus> = {
  created: FilePlus,
  modified: FilePen,
  deleted: FileX,
  shared: FileOutput,
};

function splitPath(file: OutputFile): { name: string; folder: string } {
  const shown = file.relative ?? file.path;
  const slash = Math.max(shown.lastIndexOf('/'), shown.lastIndexOf('\\'));
  return slash < 0
    ? { name: shown, folder: '' }
    : { name: shown.slice(slash + 1), folder: shown.slice(0, slash) };
}

function OutputRow({ file, onOpen }: { file: OutputFile; onOpen?: () => void }) {
  const Icon = KIND_ICONS[file.kind];
  const { name, folder } = splitPath(file);
  const deleted = file.kind === 'deleted';
  const content = (
    <>
      <Icon
        aria-hidden
        className={cn(
          'size-4 shrink-0 text-muted-foreground',
          file.kind === 'created' && 'text-success',
          deleted && 'text-destructive',
        )}
      />
      <span className="sr-only">{t(`rail.outputs.kind.${file.kind}`)}：</span>
      <span className={cn('shrink-0 truncate', deleted && 'text-muted-foreground line-through')}>
        {name}
      </span>
      {folder && (
        <span dir="rtl" className="min-w-0 flex-1 truncate text-left text-muted-foreground">
          <bdi dir="ltr">{folder}</bdi>
        </span>
      )}
      {!folder && <span className="flex-1" />}
      {file.lines && (file.lines.added > 0 || file.lines.removed > 0) && (
        <span className="shrink-0 text-xs tabular-nums">
          <span className="text-success">+{file.lines.added.toLocaleString('en-US')}</span>{' '}
          <span className="text-destructive">−{file.lines.removed.toLocaleString('en-US')}</span>
        </span>
      )}
    </>
  );
  const row = 'flex h-7 w-full min-w-0 items-center gap-2 text-sm';
  return (
    <li title={file.path}>
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          className={cn(
            row,
            '-mx-1.5 w-[calc(100%+0.75rem)] rounded-md px-1.5 text-left outline-none transition-colors hover:bg-muted focus-visible:focus-ring',
          )}
        >
          {content}
        </button>
      ) : (
        <span className={row}>{content}</span>
      )}
    </li>
  );
}

function useOutputsCard({ sessionId, session }: RailContext) {
  const state = useTranscript(sessionId);
  const panes = usePanes();
  const filesSupported = useFilesSupported();
  const messages = state?.transcript.messages;
  const files = useMemo(
    () => (messages ? sessionOutputs(messages, session.cwd) : []),
    [messages, session.cwd],
  );
  if (files.length === 0) return null;
  // 会话目录里的在文件窗格里预览（Host 有 `workspace_files` 时），目录外的在访达里显示；删掉的不能打开。
  const opener = (file: OutputFile) => {
    if (file.kind === 'deleted') return undefined;
    const relative = file.relative;
    if (relative !== undefined && filesSupported && panes) return () => openFile(panes, relative);
    return () => void window.wevir.revealPath(file.path).catch(() => undefined);
  };
  return {
    summary: t('rail.outputs.files', { count: files.length }),
    details: (
      <ul
        data-testid="rail-outputs"
        className="-mx-1.5 max-h-72 overflow-x-hidden overflow-y-auto px-1.5"
      >
        {files.map((file) => {
          const open = opener(file);
          return <OutputRow key={file.path} file={file} {...(open && { onOpen: open })} />;
        })}
      </ul>
    ),
  };
}

registerRailCard({
  id: 'outputs',
  order: 35,
  title: () => t('rail.outputs'),
  useCard: useOutputsCard,
});
