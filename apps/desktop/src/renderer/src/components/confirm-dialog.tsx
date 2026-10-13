import { type ReactNode, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';

/**
 * 删除、移除这类操作的确认框。`onConfirm` 进行期间按钮不可再点；失败时框不关，在框里显示 `failure(错误)`，
 * 成功后关闭。
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  children,
  confirmLabel,
  onConfirm,
  failure,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => Promise<void>;
  failure: (error: string) => string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const change = (next: boolean) => {
    if (busy) return;
    if (!next) setError(undefined);
    onOpenChange(next);
  };

  const confirm = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await onConfirm();
      setBusy(false);
      onOpenChange(false);
    } catch (reason) {
      setBusy(false);
      setError(failure(describe(reason)));
    }
  };

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription render={<div />} className="space-y-2 leading-relaxed">
            {children}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="rounded-md bg-destructive/10 px-3 py-2 text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => change(false)} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={busy} data-confirm>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
