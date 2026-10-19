// “创建项目”对话框（U5，照 Codex 桌面端）：项目名称与源文件夹。界面上的“项目”就是 Host 的工作区
// （workspace.add 的 displayName 与 rootPath）。侧栏“项目”一节的 +、首页的项目下拉、设置 → 项目都打开它；首页
// 没有项目时按发送也先打开它，建好后接着发（onCreated）。

import { isRpcError } from '@wevir/client-sdk';
import type { Workspace } from '@wevir/protocol';
import { cn } from 'cn';
import { Folder, FolderPlus, X } from 'lucide-react';
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
  const [folder, setFolder] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  // 换了文件夹就清掉上次的错误。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在换文件夹时触发。
  useEffect(() => setError(undefined), [folder]);

  const choose = async () => {
    try {
      const path = await window.wevir.selectFolder();
      if (path !== null) setFolder(path);
    } catch (reason) {
      setError(t('project.selectFailed', { error: describe(reason) }));
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
      const { workspace, created } = await client.request('workspace.add', {
        rootPath: folder,
        ...(displayName !== '' && { displayName }),
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
          className="flex h-10 items-center gap-2.5 rounded-lg border border-input bg-card px-3 transition-colors focus-within:border-ring-soft focus-within:ring-2 focus-within:ring-ring/12"
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
          {folder ? (
            <div className="flex items-center gap-2.5 rounded-xl border border-border bg-muted/40 py-2 pr-2 pl-3">
              <Folder aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span
                dir="rtl"
                title={folder}
                className="min-w-0 flex-1 truncate text-left font-mono text-sm"
              >
                <bdi dir="ltr">{folder}</bdi>
              </span>
              <Button type="button" variant="ghost" size="sm" onClick={choose}>
                {t('project.create.change')}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={t('project.create.clearFolder')}
                onClick={() => setFolder(undefined)}
              >
                <X />
              </Button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2.5 rounded-xl border border-dashed border-border-strong px-4 py-6">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="rounded-full px-3"
                onClick={choose}
                data-action="choose-folder"
              >
                <FolderPlus data-icon="inline-start" />
                {t('project.create.chooseFolder')}
              </Button>
            </div>
          )}
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

function basename(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || path
  );
}

export function workspaceAddError(error: unknown): string {
  if (isRpcError(error, 'WORKSPACE_PATH_INVALID') && error.data) {
    const { reason, path } = error.data;
    return t(`workspace.pathInvalid.${reason}`, { path });
  }
  return t('project.addFailed', { error: describe(error) });
}
