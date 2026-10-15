import { SESSION_TITLE_MAX_LENGTH } from '@wevir/protocol';
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
import { renameRequest, renameSession } from '@/data/session-actions';
import { useWorkbenchStore } from '@/data/workbench-data';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';

/**
 * 会话改名（U34，0.23.0 的 `session.rename`）：左栏的右键菜单与 `/rename` 经 `requestRename` 打开；回车保存，空白的标题
 * 不能保存，失败时框不关、在框里显示原因。挂在路由根上。
 */
export function RenameDialog() {
  const request = renameRequest.use();
  const { client } = useHostConnection();
  const store = useWorkbenchStore();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!request) return;
    setTitle(request.title);
    setError(undefined);
    setBusy(false);
  }, [request]);

  const close = () => {
    if (!busy) renameRequest.set(undefined);
  };
  const trimmed = title.trim();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!request || !client || trimmed === '' || busy) return;
    if (trimmed === request.title) {
      renameRequest.set(undefined);
      return;
    }
    setBusy(true);
    try {
      await renameSession(client, store, request.sessionId, trimmed);
      renameRequest.set(undefined);
    } catch (reason) {
      setError(t('session.renameFailed', { error: describe(reason) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={request !== undefined} onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <form onSubmit={submit} className="contents">
          <DialogHeader>
            <DialogTitle>{t('session.rename')}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={title}
            maxLength={SESSION_TITLE_MAX_LENGTH}
            onChange={(event) => setTitle(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            aria-label={t('session.rename')}
            data-testid="rename-input"
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
              {t('session.renameSave')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
