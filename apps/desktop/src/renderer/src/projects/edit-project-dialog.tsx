import { WORKSPACE_NAME_MAX_LENGTH } from '@wevir/protocol';
import { type FormEvent, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useWorkbenchStore } from '@/data/workbench-data';
import { editRequest, updateWorkspace } from '@/data/workspace-actions';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';

/**
 * 编辑项目（0.49.0 的 `workspace.update`，只改名称）：侧栏项目的右键菜单与设置 → 项目经 `requestEditProject` 打开；回车保存，
 * 空白的名称不能保存，失败时框不关、在框里显示原因。挂在路由根上。
 */
export function EditProjectDialog() {
  const request = editRequest.use();
  const { client } = useHostConnection();
  const store = useWorkbenchStore();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!request) return;
    setName(request.displayName);
    setError(undefined);
    setBusy(false);
  }, [request]);

  const close = () => {
    if (!busy) editRequest.set(undefined);
  };
  const trimmed = name.trim();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!request || !client || trimmed === '' || busy) return;
    if (trimmed === request.displayName) {
      editRequest.set(undefined);
      return;
    }
    setBusy(true);
    try {
      await updateWorkspace(client, store, request.id, trimmed);
      editRequest.set(undefined);
    } catch (reason) {
      setError(t('project.edit.failed', { error: describe(reason) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={request !== undefined} onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <form onSubmit={submit} className="contents">
          <DialogHeader>
            <DialogTitle>{t('project.edit.title')}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={name}
            maxLength={WORKSPACE_NAME_MAX_LENGTH}
            onChange={(event) => setName(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            aria-label={t('project.create.name')}
            data-testid="edit-project-input"
          />
          {error && (
            <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close} disabled={busy}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={busy || trimmed === ''} data-confirm>
              {t('project.edit.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
