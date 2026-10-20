// “创建项目”对话框（U5，照 Codex 桌面端）：项目名称与源文件夹。界面上的“项目”就是 Host 的工作区
// （workspace.add 的 displayName 与 rootPath；0.64.0 起第二个起的源文件夹是 extraFolders）。侧栏“项目”一节的 +、首页的项目
// 下拉、设置 → 项目都打开它；首页没有项目时按发送也先打开它，建好后接着发（onCreated）。

import { isRpcError } from '@wevir/client-sdk';
import type { Workspace } from '@wevir/protocol';
import { cn } from 'cn';
import { Folder } from 'lucide-react';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useWorkbenchData, useWorkbenchStore } from '@/data/workbench-data';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { expandWorkspace } from '@/layout/layout-state';
import { createStore } from '@/lib/store';
import { rememberWorkspace } from '@/routes/last-location';
import { paths } from '@/routes/paths';
import {
  basename,
  chooseSourceFolder,
  SOURCE_FOLDERS_MAX,
  SourceFolderList,
  useMultipleSourceFolders,
} from './source-folders';

interface CreateProjectRequest {
  /** 建好之后做什么；省略时回到首页并选中它。 */
  onCreated?: (workspace: Workspace) => void;
}

const request = createStore<CreateProjectRequest | null>(null);

export function openCreateProject(options: CreateProjectRequest = {}): void {
  request.set(options);
}

/** 路由根上挂一个（routes/router.tsx 的 AppRoot）。 */
export function CreateProjectDialog() {
  const current = request.use();
  return (
    <Dialog open={current !== null} onOpenChange={(open) => !open && request.set(null)}>
      {current && <CreateProjectForm request={current} onDone={() => request.set(null)} />}
    </Dialog>
  );
}

function CreateProjectForm({
  request: { onCreated },
  onDone,
}: {
  request: CreateProjectRequest;
  onDone: () => void;
}) {
  const { client } = useHostConnection();
  const store = useWorkbenchStore();
  const data = useWorkbenchData();
  const navigate = useNavigate();
  const nameId = useId();
  const [name, setName] = useState('');
  const multiple = useMultipleSourceFolders();
  const [folders, setFolders] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const folder = folders[0];

  // 换了文件夹就清掉上次的错误。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在换文件夹时触发。
  useEffect(() => setError(undefined), [folders]);

  const choose = async () => {
    try {
      const path = await chooseSourceFolder();
      if (path !== null) {
        setFolders((current) => (current.includes(path) ? current : [...current, path]));
      }
    } catch (reason) {
      setError(describe(reason));
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!client || !folder || busy) return;
    const listed =
      data.status === 'ready' ? new Set(data.workspaces.map((e) => e.workspace.id)) : new Set();
    setBusy(true);
    setError(undefined);
    try {
      const displayName = name.trim();
      const extraFolders = folders.slice(1);
      const { workspace, created } = await client.request('workspace.add', {
        rootPath: folder,
        ...(displayName !== '' && { displayName }),
        ...(extraFolders.length > 0 && { extraFolders }),
      });
      // 同一个文件夹已经是列表里的项目：Host 返回原来的，不改名。
      if (!created && listed.has(workspace.id)) {
        setError(t('project.exists', { name: workspace.displayName }));
        return;
      }
      await store?.refresh();
      expandWorkspace(workspace.id);
      rememberWorkspace(workspace.id);
      onDone();
      if (onCreated) onCreated(workspace);
      else navigate(paths.home());
    } catch (reason) {
      setError(workspaceAddError(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogContent className="gap-5 p-5 sm:max-w-120">
      <DialogTitle className="text-lg font-semibold">{t('project.create.title')}</DialogTitle>
      <form onSubmit={submit} className="flex min-w-0 flex-col gap-5">
        <label
          htmlFor={nameId}
          className="flex h-10 items-center gap-2.5 rounded-lg border border-input bg-card px-3 transition-colors focus-within:focus-field"
        >
          <Folder aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <input
            id={nameId}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={folder ? basename(folder) : t('project.create.name')}
            aria-label={t('project.create.name')}
            // biome-ignore lint/a11y/noAutofocus: 对话框打开后第一件事就是起名。
            autoFocus
            className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
          />
        </label>

        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-soft-foreground">{t('project.create.folder')}</p>
          <SourceFolderList
            folders={folders}
            max={multiple ? SOURCE_FOLDERS_MAX : 1}
            onAdd={choose}
            onRemove={(index) => setFolders((current) => current.filter((_, i) => i !== index))}
          />
        </div>

        {error && (
          <p role="alert" className="text-sm break-words text-destructive">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onDone}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            disabled={!client || !folder || busy}
            className={cn(busy && 'cursor-progress')}
            data-action="create-project"
          >
            {t('project.create.submit')}
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}

export function workspaceAddError(error: unknown): string {
  if (isRpcError(error, 'WORKSPACE_PATH_INVALID') && error.data) {
    const { reason, path } = error.data;
    return t(`workspace.pathInvalid.${reason}`, { path });
  }
  return t('project.addFailed', { error: describe(error) });
}
