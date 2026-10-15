import type { Environment, EnvironmentFolder, WorkspaceId } from '@wevir/protocol';
import { cn } from 'cn';
import { ArrowUp, Folder, Layers } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useWorkbenchData } from '@/data/workbench-data';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import { abbreviateHome } from '@/layout/rail-model';
import { createStore } from '@/lib/store';
import { chooseEnvironment, useEnvironments } from './environments';

/** 新建（undefined）或编辑（给了环境）；null 是关着。 */
const editing = createStore<{ environment?: Environment } | null>(null);

export function openEnvironmentDialog(environment?: Environment): void {
  editing.set(environment ? { environment } : {});
}

/**
 * 新建或编辑环境（U22.1，desktop-layout.md §16）：名称、从项目里勾选文件夹（第一个是主文件夹，可上移）、每个文件夹的“新开
 * worktree”、删除。路由根上挂一个（routes/router.tsx 的 AppRoot）。
 */
export function EnvironmentDialog() {
  const current = editing.use();
  return (
    <Dialog open={current !== null} onOpenChange={(open) => !open && editing.set(null)}>
      {current && (
        <EnvironmentForm
          key={current.environment?.id ?? 'new'}
          environment={current.environment}
          onDone={() => editing.set(null)}
        />
      )}
    </Dialog>
  );
}

function EnvironmentForm({
  environment,
  onDone,
}: {
  environment: Environment | undefined;
  onDone: () => void;
}) {
  const data = useWorkbenchData();
  const { create, update, remove } = useEnvironments();
  const nameId = useId();
  const [name, setName] = useState(environment?.name ?? '');
  const [folders, setFolders] = useState<EnvironmentFolder[]>(environment?.folders ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const workspaces = data.status === 'ready' ? data.workspaces.map((entry) => entry.workspace) : [];

  const indexOf = (id: WorkspaceId) => folders.findIndex((folder) => folder.workspaceId === id);
  const toggle = (id: WorkspaceId) =>
    setFolders((current) =>
      indexOf(id) >= 0
        ? current.filter((folder) => folder.workspaceId !== id)
        : [...current, { workspaceId: id, worktree: 'none' }],
    );
  const setWorktree = (id: WorkspaceId, on: boolean) =>
    setFolders((current) =>
      current.map((folder) =>
        folder.workspaceId === id ? { ...folder, worktree: on ? 'new' : 'none' } : folder,
      ),
    );
  const moveUp = (id: WorkspaceId) =>
    setFolders((current) => {
      const index = current.findIndex((folder) => folder.workspaceId === id);
      if (index <= 0) return current;
      const next = [...current];
      [next[index - 1], next[index]] = [
        next[index] as EnvironmentFolder,
        next[index - 1] as EnvironmentFolder,
      ];
      return next;
    });

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(undefined);
    try {
      await action();
      onDone();
    } catch (reason) {
      setError(t('env.saveFailed', { error: describe(reason) }));
    } finally {
      setBusy(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (busy || trimmed === '' || folders.length === 0) return;
    void run(async () => {
      if (environment) {
        await update(environment.id, trimmed, folders);
      } else {
        const created = await create(trimmed, folders);
        chooseEnvironment(created.id);
      }
    });
  };
  // 已勾选的按顺序在前，其余按项目列表的顺序。
  const ordered = [
    ...folders.flatMap((folder) => workspaces.filter((w) => w.id === folder.workspaceId)),
    ...workspaces.filter((workspace) => indexOf(workspace.id) < 0),
  ];

  return (
    <DialogContent className="gap-5 p-5 sm:max-w-120" data-testid="environment-dialog">
      <DialogTitle className="text-lg font-semibold">
        {t(environment ? 'env.edit' : 'env.create')}
      </DialogTitle>
      <form onSubmit={submit} className="flex min-w-0 flex-col gap-5">
        <label
          htmlFor={nameId}
          className="flex h-10 items-center gap-2.5 rounded-lg border border-input bg-card px-3 transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50"
        >
          <Layers aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <input
            id={nameId}
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('env.name')}
            aria-label={t('env.name')}
            // biome-ignore lint/a11y/noAutofocus: 对话框打开后第一件事就是起名。
            autoFocus
            className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
          />
        </label>
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-soft-foreground">{t('env.folders.label')}</p>
          <ul className="max-h-72 overflow-y-auto rounded-xl border border-border p-1">
            {ordered.map((workspace) => {
              const index = indexOf(workspace.id);
              const folder = folders[index];
              return (
                <li
                  key={workspace.id}
                  className="flex min-h-10 items-center gap-2.5 rounded-lg px-2 hover:bg-muted"
                >
                  <input
                    type="checkbox"
                    checked={index >= 0}
                    onChange={() => toggle(workspace.id)}
                    aria-label={workspace.displayName}
                    className="size-4 shrink-0 accent-foreground"
                  />
                  <Folder aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">
                      {workspace.displayName}
                      {index === 0 && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          {t('env.primary')}
                        </span>
                      )}
                    </span>
                    <span
                      dir="rtl"
                      className="block truncate text-left text-xs text-muted-foreground"
                    >
                      <bdi dir="ltr">{abbreviateHome(workspace.rootPath)}</bdi>
                    </span>
                  </span>
                  {folder && (
                    <>
                      <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={folder.worktree === 'new'}
                          onChange={(event) => setWorktree(workspace.id, event.target.checked)}
                          className="size-3.5 accent-foreground"
                        />
                        {t('env.newWorktree')}
                      </label>
                      <button
                        type="button"
                        aria-label={t('env.moveUp')}
                        disabled={index === 0}
                        onClick={() => moveUp(workspace.id)}
                        className={cn(
                          'flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:invisible',
                        )}
                      >
                        <ArrowUp aria-hidden className="size-3.5" />
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
        {error && (
          <p
            role="alert"
            className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        <div className="flex items-center gap-2">
          {environment && (
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              className="text-destructive hover:text-destructive"
              onClick={() => void run(() => remove(environment.id))}
            >
              {t('env.delete')}
            </Button>
          )}
          <span className="flex-1" />
          <Button type="button" variant="secondary" onClick={onDone}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={busy || name.trim() === '' || folders.length === 0}>
            {t('env.save')}
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}
