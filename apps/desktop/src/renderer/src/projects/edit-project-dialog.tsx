import { WORKSPACE_NAME_MAX_LENGTH, type Workspace } from '@wevir/protocol';
import { cn } from 'cn';
import { Folder } from 'lucide-react';
import { type FormEvent, useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useWorkbenchStore } from '@/data/workbench-data';
import { editRequest, updateWorkspace } from '@/data/workspace-actions';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import {
  chooseSourceFolder,
  SOURCE_FOLDERS_MAX,
  SourceFolderList,
  useMultipleSourceFolders,
} from './source-folders';

/**
 * 编辑项目（`workspace.update`）：名称（0.49.0）与源文件夹（0.63.0，版式同创建项目）。主文件夹是 `rootPath`，不能改也不能移除；
 * 其余的可以加减，Host 没有 `workspace_folders` 时只列主文件夹。侧栏项目的右键菜单与设置 → 项目经 `requestEditProject` 打开；
 * 回车保存，空白的名称不能保存，失败时框不关、在框里显示原因。挂在路由根上。
 */
export function EditProjectDialog() {
  const request = editRequest.use();
  const { client } = useHostConnection();
  const store = useWorkbenchStore();
  const multiple = useMultipleSourceFolders();
  const nameId = useId();
  const [name, setName] = useState('');
  const [extra, setExtra] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // 关掉时 `request` 先清空，框里的内容留到退场动画播完。
  const [shown, setShown] = useState<Workspace>();

  useEffect(() => {
    if (!request) return;
    setShown(request);
    setName(request.displayName);
    setExtra(request.extraFolders ?? []);
    setError(undefined);
    setBusy(false);
  }, [request]);

  const close = () => {
    if (!busy) editRequest.set(undefined);
  };
  const choose = async () => {
    if (!request) return;
    try {
      const path = await chooseSourceFolder();
      if (path === null || path === request.rootPath) return;
      setExtra((current) => (current.includes(path) ? current : [...current, path]));
      setError(undefined);
    } catch (reason) {
      setError(describe(reason));
    }
  };
  const trimmed = name.trim();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!request || !client || trimmed === '' || busy) return;
    const renamed = trimmed !== request.displayName;
    const before = request.extraFolders ?? [];
    const refoldered =
      extra.length !== before.length || extra.some((folder, index) => folder !== before[index]);
    if (!renamed && !refoldered) {
      editRequest.set(undefined);
      return;
    }
    setBusy(true);
    try {
      await updateWorkspace(client, store, request.id, {
        ...(renamed && { displayName: trimmed }),
        ...(refoldered && { extraFolders: extra }),
      });
      editRequest.set(undefined);
    } catch (reason) {
      setError(t('project.edit.failed', { error: describe(reason) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={request !== undefined} onOpenChange={(open) => !open && close()}>
      {shown && (
        <DialogContent className="gap-5 p-5 sm:max-w-120">
          <DialogTitle className="text-lg font-semibold">{t('project.edit.title')}</DialogTitle>
          <form onSubmit={submit} className="flex min-w-0 flex-col gap-5">
            <label
              htmlFor={nameId}
              className="flex h-10 items-center gap-2.5 rounded-lg border border-input bg-card px-3 transition-colors focus-within:border-ring-soft focus-within:ring-2 focus-within:ring-ring/12"
            >
              <Folder aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <input
                id={nameId}
                autoFocus
                value={name}
                maxLength={WORKSPACE_NAME_MAX_LENGTH}
                onChange={(event) => setName(event.target.value)}
                onFocus={(event) => event.currentTarget.select()}
                aria-label={t('project.create.name')}
                data-testid="edit-project-input"
                className="min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground"
              />
            </label>

            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium text-soft-foreground">
                {t('project.create.folder')}
              </p>
              <SourceFolderList
                folders={[shown.rootPath, ...extra]}
                max={multiple ? SOURCE_FOLDERS_MAX : 1}
                locked={1}
                onAdd={choose}
                onRemove={(index) =>
                  setExtra((current) => current.filter((_, i) => i !== index - 1))
                }
              />
            </div>

            {error && (
              <p role="alert" className="text-sm break-words text-destructive">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={close} disabled={busy}>
                {t('common.cancel')}
              </Button>
              <Button
                type="submit"
                disabled={busy || trimmed === ''}
                className={cn(busy && 'cursor-progress')}
                data-confirm
              >
                {t('project.edit.save')}
              </Button>
            </div>
          </form>
        </DialogContent>
      )}
    </Dialog>
  );
}
