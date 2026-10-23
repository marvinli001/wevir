import type { ChatPartOf } from '@wevir/client-sdk';
import type { SharedFile } from '@wevir/protocol';
import { cn } from 'cn';
import { Check, Download, ExternalLink, FolderOpen } from 'lucide-react';
import { useContext, useEffect, useState } from 'react';
import { IconButton } from '@/components/icon-button';
import { OpenSessionFile } from '@/files/file-links';
import { currentLocale, t } from '@/i18n';
import { fileIcon } from '@/layout/panes/files-pane';
import { IS_MAC } from '@/lib/shortcuts';
import { capabilities, platformApi } from '@/platform/platform';
import { canOpenExternally } from '../../../shared/open-path.js';
import { fileTypeLabel, formatFileSize, sharedFilePath } from './shared-files-model';
import { WorkspaceRoot } from './work-group';

/** “已保存”停留多久。 */
const SAVED_MS = 1500;

/**
 * Agent 交给用户的文件（0.40.0，`file.shared`，desktop-tokens §51）：一张卡片，每个文件一行——类型图标、文件名、大小与类型，
 * 右边是用默认应用打开（文档与媒体才有）、另存为、在访达中显示。点文件名在文件窗格里预览（Host 有 `workspace_files` 时），
 * 否则交给默认应用。文件在会话的文件夹里（`WorkspaceRoot` 给的是会话的 `cwd`）。
 */
export function SharedFilesCard({ part }: { part: ChatPartOf<'files'> }) {
  const cwd = useContext(WorkspaceRoot);
  if (cwd === undefined) return null;
  return (
    <ul
      data-shared-files=""
      className="my-3 divide-y divide-border overflow-hidden rounded-xl border border-border bg-background"
    >
      {part.files.map((file) => (
        <SharedFileRow key={file.path} file={file} absolute={sharedFilePath(cwd, file)} />
      ))}
    </ul>
  );
}

function SharedFileRow({ file, absolute }: { file: SharedFile; absolute: string }) {
  const openInPane = useContext(OpenSessionFile);
  const [state, setState] = useState<{ kind: 'saved' } | { kind: 'error'; message: string }>();
  // 系统应用、另存为与访达只对这台电脑上的文件有用（platform/platform.ts 的 `localFiles`）。
  const local = capabilities().localFiles;
  const external = local && canOpenExternally(absolute);
  const Icon = fileIcon(file.name);
  const type = fileTypeLabel(file.name);

  useEffect(() => {
    if (state?.kind !== 'saved') return;
    const timer = window.setTimeout(() => setState(undefined), SAVED_MS);
    return () => window.clearTimeout(timer);
  }, [state]);

  const run = (action: () => Promise<unknown>) => {
    setState(undefined);
    action().catch((error: unknown) =>
      setState({
        kind: 'error',
        message: t('sharedFile.failed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      }),
    );
  };
  const open = () => {
    if (openInPane) openInPane(file.path);
    else if (external) run(() => platformApi().openPath(absolute));
    else if (local) run(() => platformApi().revealPath(absolute));
  };
  const saveAs = () =>
    run(async () => {
      if ((await platformApi().saveFileAs(absolute, file.name)) === 'saved') {
        setState({ kind: 'saved' });
      }
    });

  return (
    <li className="group/file flex min-h-12 items-center gap-1 pr-2" data-shared-file={file.path}>
      <button
        type="button"
        onClick={open}
        title={file.path}
        className="flex min-w-0 flex-1 items-center gap-3 self-stretch py-2 pl-3 text-left outline-none transition-colors duration-150 hover:bg-muted/60 focus-visible:bg-muted"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Icon aria-hidden className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-foreground">{file.name}</span>
          <span
            className={cn(
              'block truncate text-xs tabular-nums',
              state?.kind === 'error' ? 'text-destructive' : 'text-muted-foreground',
            )}
          >
            {state?.kind === 'error'
              ? state.message
              : [formatFileSize(file.size, currentLocale()), type].filter(Boolean).join(' · ')}
          </span>
        </span>
      </button>
      {external && (
        <IconButton
          label={t('files.openDefault')}
          size="icon-xs"
          className="text-muted-foreground"
          onClick={() => run(() => platformApi().openPath(absolute))}
          data-action="open-shared-file"
        >
          <ExternalLink />
        </IconButton>
      )}
      {local && (
        <IconButton
          label={t('sharedFile.saveAs')}
          size="icon-xs"
          className="text-muted-foreground"
          onClick={saveAs}
          data-action="save-shared-file"
        >
          {state?.kind === 'saved' ? (
            <Check aria-label={t('sharedFile.saved')} className="confirm-pop text-success" />
          ) : (
            <Download />
          )}
        </IconButton>
      )}
      {local && (
        <IconButton
          label={IS_MAC ? t('files.revealFinder') : t('files.revealFolder')}
          size="icon-xs"
          className="text-muted-foreground"
          onClick={() => run(() => platformApi().revealPath(absolute))}
          data-action="reveal-shared-file"
        >
          <FolderOpen />
        </IconButton>
      )}
    </li>
  );
}
