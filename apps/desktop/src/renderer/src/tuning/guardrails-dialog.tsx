// 护栏的新建与编辑框（0.86.0）：种类分段、各种类的参数、范围（全局 / 本项目，只在新建且选了项目时有）。保存失败在框里显示原因。

import type { WevirClient } from '@wevir/client-sdk';
import type { WorkspaceId } from '@wevir/protocol';
import { GUARDRAIL_COMMAND_MAX_LENGTH, GUARDRAIL_PATTERN_MAX_LENGTH } from '@wevir/protocol';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { describe } from '@/host/host-connection';
import { t } from '@/i18n';
import { Segmented } from '@/settings/settings-ui';
import {
  draftValid,
  GUARDRAIL_KINDS,
  type GuardrailDraft,
  guardrailKindName,
  regexError,
  ruleOf,
  STOP_ATTEMPT_OPTIONS,
} from './guardrails-model';

export function GuardrailDialog({
  client,
  workspaceId,
  initial,
  onClose,
}: {
  client: WevirClient;
  /** 选中的项目；全局范围时省略（只能加全局规则）。 */
  workspaceId: string | undefined;
  initial: GuardrailDraft;
  /** `saved`：保存成功后关的。 */
  onClose: (saved?: boolean) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ids = { value: useId(), attempts: useId() };
  const set = (patch: Partial<GuardrailDraft>) => setDraft({ ...draft, ...patch });
  const editing = draft.id !== undefined;
  const badRegex = regexError(draft);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!draftValid(draft)) return;
    setBusy(true);
    setError(undefined);
    try {
      const rule = ruleOf(draft);
      if (draft.id !== undefined) {
        await client.request('guardrail.update', { guardrailId: draft.id, rule });
      } else {
        await client.request('guardrail.add', {
          rule,
          ...(draft.scope === 'project' &&
            workspaceId !== undefined && { workspaceId: workspaceId as WorkspaceId }),
        });
      }
      onClose(true);
    } catch (reason) {
      setError(t('tuning.guardrails.saveFailed', { error: describe(reason) }));
    } finally {
      setBusy(false);
    }
  };

  const label = (htmlFor: string | undefined, text: string): ReactNode =>
    htmlFor === undefined ? (
      <span className="text-sm font-medium">{text}</span>
    ) : (
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {text}
      </label>
    );

  const value =
    draft.kind === 'forbidden_command'
      ? { text: draft.pattern, key: 'pattern' as const, max: GUARDRAIL_PATTERN_MAX_LENGTH }
      : draft.kind === 'protected_path'
        ? { text: draft.glob, key: 'glob' as const, max: GUARDRAIL_PATTERN_MAX_LENGTH }
        : { text: draft.command, key: 'command' as const, max: GUARDRAIL_COMMAND_MAX_LENGTH };
  const valueLabel =
    draft.kind === 'forbidden_command'
      ? t('tuning.guardrails.field.pattern')
      : draft.kind === 'protected_path'
        ? t('tuning.guardrails.field.glob')
        : t('tuning.guardrails.field.command');
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-xl" showCloseButton={false} data-testid="guardrail-editor">
        <form onSubmit={(event) => void submit(event)} className="contents">
          <DialogHeader>
            <DialogTitle>
              {t(editing ? 'tuning.guardrails.editor.edit' : 'tuning.guardrails.editor.add')}
            </DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-3">
            {label(undefined, t('tuning.guardrails.field.kind'))}
            <div>
              <Segmented
                label={t('tuning.guardrails.field.kind')}
                value={draft.kind}
                onChange={(kind) => set({ kind })}
                options={GUARDRAIL_KINDS.map((kind) => ({
                  value: kind,
                  label: guardrailKindName(kind),
                }))}
              />
            </div>
            {draft.kind === 'forbidden_command' && (
              <>
                {label(undefined, t('tuning.guardrails.field.match'))}
                <div>
                  <Segmented<'prefix' | 'regex'>
                    label={t('tuning.guardrails.field.match')}
                    value={draft.match}
                    onChange={(match) => set({ match })}
                    options={[
                      { value: 'prefix', label: t('tuning.guardrails.match.prefix') },
                      { value: 'regex', label: t('tuning.guardrails.match.regex') },
                    ]}
                  />
                </div>
              </>
            )}
            {label(ids.value, valueLabel)}
            <Input
              id={ids.value}
              className="font-mono"
              value={value.text}
              maxLength={value.max}
              aria-invalid={badRegex !== undefined || undefined}
              onChange={(event) => set({ [value.key]: event.target.value })}
              data-testid="guardrail-value"
            />
            {badRegex !== undefined && (
              <p className="col-start-2 text-xs text-destructive" role="alert">
                {t('tuning.guardrails.regexInvalid', { error: badRegex })}
              </p>
            )}
            {draft.kind === 'stop_check' && (
              <>
                {label(ids.attempts, t('tuning.guardrails.field.attempts'))}
                <Select
                  id={ids.attempts}
                  className="w-28"
                  value={String(draft.maxAttempts)}
                  onValueChange={(next) => set({ maxAttempts: Number(next) })}
                  options={STOP_ATTEMPT_OPTIONS.map((n) => ({
                    value: String(n),
                    label: String(n),
                  }))}
                />
              </>
            )}
            {!editing && workspaceId !== undefined && (
              <>
                {label(undefined, t('tuning.guardrails.field.scope'))}
                <div>
                  <Segmented<'global' | 'project'>
                    label={t('tuning.guardrails.field.scope')}
                    value={draft.scope}
                    onChange={(scope) => set({ scope })}
                    options={[
                      { value: 'global', label: t('tuning.global') },
                      { value: 'project', label: t('tuning.guardrails.scope.project') },
                    ]}
                  />
                </div>
              </>
            )}
          </div>
          {error && (
            <p
              role="alert"
              className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => onClose()}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={busy || !draftValid(draft)}
              data-action="save-guardrail"
            >
              {t('tuning.guardrails.editor.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
