// 换来源之前的接力预览（0.60.0，Host 功能 `handoff_preview`）：模型选择里选了别的来源的模型时出现。显示这次会交出的材料（方式、
// 范围、条目、能不能读历史与摘要正文）、材料预算的占用，可以填必须携带的约束、选入记忆笔记。确认时带上预览的绑定：之后有了新消息、
// 笔记改了等，Host 回 HANDOFF_STALE，这里刷新预览让用户再确认，绝不递交没看过的版本。

import { hostSupports, isRpcError } from '@wevir/client-sdk';
import type { MemorySummary, MethodResult, Session, WorkspaceId } from '@wevir/protocol';
import { cn } from 'cn';
import { Plus, X } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { useHostSettings } from '@/data/host-settings';
import { useAccounts, useWorkbenchData } from '@/data/workbench-data';
import { describe, useHostConnection } from '@/host/host-connection';
import { t } from '@/i18n';
import { RuleFileList } from '@/layout/rules-card';
import { handoffPreviewRows, modelLabel } from './handoff-model';
import {
  budgetUsage,
  HANDOFF_CONSTRAINT_MAX_CHARS,
  HANDOFF_MAX_CONSTRAINTS,
  HANDOFF_MAX_NOTES,
  handoffRequest,
  keepSelectable,
  type NoteChoice,
  noteKey,
  requestKey,
  selectableNotes,
} from './handoff-preview-model';
import type { ModelChoice } from './model-picker';

type PreviewResult = MethodResult<'session.handoffPreview'>;

/** 改了约束之后等这么久再重新预览。 */
const PREVIEW_DEBOUNCE_MS = 250;

export function HandoffPreviewDialog({
  session,
  target,
  label,
  onClose,
}: {
  session: Session;
  target: ModelChoice;
  /** 目标的“来源 · 模型”。 */
  label: string;
  onClose: () => void;
}) {
  const { client, view } = useHostConnection();
  const host = useHostSettings();
  const memorySupported =
    view.status === 'connected' && hostSupports(view.hello.features, 'memory');
  const [constraints, setConstraints] = useState<string[]>(['']);
  const [notes, setNotes] = useState<NoteChoice[]>([]);
  const [listing, setListing] = useState<MemorySummary[] | undefined>();
  const [result, setResult] = useState<{ key: string; value: PreviewResult } | undefined>();
  const [previewError, setPreviewError] = useState<string>();
  const [switchError, setSwitchError] = useState<string>();
  const [refreshed, setRefreshed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    if (!client || !memorySupported) return;
    return client.watchMemory(session.workspaceId as WorkspaceId, (value) =>
      setListing(value.notes),
    );
  }, [client, memorySupported, session.workspaceId]);

  const selectable = useMemo(
    () => selectableNotes(listing, host.settings),
    [listing, host.settings],
  );
  // 选中的笔记被停用、删掉或自动记忆关了：去掉。
  useEffect(() => {
    setNotes((current) => {
      const kept = keepSelectable(current, selectable);
      return kept.length === current.length ? current : kept;
    });
  }, [selectable]);

  const request = handoffRequest(constraints, notes);
  const key = requestKey(request);
  // 材料随这些变：编辑的约束与笔记、会话的新事件、笔记的新版本（`listing` 每次重读都是新对象），以及被 Host 退回之后。
  // biome-ignore lint/correctness/useExhaustiveDependencies: lastSeq、listing 与 refresh 只用来触发重新预览。
  useEffect(() => {
    if (!client) return;
    let current = true;
    const timer = window.setTimeout(() => {
      client
        .request('session.handoffPreview', {
          sessionId: session.id,
          providerId: target.providerId,
          ...(request !== undefined && { handoff: request }),
        })
        .then((value) => {
          if (!current) return;
          setResult({ key, value });
          setPreviewError(undefined);
        })
        .catch((error: unknown) => {
          if (current) setPreviewError(describe(error));
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [client, session.id, target.providerId, key, session.lastSeq, listing, refresh]);

  const shown = result?.value;
  // 显示的预览就是现在编辑的约束与笔记算出来的，才能确认。
  const upToDate = result !== undefined && result.key === key && previewError === undefined;
  const binding = upToDate ? shown?.binding : undefined;

  const confirm = async () => {
    if (!client || binding === undefined) return;
    setSwitching(true);
    setSwitchError(undefined);
    try {
      await client.request('session.configure', {
        sessionId: session.id,
        providerId: target.providerId,
        modelId: target.modelId,
        reasoningEffort: target.reasoningEffort ?? null,
        handoff: { ...request, binding },
      });
      onClose();
    } catch (error) {
      if (isRpcError(error, 'HANDOFF_STALE')) {
        setRefreshed(true);
        setResult(undefined);
        setRefresh((count) => count + 1);
      } else {
        setSwitchError(t('handoff.preview.switchFailed', { error: describe(error) }));
      }
    } finally {
      setSwitching(false);
    }
  };

  const toggleNote = (note: MemorySummary) => {
    setNotes((current) =>
      current.some((choice) => noteKey(choice) === noteKey(note))
        ? current.filter((choice) => noteKey(choice) !== noteKey(note))
        : [...current, { scope: note.scope, name: note.name }],
    );
  };
  const usage = shown === undefined ? undefined : budgetUsage(shown.preview);
  const notesOff = !memorySupported || host.settings.autoMemory === false;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="gap-3 sm:max-w-2xl" data-testid="handoff-preview">
        <DialogHeader>
          <DialogTitle>{t('handoff.preview.title', { model: label })}</DialogTitle>
        </DialogHeader>
        <div className="-mx-4 grid max-h-[min(70vh,40rem)] gap-4 overflow-y-auto px-4">
          {refreshed && (
            <p className="text-sm text-warning" data-testid="handoff-preview-refreshed">
              {t('handoff.preview.refreshed')}
            </p>
          )}
          {previewError !== undefined && (
            <p className="text-sm text-destructive">
              {t('handoff.preview.failed', { error: previewError })}
            </p>
          )}
          {shown === undefined ? (
            previewError === undefined && (
              <p className="text-sm text-muted-foreground">{t('handoff.preview.loading')}</p>
            )
          ) : (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              {handoffPreviewRows(shown.preview).map((row) => (
                <div key={row.key} className="contents" data-handoff-row={row.key}>
                  <dt className="text-muted-foreground">{row.label}</dt>
                  <dd
                    className={cn('min-w-0 break-words', row.tone === 'warning' && 'text-warning')}
                  >
                    {row.value}
                  </dd>
                </div>
              ))}
            </dl>
          )}

          {usage !== undefined && (
            <div className="grid gap-1.5" data-testid="handoff-budget">
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="text-muted-foreground">{t('handoff.preview.budget')}</span>
                <span className={cn('tabular-nums', usage.over && 'text-destructive')}>
                  {t('handoff.preview.budgetUsed', {
                    used: usage.used.toLocaleString(),
                    budget: usage.budget.toLocaleString(),
                  })}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    'h-full rounded-full',
                    usage.over ? 'bg-destructive' : 'bg-primary',
                  )}
                  style={{ width: `${Math.max(usage.ratio * 100, usage.used > 0 ? 1 : 0)}%` }}
                />
              </div>
              {usage.over && (
                <p className="text-sm text-destructive" data-testid="handoff-over-budget">
                  {t('handoff.preview.overBudget')}
                </p>
              )}
            </div>
          )}

          <section className="grid gap-2">
            <h3 className="text-sm font-medium">{t('handoff.preview.constraints')}</h3>
            {constraints.map((text, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: 约束只在末尾增加、按位置删除，位置就是身份。
              <div key={index} className="flex items-start gap-1.5">
                <div className="grid flex-1 gap-0.5">
                  <Textarea
                    value={text}
                    maxLength={HANDOFF_CONSTRAINT_MAX_CHARS}
                    placeholder={t('handoff.preview.constraintPlaceholder')}
                    className="min-h-12"
                    data-handoff-constraint={index}
                    onChange={(event) => {
                      const value = event.target.value;
                      setConstraints((current) =>
                        current.map((entry, at) => (at === index ? value : entry)),
                      );
                    }}
                  />
                  {text.length > HANDOFF_CONSTRAINT_MAX_CHARS * 0.8 && (
                    <span className="text-right text-xs text-muted-foreground tabular-nums">
                      {t('handoff.preview.constraintChars', {
                        count: text.length,
                        max: HANDOFF_CONSTRAINT_MAX_CHARS,
                      })}
                    </span>
                  )}
                </div>
                <IconButton
                  label={t('handoff.preview.removeConstraint')}
                  onClick={() =>
                    setConstraints((current) =>
                      current.length === 1 ? [''] : current.filter((_, at) => at !== index),
                    )
                  }
                >
                  <X />
                </IconButton>
              </div>
            ))}
            {constraints.length < HANDOFF_MAX_CONSTRAINTS && (
              <Button
                variant="ghost"
                size="sm"
                className="justify-self-start"
                onClick={() => setConstraints((current) => [...current, ''])}
              >
                <Plus />
                {t('handoff.preview.addConstraint')}
              </Button>
            )}
          </section>

          <section className="grid gap-2">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-sm font-medium">{t('handoff.preview.notes')}</h3>
              {!notesOff && (
                <span className="text-xs text-muted-foreground">
                  {t('handoff.preview.notesHint', { max: HANDOFF_MAX_NOTES })}
                </span>
              )}
            </div>
            {notesOff ? (
              <p className="text-sm text-muted-foreground">
                {memorySupported ? t('handoff.preview.notesOff') : t('settings.memory.unsupported')}
              </p>
            ) : selectable.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('handoff.preview.notesEmpty')}</p>
            ) : (
              <div className="max-h-48 space-y-0.5 overflow-y-auto rounded-lg border border-border p-1">
                {selectable.map((note) => {
                  const checked = notes.some((choice) => noteKey(choice) === noteKey(note));
                  return (
                    <label
                      key={noteKey(note)}
                      className="flex cursor-default items-start gap-2.5 rounded-md px-2.5 py-2 text-sm transition-[background-color,box-shadow] duration-150 ease-smooth hover:bg-muted/50 has-data-checked:bg-selected has-data-checked:ring-1 has-data-checked:ring-selected-border has-data-checked:ring-inset"
                      data-handoff-note={noteKey(note)}
                    >
                      <Checkbox
                        className="mt-0.5"
                        checked={checked}
                        disabled={!checked && notes.length >= HANDOFF_MAX_NOTES}
                        onCheckedChange={() => toggleNote(note)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{note.description || note.name}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {t(`handoff.preview.scope.${note.scope}`)} · {note.name}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </section>

          {shown?.preview.rules !== undefined && shown.preview.rules.files.length > 0 && (
            <section className="grid gap-1.5" data-testid="handoff-rules">
              <h3 className="text-sm font-medium">{t('handoff.preview.rules')}</h3>
              <RuleFileList rules={shown.preview.rules} cwd={session.cwd} />
            </section>
          )}

          {shown !== undefined &&
            (shown.preview.context !== undefined ? (
              <section className="grid gap-1.5">
                <h3 className="text-sm font-medium">{t('handoff.detail.context')}</h3>
                <pre
                  className="max-h-[min(40vh,20rem)] overflow-auto rounded-lg border border-border bg-muted/40 px-3 py-2 font-mono text-xs break-words whitespace-pre-wrap"
                  data-testid="handoff-preview-context"
                >
                  {shown.preview.context}
                </pre>
              </section>
            ) : (
              shown.preview.overBudget === undefined && (
                <p className="text-sm text-muted-foreground">{t('handoff.preview.nothing')}</p>
              )
            ))}
        </div>
        {switchError !== undefined && <p className="text-sm text-destructive">{switchError}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            disabled={binding === undefined || switching}
            onClick={() => void confirm()}
            data-testid="handoff-confirm"
          >
            {t('handoff.preview.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 换来源走预览（0.60.0）：Host 有 `handoff_preview` 时，`open` 打开预览，由它确认后再切换；旧 Host 没有 `open`，照旧直接切换。
 * `dialog` 放进组件的输出里。
 */
export function useHandoffPreview(session: Session): {
  open: ((next: ModelChoice) => void) | undefined;
  dialog: ReactNode;
} {
  const { view } = useHostConnection();
  const data = useWorkbenchData();
  const accounts = useAccounts();
  const providers = data.status === 'ready' ? data.providers : [];
  const supported =
    view.status === 'connected' && hostSupports(view.hello.features, 'handoff_preview');
  const [target, setTarget] = useState<ModelChoice>();
  return {
    open: supported ? setTarget : undefined,
    dialog: target !== undefined && (
      <HandoffPreviewDialog
        session={session}
        target={target}
        label={modelLabel(providers, target.providerId, target.modelId, accounts)}
        onClose={() => setTarget(undefined)}
      />
    ),
  };
}
