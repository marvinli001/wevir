// 设置 → 项目 → 检查与自动修复（0.65.0，Host 功能 `verification`）：所选项目的检查（添加、编辑、移除）、仓库里声明的命令（只列出，
// 不执行；添加后才是检查，脚本正文变了要重新保存）与自动修复的开关和上限。配置存在 Host，不写回仓库。旧 Host 不显示这一节。

import { hostSupports } from '@wevir/client-sdk';
import type {
  CheckCandidate,
  CheckDefinition,
  CheckKind,
  CheckTrigger,
  RepairSettings,
  WorkspaceId,
} from '@wevir/protocol';
import { CHECK_COMMAND_MAX_LENGTH, CHECK_NAME_MAX_LENGTH } from '@wevir/protocol';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { IconButton } from '@/components/icon-button';
import { Switch } from '@/components/switch';
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
import type { WorkspaceEntry } from '@/data/workbench-model';
import { describe, useHostConnection } from '@/host/host-connection';
import { currentLocale, t } from '@/i18n';
import { useLastLocation } from '@/routes/last-location';
import {
  type CheckDraft,
  candidateSaved,
  draftOf,
  draftOfCandidate,
  draftValid,
  inputOf,
  KIND_LABELS,
  REPAIR_ATTEMPT_OPTIONS,
  REPAIR_DURATION_OPTIONS_MIN,
  REPAIR_TOKEN_OPTIONS,
  sourceText,
  TRIGGER_LABELS,
} from './checks-model';
import { defaultMemoryWorkspace } from './memory-model';
import {
  EmptyList,
  LIST_CARD,
  type Notice,
  NoticeBanner,
  Segmented,
  SettingsRow,
  SettingsSection,
} from './settings-ui';

export function ChecksSettings({ projects }: { projects: readonly WorkspaceEntry[] }) {
  const { client, view } = useHostConnection();
  const supported =
    view.status === 'connected' && hostSupports(view.hello.features, 'verification');
  const last = useLastLocation();
  const [picked, setPicked] = useState<string>();
  const [checks, setChecks] = useState<CheckDefinition[]>();
  const [repair, setRepair] = useState<RepairSettings>();
  const [candidates, setCandidates] = useState<CheckCandidate[]>();
  const [notice, setNotice] = useState<Notice>();
  const [editing, setEditing] = useState<CheckDraft>();
  const [removing, setRemoving] = useState<CheckDefinition>();
  const workspaceId = (
    projects.some((entry) => entry.workspace.id === picked)
      ? picked
      : defaultMemoryWorkspace(projects, last?.workspaceId)
  ) as WorkspaceId | undefined;

  const reload = useCallback(async () => {
    if (!client || workspaceId === undefined) return;
    try {
      const [listed, found] = await Promise.all([
        client.request('checks.list', { workspaceId }),
        client.request('checks.candidates', { workspaceId }),
      ]);
      setChecks(listed.checks);
      setRepair(listed.repair);
      setCandidates(found.candidates);
    } catch (reason) {
      setNotice({
        tone: 'error',
        text: t('settings.checks.loadFailed', { error: describe(reason) }),
      });
    }
  }, [client, workspaceId]);

  useEffect(() => {
    if (!supported) return;
    setChecks(undefined);
    setCandidates(undefined);
    setRepair(undefined);
    setNotice(undefined);
    void reload();
  }, [supported, reload]);

  if (!supported || projects.length === 0 || workspaceId === undefined) return null;

  const updateRepair = async (patch: Partial<RepairSettings>) => {
    if (!client) return;
    setNotice(undefined);
    try {
      const result = await client.request('checks.setRepair', { workspaceId, repair: patch });
      setRepair(result.repair);
    } catch (reason) {
      setNotice({
        tone: 'error',
        text: t('settings.checks.saveFailed', { error: describe(reason) }),
      });
    }
  };

  const remove = async () => {
    if (!client || !removing) return;
    await client.request('checks.remove', { workspaceId, checkId: removing.id });
    await reload();
  };

  const unsaved = (candidates ?? []).filter((item) => !candidateSaved(item, checks ?? []));
  const numberFormat = new Intl.NumberFormat(currentLocale(), { notation: 'compact' });

  return (
    <>
      <SettingsSection
        title={t('settings.checks')}
        action={
          <>
            {projects.length > 1 && (
              <Select
                aria-label={t('settings.checks.projectPicker')}
                className="w-48"
                value={workspaceId}
                onValueChange={setPicked}
                options={projects.map((entry) => ({
                  value: entry.workspace.id,
                  label: entry.workspace.displayName,
                }))}
                data-testid="checks-project"
              />
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={!client || checks === undefined}
              onClick={() => setEditing(draftOf())}
              data-action="add-check"
            >
              <Plus data-icon="inline-start" />
              {t('settings.checks.add')}
            </Button>
          </>
        }
        data-testid="checks-settings"
      >
        <div className="space-y-3">
          {notice && <NoticeBanner notice={notice} />}
          {checks === undefined ? (
            <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
          ) : checks.length === 0 ? (
            <EmptyList>{t('settings.checks.empty')}</EmptyList>
          ) : (
            <ul className={LIST_CARD}>
              {checks.map((check) => (
                <CheckRow
                  key={check.id}
                  check={check}
                  onEdit={() => setEditing(draftOf(check))}
                  onRemove={() => setRemoving(check)}
                />
              ))}
            </ul>
          )}
        </div>
      </SettingsSection>

      {unsaved.length > 0 && (
        <SettingsSection title={t('settings.checks.candidates')} data-testid="checks-candidates">
          <ul className={LIST_CARD}>
            {unsaved.map((candidate) => (
              <li
                key={`${candidate.cwd}\0${candidate.command}`}
                className="flex items-center gap-3 px-4 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-sm">{candidate.command}</p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {candidate.source.kind === 'package_script'
                      ? `${candidate.source.file} · ${candidate.source.body}`
                      : `${candidate.source.file}:${candidate.source.line}`}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setEditing(draftOfCandidate(candidate))}
                  data-action="use-candidate"
                >
                  {t('settings.checks.candidates.use')}
                </Button>
              </li>
            ))}
          </ul>
        </SettingsSection>
      )}

      {repair && (
        <SettingsSection title={t('settings.checks.repair')} data-testid="checks-repair">
          <div className={LIST_CARD}>
            <SettingsRow
              title={t('settings.checks.repair.enabled')}
              control={
                <Switch
                  checked={repair.enabled}
                  label={t('settings.checks.repair.enabled')}
                  onChange={(enabled) => void updateRepair({ enabled })}
                  data-action="toggle-repair"
                />
              }
            />
            {repair.enabled && (
              <>
                <SettingsRow
                  title={t('settings.checks.repair.attempts')}
                  control={
                    <Select
                      aria-label={t('settings.checks.repair.attempts')}
                      className="w-36"
                      value={String(repair.maxAttempts)}
                      onValueChange={(value) => void updateRepair({ maxAttempts: Number(value) })}
                      options={REPAIR_ATTEMPT_OPTIONS.map((n) => ({
                        value: String(n),
                        label: String(n),
                      }))}
                    />
                  }
                />
                <SettingsRow
                  title={t('settings.checks.repair.duration')}
                  control={
                    <Select
                      aria-label={t('settings.checks.repair.duration')}
                      className="w-36"
                      value={String(repair.maxDurationMs / 60_000)}
                      onValueChange={(value) =>
                        void updateRepair({ maxDurationMs: Number(value) * 60_000 })
                      }
                      options={withCurrent(
                        REPAIR_DURATION_OPTIONS_MIN,
                        repair.maxDurationMs / 60_000,
                      ).map((n) => ({
                        value: String(n),
                        label: t('settings.checks.repair.minutes', { count: n }),
                      }))}
                    />
                  }
                />
                <SettingsRow
                  title={t('settings.checks.repair.tokens')}
                  control={
                    <Select
                      aria-label={t('settings.checks.repair.tokens')}
                      className="w-36"
                      value={String(repair.maxTokens)}
                      onValueChange={(value) => void updateRepair({ maxTokens: Number(value) })}
                      options={withCurrent(REPAIR_TOKEN_OPTIONS, repair.maxTokens).map((n) => ({
                        value: String(n),
                        label: t('settings.checks.repair.tokenCount', {
                          count: numberFormat.format(n),
                        }),
                      }))}
                    />
                  }
                />
              </>
            )}
          </div>
        </SettingsSection>
      )}

      {editing && (
        <CheckEditor
          workspaceId={workspaceId}
          initial={editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            void reload();
          }}
        />
      )}
      <ConfirmDialog
        open={removing !== undefined}
        onOpenChange={(open) => !open && setRemoving(undefined)}
        title={t('settings.checks.removeTitle', { name: removing?.name ?? '' })}
        confirmLabel={t('settings.checks.remove')}
        onConfirm={remove}
        failure={(error) => t('verification.failed', { error })}
      >
        <p className="font-mono text-xs break-all">{removing?.command}</p>
      </ConfirmDialog>
    </>
  );
}

/** 选项里补上当前值（CLI 或旧版本设的不在列表里的值）。 */
function withCurrent(options: readonly number[], current: number): number[] {
  return options.includes(current) ? [...options] : [...options, current].sort((a, b) => a - b);
}

function CheckRow({
  check,
  onEdit,
  onRemove,
}: {
  check: CheckDefinition;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const source = sourceText(check);
  const meta = [
    t(KIND_LABELS[check.kind]),
    t(TRIGGER_LABELS[check.trigger]),
    ...(check.paths ?? []),
    ...(source !== undefined ? [source] : []),
  ];
  return (
    <li className="flex items-center gap-3 px-4 py-3" data-check-id={check.id}>
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-2">
          <span className="truncate text-sm font-medium">{check.name}</span>
          {check.cwd !== '' && (
            <span className="shrink-0 font-mono text-xs text-muted-foreground">{check.cwd}</span>
          )}
        </p>
        <p className="mt-0.5 truncate font-mono text-xs text-soft-foreground">{check.command}</p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{meta.join(' · ')}</p>
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        <IconButton label={t('settings.checks.edit')} onClick={onEdit} data-action="edit-check">
          <Pencil />
        </IconButton>
        <IconButton
          label={t('settings.checks.remove')}
          onClick={onRemove}
          data-action="remove-check"
        >
          <Trash2 />
        </IconButton>
      </div>
    </li>
  );
}

function CheckEditor({
  workspaceId,
  initial,
  onClose,
  onSaved,
}: {
  workspaceId: WorkspaceId;
  initial: CheckDraft;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { client } = useHostConnection();
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const ids = {
    name: useId(),
    command: useId(),
    cwd: useId(),
    kind: useId(),
    paths: useId(),
    timeout: useId(),
    expect: useId(),
  };
  const set = (patch: Partial<CheckDraft>) => setDraft({ ...draft, ...patch });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!client || !draftValid(draft)) return;
    setBusy(true);
    setError(undefined);
    try {
      await client.request('checks.save', { workspaceId, check: inputOf(draft) });
      onSaved();
    } catch (reason) {
      setError(t('settings.checks.saveFailed', { error: describe(reason) }));
    } finally {
      setBusy(false);
    }
  };

  const field = (id: string, label: string) => (
    <label htmlFor={id} className="text-sm font-medium">
      {label}
    </label>
  );

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent className="sm:max-w-xl" showCloseButton={false} data-testid="check-editor">
        <form onSubmit={(event) => void submit(event)} className="contents">
          <DialogHeader>
            <DialogTitle>
              {t(
                draft.id === undefined
                  ? 'settings.checks.editor.add'
                  : 'settings.checks.editor.edit',
              )}
            </DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-3">
            {field(ids.name, t('settings.checks.field.name'))}
            <Input
              id={ids.name}
              value={draft.name}
              maxLength={CHECK_NAME_MAX_LENGTH}
              onChange={(event) => set({ name: event.target.value })}
              data-testid="check-name"
            />
            {field(ids.command, t('settings.checks.field.command'))}
            <Input
              id={ids.command}
              className="font-mono"
              value={draft.command}
              maxLength={CHECK_COMMAND_MAX_LENGTH}
              onChange={(event) => set({ command: event.target.value })}
              data-testid="check-command"
            />
            {field(ids.cwd, t('settings.checks.field.cwd'))}
            <Input
              id={ids.cwd}
              className="font-mono"
              value={draft.cwd}
              placeholder={t('settings.checks.field.cwd.placeholder')}
              onChange={(event) => set({ cwd: event.target.value })}
            />
            {field(ids.kind, t('settings.checks.field.kind'))}
            <Select
              id={ids.kind}
              className="w-40"
              value={draft.kind}
              onValueChange={(kind: CheckKind) => set({ kind })}
              options={Object.entries(KIND_LABELS).map(([value, label]) => ({
                value: value as CheckKind,
                label: t(label),
              }))}
            />
            <span className="text-sm font-medium">{t('settings.checks.field.trigger')}</span>
            <div>
              <Segmented<CheckTrigger>
                label={t('settings.checks.field.trigger')}
                value={draft.trigger}
                onChange={(trigger) => set({ trigger })}
                options={(['manual', 'after_turn'] as const).map((value) => ({
                  value,
                  label: t(TRIGGER_LABELS[value]),
                }))}
              />
            </div>
            {field(ids.paths, t('settings.checks.field.paths'))}
            <Input
              id={ids.paths}
              className="font-mono"
              value={draft.paths}
              placeholder="src/, test/**"
              onChange={(event) => set({ paths: event.target.value })}
              data-testid="check-paths"
            />
            {field(ids.timeout, t('settings.checks.field.timeout'))}
            <Input
              id={ids.timeout}
              className="w-28"
              inputMode="decimal"
              value={draft.timeout}
              onChange={(event) => set({ timeout: event.target.value })}
            />
            {field(ids.expect, t('settings.checks.field.expect'))}
            <Input
              id={ids.expect}
              className="font-mono"
              value={draft.expectOutput}
              onChange={(event) => set({ expectOutput: event.target.value })}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={busy || !client || !draftValid(draft)}
              data-action="save-check"
            >
              {t('settings.checks.editor.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
