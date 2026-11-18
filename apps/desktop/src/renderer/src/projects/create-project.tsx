// “创建项目”对话框（U5，照 Codex 桌面端）：项目名称与源文件夹。界面上的“项目”就是 Host 的工作区
// （workspace.add 的 displayName 与 rootPath；0.64.0 起第二个起的源文件夹是 extraFolders）。侧栏“项目”一节的 +、首页的项目
// 下拉、设置 → 项目都打开它；首页没有项目时按发送也先打开它，建好后接着发（onCreated）。

import { hostSupports, isRpcError } from '@wevir/client-sdk';
import type { Workspace } from '@wevir/protocol';
import { cn } from 'cn';
import { Folder, FolderPlus, GitFork, LoaderCircle } from 'lucide-react';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { useNavigate } from 'react-router';
import { ErrorNote } from '@/components/error-note';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useWorkbenchData, useWorkbenchStore } from '@/data/workbench-data';
import { projectsOf } from '@/data/workbench-model';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { expandWorkspace } from '@/layout/layout-state';
import { createStore } from '@/lib/store';
import { capabilities } from '@/platform/platform';
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
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={current !== null} onOpenChange={(open) => !open && !busy && request.set(null)}>
      {current && (
        <CreateProjectForm
          request={current}
          busy={busy}
          setBusy={setBusy}
          onDone={() => request.set(null)}
        />
      )}
    </Dialog>
  );
}

function CreateProjectForm({
  request: { onCreated },
  busy,
  setBusy,
  onDone,
}: {
  request: CreateProjectRequest;
  busy: boolean;
  setBusy: (value: boolean) => void;
  onDone: () => void;
}) {
  const { client, view } = useHostConnection();
  const store = useWorkbenchStore();
  const data = useWorkbenchData();
  const navigate = useNavigate();
  const nameId = useId();
  const [name, setName] = useState<string>();
  const [repository, setRepository] = useState('');
  const [parent, setParent] = useState('');
  const local = capabilities().localFiles;
  const createSupported =
    view.status === 'connected' && hostSupports(view.hello.features, 'git_workflow');
  const [selectedMode, setMode] = useState<'existing' | 'empty' | 'clone'>(
    local ? 'existing' : 'empty',
  );
  const mode = createSupported ? selectedMode : 'existing';
  const remoteRoots =
    data.status === 'ready' && !local
      ? [
          ...new Set(
            projectsOf(data.workspaces).flatMap(({ workspace }) => [
              workspace.rootPath,
              ...(workspace.extraFolders ?? []),
            ]),
          ),
        ]
      : [];
  const parentPath = local
    ? parent
    : remoteRoots.includes(parent)
      ? parent
      : (remoteRoots[0] ?? '');
  const projectName =
    name ??
    (mode === 'clone'
      ? (repository
          .trim()
          .replace(/[?#].*$/, '')
          .replace(/\/+$/, '')
          .split(/[/:]/)
          .at(-1)
          ?.replace(/\.git$/i, '') ?? '')
      : '');
  const multiple = useMultipleSourceFolders();
  const [folders, setFolders] = useState<readonly string[]>([]);
  const [error, setError] = useState<string>();
  const folder = folders[0] ?? '';
  const ready =
    !!client &&
    view.status === 'connected' &&
    view.hello.permissions.includes('workspace.write') &&
    (mode === 'existing'
      ? !!folder
      : !!parentPath && !!projectName.trim() && (mode !== 'clone' || !!repository.trim()));

  // biome-ignore lint/correctness/useExhaustiveDependencies: 修改输入后清除上次提交的错误。
  useEffect(() => setError(undefined), [folders, parent, repository, name, mode]);

  const choose = async () => {
    try {
      const path = await chooseSourceFolder();
      if (path !== null) {
        if (mode === 'existing')
          setFolders((current) => (current.includes(path) ? current : [...current, path]));
        else setParent(path);
      }
    } catch (reason) {
      setError(describe(reason));
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!client || !ready || busy) return;
    const listed =
      data.status === 'ready' ? new Set(data.workspaces.map((e) => e.workspace.id)) : new Set();
    setBusy(true);
    setError(undefined);
    try {
      const displayName = projectName.trim();
      const extraFolders = folders.slice(1);
      const { workspace, created } =
        mode === 'existing'
          ? await client.request('workspace.add', {
              rootPath: folder,
              ...(displayName !== '' && { displayName }),
              ...(extraFolders.length > 0 && { extraFolders }),
            })
          : await client.request(
              'workspace.create',
              {
                parentPath,
                name: displayName,
                ...(mode === 'clone' && { repositoryUrl: repository.trim() }),
              },
              { timeoutMs: 660_000 },
            );
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
    <DialogContent
      showCloseButton={!busy}
      className="max-h-[calc(100dvh-3rem)] gap-5 overflow-y-auto p-5 sm:max-w-120"
    >
      <DialogTitle className="text-lg font-semibold">{t('project.create.title')}</DialogTitle>
      <form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
        {createSupported && (
          <Select
            value={selectedMode}
            disabled={busy}
            aria-label={t('project.create.source')}
            data-action="project-source"
            options={[
              ...(local
                ? [
                    {
                      value: 'existing' as const,
                      label: t('project.create.existing'),
                      icon: <Folder />,
                    },
                  ]
                : []),
              { value: 'empty', label: t('project.create.empty'), icon: <FolderPlus /> },
              { value: 'clone', label: t('project.create.clone'), icon: <GitFork /> },
            ]}
            onValueChange={setMode}
          />
        )}
        {mode === 'clone' && (
          <label
            htmlFor={`${nameId}-repository`}
            className="grid min-w-0 gap-1.5 text-sm font-medium text-soft-foreground"
          >
            {t('project.create.repository')}
            <Input
              id={`${nameId}-repository`}
              value={repository}
              onChange={(event) => setRepository(event.target.value)}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              disabled={busy}
              maxLength={2048}
              required
              className="font-mono text-foreground"
            />
          </label>
        )}
        <div className="grid gap-1.5">
          {mode !== 'existing' && (
            <label htmlFor={nameId} className="text-sm font-medium text-soft-foreground">
              {t('project.create.name')}
            </label>
          )}
          <div className="flex h-10 items-center gap-2.5 rounded-lg border border-input bg-card px-3 transition-colors focus-within:focus-field">
            <Folder aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <input
              id={nameId}
              value={projectName}
              onChange={(event) => setName(event.target.value)}
              placeholder={
                mode === 'existing' && folder ? basename(folder) : t('project.create.name')
              }
              aria-label={t('project.create.name')}
              disabled={busy}
              required={mode !== 'existing'}
              maxLength={mode === 'existing' ? undefined : 200}
              // biome-ignore lint/a11y/noAutofocus: 对话框打开后第一件事就是起名。
              autoFocus
              className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>

        <fieldset disabled={busy} className="flex min-w-0 flex-col gap-2">
          <legend className="mb-2 text-sm font-medium text-soft-foreground">
            {t(mode === 'existing' ? 'project.create.folder' : 'project.create.parent')}
          </legend>
          {local ? (
            <SourceFolderList
              folders={mode === 'existing' ? folders : parent ? [parent] : []}
              max={mode === 'existing' && multiple ? SOURCE_FOLDERS_MAX : 1}
              onAdd={choose}
              onRemove={(index) =>
                mode === 'existing'
                  ? setFolders((current) => current.filter((_, i) => i !== index))
                  : setParent('')
              }
            />
          ) : parentPath ? (
            <Select
              aria-label={t('project.create.parent')}
              value={parentPath}
              options={remoteRoots.map((value) => ({ value, label: value }))}
              onValueChange={setParent}
              disabled={busy}
            />
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              {t('project.create.noParent')}
            </p>
          )}
        </fieldset>

        {error && <ErrorNote className="text-sm">{error}</ErrorNote>}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" disabled={busy} onClick={onDone}>
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            disabled={!ready || busy}
            className={cn(busy && 'cursor-progress')}
            data-action="create-project"
          >
            {busy && <LoaderCircle aria-hidden className="animate-spin" />}
            {t(mode === 'clone' ? 'project.create.clone' : 'project.create.submit')}
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
