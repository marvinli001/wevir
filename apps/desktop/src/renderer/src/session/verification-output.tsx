// 一条验证记录的完整输出（0.65.0，`verification.output`）：对话框里分页读，读到的接在后面，“加载更多”读下一页。

import type { SessionId, VerificationRun } from '@wevir/protocol';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { RUN_LABELS } from './verification-model';

interface Page {
  text: string;
  next: number;
  more: boolean;
  dropped: boolean;
}

export function VerificationOutputDialog({
  sessionId,
  run,
  onClose,
}: {
  sessionId: SessionId;
  run: VerificationRun;
  onClose: () => void;
}) {
  const { client } = useHostConnection();
  const [page, setPage] = useState<Page>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  const load = async (offset: number, previous?: Page) => {
    if (!client) return;
    setLoading(true);
    try {
      const result = await client.request('verification.output', {
        sessionId,
        runId: run.id,
        offset,
      });
      setPage({
        text: (previous?.text ?? '') + result.text,
        next: result.next,
        more: result.more,
        dropped: previous?.dropped ?? result.from > offset,
      });
    } catch (reason) {
      setError(t('verification.failed', { error: describe(reason) }));
    } finally {
      setLoading(false);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: 换记录时从头读。
  useEffect(() => {
    setPage(undefined);
    setError(undefined);
    void load(0);
  }, [client, sessionId, run.id]);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-3xl" data-testid="verification-output">
        <DialogHeader>
          <DialogTitle>{run.name}</DialogTitle>
          <DialogDescription>
            <span className="font-mono">{run.command}</span> · {t(RUN_LABELS[run.status])}
            {run.exitCode !== undefined && run.exitCode !== null && ` · exit ${run.exitCode}`}
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : page === undefined ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : (
          <div className="min-w-0 space-y-2">
            {page.dropped && (
              <p className="text-xs text-muted-foreground">{t('verification.output.dropped')}</p>
            )}
            <pre className="max-h-[60vh] overflow-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-words">
              {page.text === '' ? t('verification.output.empty') : page.text}
            </pre>
            {page.more && (
              <Button
                variant="outline"
                size="sm"
                disabled={loading}
                onClick={() => void load(page.next, page)}
              >
                {t('verification.output.more')}
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
