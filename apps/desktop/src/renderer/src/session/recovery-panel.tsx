import type { EngineErrorInfo, SessionReadOnly, SessionState } from '@wevir/protocol';
import { cn } from 'cn';
import { CircleAlert, History, Lock, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';

/**
 * 会话出错或只读时，输入框上方说明原因并给出能做的事（T5.5）：出错时“恢复会话”（session.resume）；只读时
 * “基于历史新建会话”，引擎数据可能已经找回，所以也能“再试一次恢复”。其他状态不显示。换会话、出错变为只读时
 * 由调用方用 key 重建，清掉上一次的失败提示。
 */
export function RecoveryPanel({
  state,
  readOnly,
  lastError,
  disabled,
  onResume,
  onFromHistory,
}: {
  state: SessionState | undefined;
  readOnly: SessionReadOnly | undefined;
  lastError: EngineErrorInfo | undefined;
  /** 还没连上 Host。 */
  disabled: boolean;
  onResume: () => Promise<void>;
  onFromHistory: () => void;
}) {
  const [resuming, setResuming] = useState(false);
  const [failure, setFailure] = useState<string>();
  if (!readOnly && state !== 'error') return null;

  const resume = async () => {
    setResuming(true);
    setFailure(undefined);
    try {
      await onResume();
    } catch (error) {
      setFailure(t('recovery.resumeFailed', { error: describe(error) }));
    } finally {
      setResuming(false);
    }
  };
  const resumeLabel = resuming ? t('recovery.resuming') : undefined;

  return (
    <section
      data-testid="recovery-panel"
      data-kind={readOnly ? 'read-only' : 'error'}
      aria-labelledby="recovery-title"
      className={cn(
        'mb-2 rounded-xl border px-3.5 py-3 text-sm',
        readOnly ? 'border-destructive/30 bg-destructive/5' : 'border-warning/30 bg-warning/5',
      )}
    >
      <h2
        id="recovery-title"
        className={cn(
          'flex items-center gap-2 font-medium',
          readOnly ? 'text-destructive' : 'text-warning',
        )}
      >
        {readOnly ? <Lock className="size-4" /> : <CircleAlert className="size-4" />}
        {t(readOnly ? 'recovery.readOnlyTitle' : 'recovery.errorTitle')}
      </h2>
      <div className="mt-1.5 space-y-1 text-muted-foreground">
        {readOnly ? (
          <>
            <p className="text-foreground">{t(`readOnly.${readOnly.reason}`)}</p>
            <p className="line-clamp-3 font-mono text-xs break-all" title={readOnly.message}>
              {t('recovery.engineMessage', { message: readOnly.message })}
            </p>
            <p>{t('recovery.readOnlyHint')}</p>
          </>
        ) : (
          <>
            {lastError && (
              <>
                <p className="line-clamp-3 break-words text-foreground" title={lastError.message}>
                  {t(`engineError.category.${lastError.category}`)}：{lastError.message}
                </p>
                <p>{t(`engineError.hint.${lastError.category}`)}</p>
              </>
            )}
            <p>{t('recovery.errorHint')}</p>
          </>
        )}
      </div>
      {failure && (
        <p role="alert" className="mt-2 text-destructive">
          {failure}
        </p>
      )}
      <div className="mt-2.5 flex flex-wrap gap-2">
        {readOnly ? (
          <>
            <Button size="sm" disabled={disabled} onClick={onFromHistory}>
              <History data-icon="inline-start" />
              {t('recovery.fromHistory')}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || resuming}
              onClick={() => void resume()}
            >
              <RotateCcw data-icon="inline-start" />
              {resumeLabel ?? t('recovery.retryResume')}
            </Button>
          </>
        ) : (
          <Button size="sm" disabled={disabled || resuming} onClick={() => void resume()}>
            <RotateCcw data-icon="inline-start" />
            {resumeLabel ?? t('recovery.resume')}
          </Button>
        )}
      </div>
    </section>
  );
}
