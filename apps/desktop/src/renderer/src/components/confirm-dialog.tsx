import { type ReactNode, useState } from 'react';
import { ErrorNote } from '@/components/error-note';
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
 * 删除、移除这类操作的确认框。`onConfirm` 进行期间按钮不可再点，确认按钮带加载圈、不变淡（删很多会话要几秒，变淡像是点不了）；
 * 失败时框不关，在框里显示 `failure(错误)`，成功后关闭。
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
    if (busy) return;
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
      <DialogContent
        className="sm:max-w-md"
        showCloseButton={false}
        {...(!children && { 'aria-describedby': undefined })}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {children && (
            <DialogDescription render={<div />} className="space-y-2 leading-relaxed">
              {children}
            </DialogDescription>
          )}
        </DialogHeader>
        {error && <ErrorNote className="text-sm">{error}</ErrorNote>}
        <DialogFooter>
          <Button variant="outline" onClick={() => change(false)} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={confirm}
            disabled={busy}
            loading={busy}
            data-confirm
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
