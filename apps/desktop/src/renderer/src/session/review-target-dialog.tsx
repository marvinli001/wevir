import { ReviewCommitShaSchema, ReviewInstructionsSchema, type TurnCommand } from '@wevir/protocol';
import { type FormEvent, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';

type ReviewDetails = { target: 'commit'; sha: string } | { target: 'custom'; instructions: string };

export function reviewTargetLabel(command: Extract<TurnCommand, { kind: 'review' }>): string {
  switch (command.target) {
    case 'branch':
      return command.baseBranch
        ? t('review.branch', { branch: command.baseBranch })
        : t('review.baseBranch');
    case 'commit':
      return command.sha ?? t('review.commit');
    case 'custom':
      return command.instructions ?? t('review.custom');
    case 'uncommitted':
      return t('review.uncommitted');
  }
}

export function ReviewTargetDialog({
  target,
  onClose,
  onSubmit,
}: {
  target: ReviewDetails['target'];
  onClose: () => void;
  onSubmit: (details: ReviewDetails) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const fieldId = useId();
  const errorId = `${fieldId}-error`;
  const changeValue = (next: string) => {
    setValue(next);
    setError(undefined);
  };
  const trimmed = value.trim();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!trimmed || busy) return;
    const valid =
      target === 'commit'
        ? ReviewCommitShaSchema.safeParse(trimmed)
        : ReviewInstructionsSchema.safeParse(trimmed);
    if (!valid.success) {
      setError(t(target === 'commit' ? 'review.invalidSha' : 'review.instructionsTooLong'));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await onSubmit(
        target === 'commit' ? { target, sha: trimmed } : { target, instructions: trimmed },
      );
      onClose();
    } catch (reason) {
      setError(describe(reason));
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-md" showCloseButton={false}>
        <form onSubmit={submit} className="contents">
          <DialogTitle>{t('command.review')}</DialogTitle>
          <div className="grid gap-1.5">
            <label htmlFor={fieldId} className="text-sm font-medium">
              {t(target === 'commit' ? 'review.sha' : 'review.instructions')}
            </label>
            {target === 'commit' ? (
              <Input
                id={fieldId}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                aria-invalid={error !== undefined || undefined}
                aria-describedby={error !== undefined ? errorId : undefined}
                value={value}
                disabled={busy}
                onChange={(event) => changeValue(event.target.value)}
                className="font-mono"
              />
            ) : (
              <Textarea
                id={fieldId}
                autoFocus
                rows={4}
                aria-invalid={error !== undefined || undefined}
                aria-describedby={error !== undefined ? errorId : undefined}
                value={value}
                disabled={busy}
                onChange={(event) => changeValue(event.target.value)}
                className="max-h-60 resize-y"
              />
            )}
            {error && (
              <p id={errorId} role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={!trimmed || busy}>
              {t('review.start')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
