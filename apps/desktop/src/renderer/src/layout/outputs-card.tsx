// 会话侧栏的“输出”卡片（desktop-layout.md §12）：这个会话里 Agent 新建、修改、删除的文件与交给用户的文件（outputs-model.ts）。
// 与“变更”（工作区的 git 状态）不同：只算这个会话自己动过的，不在 git 仓库里也有。

import { cn } from 'cn';
import { sameFields } from '@/data/transcript-selection';
import { useTranscriptSelector } from '@/data/workbench-data';
import {
  FileLinkMenuProvider,
  useAttachToSession,
  useFileContextMenu,
} from '@/files/file-link-menu';
import { useFilesSupported } from '@/files/files-data';
import { openFile } from '@/files/files-store';
import { t } from '@/i18n';
import { capabilities, platformApi } from '@/platform/platform';
import { type OutputFile, sessionOutputs } from './outputs-model';
import { usePanes } from './pane-controller';
import { fileIcon } from './panes/files-pane';
import { type RailContext, registerRailCard } from './session-rail';

function fileName(file: OutputFile): string {
  const shown = file.relative ?? file.path;
  return shown.slice(Math.max(shown.lastIndexOf('/'), shown.lastIndexOf('\\')) + 1);
}

/** 照 Claude Code 的“Outputs”：文件类型图标与文件名，悬停显示完整路径；删掉的文件名加删除线。 */
function OutputRow({ file, onOpen }: { file: OutputFile; onOpen?: () => void }) {
  const name = fileName(file);
  const Icon = fileIcon(name);
  const deleted = file.kind === 'deleted';
  // 删掉的文件只剩路径，没有菜单可用的东西，右键照常。
  const onContextMenu = useFileContextMenu(deleted ? undefined : file.path);
  const content = (
    <>
      <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="sr-only">
        {t(`rail.outputs.kind.${file.kind}`)}
        {t('common.colon')}
      </span>
      <span className={cn('min-w-0 truncate', deleted && 'text-muted-foreground line-through')}>
        {name}
      </span>
    </>
  );
  const row = 'flex h-7 w-full min-w-0 items-center gap-2.5 text-sm';
  return (
    <li title={file.path} onContextMenu={onContextMenu}>
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
  const panes = usePanes();
  const filesSupported = useFilesSupported();
  const attach = useAttachToSession(session);
  const files = useTranscriptSelector(
    sessionId,
    (state) => sessionOutputs(state?.transcript.messages ?? [], session.cwd),
    (a, b) =>
      a.length === b.length &&
      a.every((file, index) => {
        const other = b[index];
        return (
          other !== undefined &&
          file.path === other.path &&
          file.kind === other.kind &&
          file.relative === other.relative &&
          sameFields(file.lines, other.lines)
        );
      }),
  );
  if (files.length === 0) return null;
  // 会话目录里的在文件窗格里预览（Host 有 `workspace_files` 时），目录外的在访达里显示；删掉的不能打开。
  const opener = (file: OutputFile) => {
    if (file.kind === 'deleted') return undefined;
    const relative = file.relative;
    if (relative !== undefined && filesSupported && panes) return () => openFile(panes, relative);
    if (!capabilities().localFiles) return undefined;
    return () =>
      void platformApi()
        .revealPath(file.path)
        .catch(() => undefined);
  };
  return {
    summary: t('rail.outputs.files', { count: files.length }),
    details: (
      <FileLinkMenuProvider cwd={session.cwd} attach={attach}>
        <ul data-testid="rail-outputs" className="-mx-1.5 px-1.5">
          {files.map((file) => {
            const open = opener(file);
            return <OutputRow key={file.path} file={file} {...(open && { onOpen: open })} />;
          })}
        </ul>
      </FileLinkMenuProvider>
    ),
  };
}

registerRailCard({
  id: 'outputs',
  order: 35,
  title: () => t('rail.outputs'),
  useCard: useOutputsCard,
});
