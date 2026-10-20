// 新建 / 编辑自动化的对话框（0.66.0）：照 Claude 的 “New scheduled task” 与 ChatGPT 的“设置定时任务”。名称；指令框底下是权限与
// 模型芯片（同输入框）；完全访问时一行警示；“重复”与时间成组的一张卡片；“高级”收起：项目、运行于、通知、检查脚本。
// 0.71.0（Host 功能 `automation_conditions`）：“运行于”可以选一个已有会话（项目与模型随那个会话，不显示这两项）；检查脚本可以
// 试运行，结果显示在下面。
// 全局一个（routes/router.tsx 的 AppRoot），`openAutomationDialog` 打开；保存成功后关闭并跳到详情页（新建时）。

import type {
  Automation,
  AutomationCheckResult,
  AutomationCheckWake,
  AutomationNotify,
  Session,
} from '@wevir/protocol';
import { cn } from 'cn';
import { ChevronDown, LoaderCircle, Play, TriangleAlert } from 'lucide-react';
import { type FormEvent, type ReactNode, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Collapse } from '@/components/collapse';
import { Switch } from '@/components/switch';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, type SelectOption } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useWorkbenchData } from '@/data/workbench-data';
import { projectsOf, recentWorkspaces } from '@/data/workbench-model';
import { describe, useHostConnection } from '@/host/host-connection';
import { type PlainMessageKey, t } from '@/i18n';
import { createStore } from '@/lib/store';
import { useChatsSupported } from '@/projects/chats';
import { paths } from '@/routes/paths';
import { ModelPicker } from '@/session/model-picker';
import { PermissionPicker, usePermissionChoice } from '@/session/permission-picker';
import { useModelChoice } from '@/session/start-session';
import {
  type AutomationDraft,
  conditionsSupported,
  createParams,
  defaultScheduleDraft,
  draftOfAutomation,
  draftOfSchedule,
  draftProblem,
  INTERVAL_CHOICES,
  localTimezone,
  REPEAT_LABEL,
  REPEATS,
  type Repeat,
  runTargetOf,
  type ScheduleDraft,
  timezoneLabel,
  updateParams,
  WEEK_ORDER,
  weekdayName,
  withRunTarget,
} from './automations-model';
import { type AutomationTemplate, templateText } from './templates';

export type AutomationDialogRequest =
  | { kind: 'create'; template?: AutomationTemplate; workspaceId?: string; sessionId?: string }
  | { kind: 'edit'; automation: Automation };

const request = createStore<AutomationDialogRequest | null>(null);

export function openAutomationDialog(next: AutomationDialogRequest): void {
  request.set(next);
}

export function AutomationDialog() {
  const current = request.use();
  return (
    <Dialog open={current !== null} onOpenChange={(open) => !open && request.set(null)}>
      {current && <AutomationForm request={current} onDone={() => request.set(null)} />}
    </Dialog>
  );
}

const NOTIFY_LABEL: Record<AutomationNotify, PlainMessageKey> = {
  always: 'automations.notify.always',
  important: 'automations.notify.important',
  changes: 'automations.notify.changes',
  failures: 'automations.notify.failures',
  never: 'automations.notify.never',
};
const NOTIFY_ORDER: readonly AutomationNotify[] = [
  'important',
  'changes',
  'always',
  'failures',
  'never',
];

const WAKE_ORDER: readonly AutomationCheckWake[] = ['exit_code', 'output_changed'];
const WAKE_LABEL: Record<AutomationCheckWake, PlainMessageKey> = {
  exit_code: 'automations.wake.exit_code',
  output_changed: 'automations.wake.output_changed',
};

/** “运行于”里列出的已有会话个数（最近活动的）。 */
const RECENT_SESSIONS = 8;

/** 能接着发消息的会话：不是子会话、没关闭、不是只读、不是别的自动化开的。 */
function targetable(session: Session): boolean {
  return (
    session.parentSessionId === undefined &&
    session.state !== 'closed' &&
    session.readOnly === undefined &&
    session.automation === undefined
  );
}

/** 项目下拉里“不在项目中”的值。 */
const NO_PROJECT = '__none__';

function AutomationForm({
  request: current,
  onDone,
}: {
  request: AutomationDialogRequest;
  onDone: () => void;
}) {
  const { client } = useHostConnection();
  const conditions = conditionsSupported(client?.hello.features);
  const navigate = useNavigate();
  const workbench = useWorkbenchData();
  const chatsSupported = useChatsSupported();
  const models = useModelChoice();
  const permission = usePermissionChoice();
  const projects = workbench.status === 'ready' ? projectsOf(workbench.workspaces) : [];
  const [draft, setDraft] = useState<AutomationDraft>(() => {
    if (current.kind === 'edit') return draftOfAutomation(current.automation, Date.now());
    const timezone = localTimezone();
    const recent = recentWorkspaces(projects, 1)[0]?.workspace.id;
    // 默认在最近用的项目里（模板多是对仓库的任务）；没有项目时不在项目中。
    const workspaceId = current.workspaceId ?? recent;
    const text = current.template && templateText(current.template);
    return {
      title: text?.title ?? '',
      prompt: text?.prompt ?? '',
      schedule: current.template
        ? draftOfSchedule(current.template.schedule, timezone, Date.now())
        : defaultScheduleDraft(Date.now(), timezone),
      timezone,
      ...(workspaceId !== undefined && { workspaceId }),
      ...(models.choice && { model: models.choice }),
      permissionMode: permission.mode,
      newSessionEachRun: current.sessionId === undefined,
      ...(current.sessionId !== undefined && { sessionId: current.sessionId }),
      notify: 'important',
      enabled: true,
    };
  });
  const [advanced, setAdvanced] = useState(
    current.kind === 'create' && current.sessionId !== undefined,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const editing = current.kind === 'edit';
  // 建对话框时 Provider 还没读到：读到后补上默认模型。
  const model = draft.model ?? models.choice;
  const effective: AutomationDraft = model ? { ...draft, model } : draft;
  const problem =
    draftProblem(effective) ??
    (effective.workspaceId === undefined && !chatsSupported ? 'project' : undefined);

  const patch = (next: Partial<AutomationDraft>) => setDraft((prev) => ({ ...prev, ...next }));
  const patchSchedule = (next: Partial<ScheduleDraft>) =>
    setDraft((prev) => ({ ...prev, schedule: { ...prev.schedule, ...next } }));

  const allSessions = useMemo(
    () =>
      workbench.status === 'ready'
        ? workbench.workspaces.flatMap((entry) =>
            entry.sessions.map((session) => ({ session, workspace: entry.workspace })),
          )
        : [],
    [workbench],
  );
  const target = runTargetOf(draft);
  const targetOptions = useMemo<SelectOption[]>(() => {
    const recent = allSessions
      .filter(({ session }) => targetable(session))
      .sort((a, b) => b.session.updatedAt.localeCompare(a.session.updatedAt))
      .slice(0, RECENT_SESSIONS);
    const chosen = allSessions.find(({ session }) => session.id === draft.sessionId);
    const listed = chosen === undefined || recent.includes(chosen) ? recent : [chosen, ...recent];
    const label = (session: Session, workspace: { displayName: string; kind?: string }) =>
      `${session.title || t('session.untitled')} · ${
        workspace.kind === 'chats' ? t('automations.field.noProject') : workspace.displayName
      }`;
    return [
      { value: 'new', label: t('automations.runsIn.new') },
      { value: 'same', label: t('automations.runsIn.same') },
      ...listed.map(({ session, workspace }) => ({
        value: session.id,
        label: label(session, workspace),
      })),
      ...(draft.sessionId !== undefined && chosen === undefined
        ? [{ value: draft.sessionId, label: t('automations.runsIn.same') }]
        : []),
    ];
  }, [allSessions, draft.sessionId]);
  const inSession = draft.sessionId !== undefined;

  const projectOptions = useMemo<SelectOption[]>(
    () => [
      ...(chatsSupported || effective.workspaceId === undefined
        ? [{ value: NO_PROJECT, label: t('automations.field.noProject') }]
        : []),
      ...projects.map((entry) => ({
        value: entry.workspace.id,
        label: entry.workspace.displayName,
      })),
    ],
    [chatsSupported, effective.workspaceId, projects],
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (client === undefined || problem !== undefined || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      if (current.kind === 'edit') {
        const params = updateParams(current.automation, effective, conditions);
        if (params) await client.request('automation.update', params);
        onDone();
      } else {
        const params = createParams(effective);
        if (!params) return;
        const { automation } = await client.request('automation.create', params);
        if (effective.model) models.choose(effective.model);
        onDone();
        navigate(paths.automation(automation.id));
      }
    } catch (reason) {
      setError(t('automations.saveFailed', { error: describe(reason) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogContent
      className="max-h-[calc(100dvh-2rem)] gap-5 overflow-y-auto p-5 sm:max-w-140"
      data-testid="automation-dialog"
    >
      <DialogTitle className="text-lg font-semibold">
        {t(editing ? 'automations.dialog.editTitle' : 'automations.dialog.createTitle')}
      </DialogTitle>
      <form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
        <Input
          value={draft.title}
          onChange={(event) => patch({ title: event.target.value })}
          placeholder={t('automations.field.title')}
          aria-label={t('automations.field.title')}
          maxLength={120}
          autoFocus={!editing}
          data-field="title"
        />

        <div className="rounded-xl border border-input bg-card focus-within:focus-field">
          <Textarea
            value={draft.prompt}
            onChange={(event) => patch({ prompt: event.target.value })}
            placeholder={t('automations.field.prompt')}
            aria-label={t('automations.field.prompt')}
            className="max-h-72 min-h-28 resize-none border-0 bg-transparent px-3 pt-2.5 focus-visible:ring-0"
            data-field="prompt"
          />
          <div className="flex items-center justify-between gap-2 px-1.5 pb-1.5">
            <PermissionPicker
              value={draft.permissionMode}
              onChange={(permissionMode) => patch({ permissionMode })}
            />
            {models.providers && model && !inSession && (
              <ModelPicker
                providers={models.providers}
                value={model}
                onChange={(next) => patch({ model: next })}
              />
            )}
          </div>
        </div>
        {draft.permissionMode === 'full_access' && (
          <p className="-mt-2 flex items-start gap-1.5 text-xs text-warning">
            <TriangleAlert aria-hidden className="mt-px size-3.5 shrink-0" />
            {t('automations.dialog.fullAccessWarning')}
          </p>
        )}

        <ScheduleCard draft={draft.schedule} timezone={draft.timezone} onChange={patchSchedule} />

        <div>
          <button
            type="button"
            className="flex items-center gap-1 rounded-md text-sm font-medium text-soft-foreground outline-none hover:text-foreground focus-visible:focus-ring"
            aria-expanded={advanced}
            onClick={() => setAdvanced((open) => !open)}
            data-action="advanced"
          >
            {t('automations.dialog.advanced')}
            <ChevronDown
              aria-hidden
              className={cn('size-4 transition-transform duration-150', advanced && 'rotate-180')}
            />
          </button>
          <Collapse open={advanced}>
            <Card className="mt-2">
              {!inSession && (
                <Row label={t('automations.field.project')}>
                  <Select
                    className="w-52"
                    value={effective.workspaceId ?? NO_PROJECT}
                    options={projectOptions}
                    aria-label={t('automations.field.project')}
                    onValueChange={(value) =>
                      setDraft(({ workspaceId: _, ...rest }) =>
                        value === NO_PROJECT ? rest : { ...rest, workspaceId: value },
                      )
                    }
                    data-field="project"
                  />
                </Row>
              )}
              {conditions ? (
                <Row label={t('automations.field.runsIn')}>
                  <Select
                    className="w-52"
                    value={target}
                    options={targetOptions}
                    aria-label={t('automations.field.runsIn')}
                    onValueChange={(value) => setDraft((prev) => withRunTarget(prev, value))}
                    data-field="run-target"
                  />
                </Row>
              ) : (
                <Row label={t('automations.field.newSessionEachRun')}>
                  <Switch
                    checked={draft.newSessionEachRun}
                    label={t('automations.field.newSessionEachRun')}
                    onChange={(newSessionEachRun) => patch({ newSessionEachRun })}
                    data-action="new-session-each-run"
                  />
                </Row>
              )}
              <Row label={t('automations.field.notify')}>
                <Select
                  className="w-52"
                  value={draft.notify}
                  options={NOTIFY_ORDER.filter((value) => conditions || value !== 'changes').map(
                    (value) => ({ value, label: t(NOTIFY_LABEL[value]) }),
                  )}
                  aria-label={t('automations.field.notify')}
                  onValueChange={(notify) => patch({ notify })}
                  data-field="notify"
                />
              </Row>
              {conditions && (
                <CheckRows
                  draft={draft}
                  workspaceId={effective.workspaceId}
                  automationId={editing ? current.automation.id : undefined}
                  onChange={(check) =>
                    setDraft(({ check: _, ...rest }) =>
                      check === undefined ? rest : { ...rest, check },
                    )
                  }
                />
              )}
            </Card>
          </Collapse>
        </div>

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" onClick={onDone}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={problem !== undefined || busy} data-action="save">
            {t(editing ? 'automations.dialog.save' : 'automations.dialog.create')}
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}

/** 检查脚本：开关；开着时命令、唤醒条件与试运行，试运行的结论与输出显示在下面。 */
function CheckRows({
  draft,
  workspaceId,
  automationId,
  onChange,
}: {
  draft: AutomationDraft;
  workspaceId: string | undefined;
  automationId: string | undefined;
  onChange: (check: AutomationDraft['check']) => void;
}) {
  const { client } = useHostConnection();
  const check = draft.check;
  // 关掉时记着命令，再打开时还在。
  const [kept, setKept] = useState(check ?? { command: '', wake: 'exit_code' as const });
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<AutomationCheckResult>();
  const [testError, setTestError] = useState<string>();
  const update = (next: Partial<NonNullable<AutomationDraft['check']>>) => {
    const merged = { ...(check ?? kept), ...next };
    setKept(merged);
    setResult(undefined);
    onChange(merged);
  };
  const test = async () => {
    if (client === undefined || check === undefined || check.command.trim() === '') return;
    setTesting(true);
    setTestError(undefined);
    setResult(undefined);
    try {
      const { result: next } = await client.request('automation.testCheck', {
        check: { ...check, command: check.command.trim() },
        ...(draft.sessionId !== undefined
          ? { sessionId: draft.sessionId as never }
          : workspaceId !== undefined && { workspaceId: workspaceId as never }),
        ...(automationId !== undefined && { automationId: automationId as never }),
      });
      setResult(next);
    } catch (reason) {
      setTestError(t('automations.check.testFailed', { error: describe(reason) }));
    } finally {
      setTesting(false);
    }
  };
  return (
    <>
      <Row label={t('automations.field.check')}>
        <Switch
          checked={check !== undefined}
          label={t('automations.field.check')}
          onChange={(on) => {
            setResult(undefined);
            onChange(on ? kept : undefined);
          }}
          data-action="check"
        />
      </Row>
      {check !== undefined && (
        <div className="flex flex-col gap-2 px-3.5 py-3">
          <Input
            value={check.command}
            onChange={(event) => update({ command: event.target.value })}
            aria-label={t('automations.check.command')}
            className="font-mono text-xs"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            data-field="check-command"
          />
          <div className="flex items-center justify-between gap-2">
            <Select
              className="w-52"
              value={check.wake}
              options={WAKE_ORDER.map((value) => ({ value, label: t(WAKE_LABEL[value]) }))}
              aria-label={t('automations.field.wake')}
              onValueChange={(wake) => update({ wake })}
              data-field="check-wake"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={testing || check.command.trim() === ''}
              onClick={() => void test()}
              data-action="test-check"
            >
              {testing ? (
                <LoaderCircle data-icon="inline-start" className="animate-spin" />
              ) : (
                <Play data-icon="inline-start" />
              )}
              {t('automations.check.test')}
            </Button>
          </div>
          {testError && (
            <p className="text-xs text-destructive" role="alert">
              {testError}
            </p>
          )}
          {result && <CheckResult result={result} />}
        </div>
      )}
    </>
  );
}

const DECISION_LABEL: Record<AutomationCheckResult['decision'], PlainMessageKey> = {
  wake: 'automations.check.wake',
  silent: 'automations.check.silent',
  failed: 'automations.check.failed',
};

function CheckResult({ result }: { result: AutomationCheckResult }) {
  return (
    <div
      className="flex flex-col gap-1.5"
      data-testid="check-result"
      data-decision={result.decision}
    >
      <p className="flex flex-wrap items-baseline gap-x-2 text-xs">
        <span
          className={cn(
            'font-medium',
            result.decision === 'wake' && 'text-success',
            result.decision === 'failed' && 'text-destructive',
          )}
        >
          {t(DECISION_LABEL[result.decision])}
        </span>
        <span className="text-muted-foreground">
          {t('automations.check.exitCode', { code: result.exitCode ?? '—' })}
        </span>
      </p>
      {result.error && <p className="text-xs text-muted-foreground">{result.error}</p>}
      {result.output.trim() !== '' && (
        <pre className="max-h-40 overflow-auto rounded-lg bg-muted px-2.5 py-2 font-mono text-xs whitespace-pre-wrap break-all">
          {result.truncated ? '…' : ''}
          {result.output}
        </pre>
      )}
    </div>
  );
}

function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        'divide-y divide-border rounded-xl border border-input bg-card text-sm',
        className,
      )}
    >
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-12 items-center justify-between gap-3 px-3.5 py-2">
      <span className="shrink-0 text-foreground">{label}</span>
      <div className="flex min-w-0 items-center justify-end gap-2">{children}</div>
    </div>
  );
}

const TIME_INPUT =
  'h-8 rounded-lg border border-input bg-card px-2 text-sm tabular-nums outline-none focus-visible:focus-field [color-scheme:light] dark:[color-scheme:dark]';

function ScheduleCard({
  draft,
  timezone,
  onChange,
}: {
  draft: ScheduleDraft;
  timezone: string;
  onChange: (next: Partial<ScheduleDraft>) => void;
}) {
  const timed: readonly Repeat[] = ['daily', 'weekdays', 'weekly', 'monthly'];
  const zone = (
    <span className="text-xs text-muted-foreground" title={timezone}>
      {timezoneLabel(timezone)}
    </span>
  );
  return (
    <Card>
      <Row label={t('automations.field.repeat')}>
        <Select
          className="w-52"
          value={draft.repeat}
          options={REPEATS.map((value) => ({ value, label: t(REPEAT_LABEL[value]) }))}
          aria-label={t('automations.field.repeat')}
          onValueChange={(repeat) => onChange({ repeat })}
          data-field="repeat"
        />
      </Row>
      {draft.repeat === 'weekly' && (
        <Row label={t('automations.field.weekdays')}>
          <div className="flex flex-wrap justify-end gap-1" data-field="weekdays">
            {WEEK_ORDER.map((day) => {
              const on = draft.weekdays.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    onChange({
                      weekdays: on
                        ? draft.weekdays.filter((value) => value !== day)
                        : [...draft.weekdays, day],
                    })
                  }
                  className={cn(
                    'h-7 min-w-9 rounded-full px-2 text-xs outline-none transition-colors duration-150 focus-visible:focus-ring',
                    on
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-soft-foreground hover:text-foreground',
                  )}
                >
                  {weekdayName(day)}
                </button>
              );
            })}
          </div>
        </Row>
      )}
      {draft.repeat === 'monthly' && (
        <Row label={t('automations.field.day')}>
          <Select
            className="w-52"
            value={String(draft.day)}
            options={Array.from({ length: 31 }, (_, index) => ({
              value: String(index + 1),
              label: t('automations.field.dayOfMonth', { day: index + 1 }),
            }))}
            aria-label={t('automations.field.day')}
            onValueChange={(value) => onChange({ day: Number(value) })}
            data-field="day"
          />
        </Row>
      )}
      {draft.repeat === 'interval' && (
        <Row label={t('automations.field.interval')}>
          <Select
            className="w-52"
            value={String(draft.minutes)}
            options={[
              ...(INTERVAL_CHOICES.includes(draft.minutes as never) ? [] : [draft.minutes]),
              ...INTERVAL_CHOICES,
            ].map((minutes) => ({
              value: String(minutes),
              label:
                minutes % 60 === 0
                  ? t('automations.schedule.everyHours', { n: minutes / 60 })
                  : t('automations.schedule.everyMinutes', { n: minutes }),
            }))}
            aria-label={t('automations.field.interval')}
            onValueChange={(value) => onChange({ minutes: Number(value) })}
            data-field="interval"
          />
        </Row>
      )}
      {timed.includes(draft.repeat) && (
        <Row label={t('automations.field.time')}>
          {zone}
          <input
            type="time"
            required
            value={draft.time}
            onChange={(event) => event.target.value && onChange({ time: event.target.value })}
            aria-label={t('automations.field.time')}
            className={cn(TIME_INPUT, 'w-28')}
            data-field="time"
          />
        </Row>
      )}
      {draft.repeat === 'once' && (
        <Row label={t('automations.field.time')}>
          {zone}
          <input
            type="datetime-local"
            required
            value={draft.at}
            onChange={(event) => event.target.value && onChange({ at: event.target.value })}
            aria-label={t('automations.field.time')}
            className={cn(TIME_INPUT, 'w-52')}
            data-field="at"
          />
        </Row>
      )}
    </Card>
  );
}
