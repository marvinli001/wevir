import { hostSupports } from '@wevir/client-sdk';
import {
  IMPORT_APPLY_MAX_ITEMS,
  type ImportApp,
  type ImportApplyResult,
  type ImportConnectorCandidate,
  type ImportKind,
  type ImportMemoryCandidate,
  type ImportScanResult,
} from '@wevir/protocol';
import { cn } from 'cn';
import { ChevronRight } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { Collapse } from '@/components/collapse';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, type SelectOption } from '@/components/ui/select';
import { useWorkbenchData } from '@/data/workbench-data';
import { chatsOf, projectsOf } from '@/data/workbench-model';
import { describe, useHostConnection } from '@/host/host-connection';
import { type PlainMessageKey, t } from '@/i18n';
import { ConfigLine, MonoBlock } from '@/plugins/plugin-rows';
import { commandLine } from '@/plugins/plugins-model';
import { workspaceLabel } from '@/projects/chats';
import {
  applyItems,
  candidatesOf,
  checkedCount,
  groupCheck,
  hasRenameErrors,
  IMPORT_APP_LABEL,
  IMPORT_APPS,
  IMPORT_KINDS,
  type ImportCandidate,
  type ImportRowState,
  type ImportSelection,
  type ImportSummary,
  initialSelection,
  needsValues,
  type RenameError,
  reasonLabel,
  renameError,
  rowState,
  selectable,
  setGroup,
  summarize,
  updateRow,
} from './import-model';
import { EmptyList, LIST_CARD, NoticeBanner, Segmented, SettingsSection } from './settings-ui';

type ScanState =
  | { status: 'loading'; app: ImportApp }
  | { status: 'error'; app: ImportApp; error: string }
  | { status: 'ready'; app: ImportApp; scan: ImportScanResult };

const GROUP_TITLE: Record<ImportKind, PlainMessageKey> = {
  memory: 'settings.import.group.memory',
  connector: 'settings.import.group.connector',
  skill: 'settings.import.group.skill',
};

const GROUP_EMPTY: Record<ImportKind, PlainMessageKey> = {
  memory: 'settings.import.empty.memory',
  connector: 'settings.import.empty.connector',
  skill: 'settings.import.empty.skill',
};

const RENAME_ERROR: Record<ImportKind, Record<RenameError, PlainMessageKey>> = {
  memory: {
    required: 'settings.import.rename.required',
    invalid: 'settings.import.rename.invalidMemory',
    reserved: 'plugins.connector.error.nameReserved',
    unchanged: 'settings.import.rename.unchanged',
  },
  connector: {
    required: 'settings.import.rename.required',
    invalid: 'plugins.connector.error.nameInvalid',
    reserved: 'plugins.connector.error.nameReserved',
    unchanged: 'settings.import.rename.unchanged',
  },
  skill: {
    required: 'settings.import.rename.required',
    invalid: 'settings.import.rename.invalidMemory',
    reserved: 'plugins.connector.error.nameReserved',
    unchanged: 'settings.import.rename.unchanged',
  },
};

/** 原因的显示：认得的用文案，不认得的原样。 */
function reasonText(reason: string): string {
  const key = reasonLabel(reason);
  return key === undefined ? reason : t(key);
}

/**
 * 设置 → 导入（0.71.0）：选一个应用（Claude Code、Codex、Grok、Antigravity），Host 列出它的记忆、MCP 服务器与 skills，逐条
 * 勾选、选目标（全局或某个项目）、同名的换名字，再一次导入；结果汇总在上方，失败的逐条列出原因，导入后重新读一遍。
 */
export function ImportSettings() {
  const { client, view } = useHostConnection();
  const supported =
    view.status === 'connected' && hostSupports(view.hello.features, 'external_import');
  const data = useWorkbenchData();
  const [app, setApp] = useState<ImportApp>('claude');
  const [state, setState] = useState<ScanState>({ status: 'loading', app });
  const [selection, setSelection] = useState<ImportSelection>({});
  const [applying, setApplying] = useState(false);
  const [summary, setSummary] = useState<ImportSummary>();
  const [error, setError] = useState<string>();
  // 导入后加一，触发重新读。
  const [generation, setGeneration] = useState(0);

  // 目标：全局、各项目，“对话”工作区在最后。
  const targets = useMemo<SelectOption[]>(() => {
    const global = { value: 'global', label: t('settings.import.global') };
    if (data.status !== 'ready') return [global];
    const chats = chatsOf(data.workspaces);
    const entries = [...projectsOf(data.workspaces), ...(chats === undefined ? [] : [chats])];
    return [
      global,
      ...entries.map((entry) => ({
        value: entry.workspace.id,
        label: workspaceLabel(entry.workspace),
      })),
    ];
  }, [data]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: generation 只用来触发重新读。
  useEffect(() => {
    if (!client || !supported) return;
    let stopped = false;
    // 同一个应用重新读时留着旧列表，换应用才显示“正在读取”。
    setState((current) =>
      current.status === 'ready' && current.app === app ? current : { status: 'loading', app },
    );
    client.request('import.scan', { app }).then(
      (scan) => {
        if (stopped) return;
        setState({ status: 'ready', app, scan });
        setSelection(initialSelection(scan));
      },
      (reason: unknown) => {
        if (!stopped) setState({ status: 'error', app, error: describe(reason) });
      },
    );
    return () => {
      stopped = true;
    };
  }, [client, supported, app, generation]);

  if (!supported) {
    return <NoticeBanner notice={{ tone: 'info', text: t('settings.import.unsupported') }} />;
  }

  const scan = state.status === 'ready' && state.app === app ? state.scan : undefined;
  const count = scan === undefined ? 0 : checkedCount(scan, selection);
  const blocked = scan === undefined || hasRenameErrors(scan, selection);

  const changeApp = (next: ImportApp) => {
    if (next === app) return;
    setApp(next);
    setSummary(undefined);
    setError(undefined);
  };

  const submit = async () => {
    if (!client || scan === undefined || count === 0 || blocked) return;
    setApplying(true);
    setError(undefined);
    setSummary(undefined);
    try {
      const items = applyItems(scan, selection);
      const results: ImportApplyResult['results'] = [];
      for (let start = 0; start < items.length; start += IMPORT_APPLY_MAX_ITEMS) {
        const batch = items.slice(start, start + IMPORT_APPLY_MAX_ITEMS);
        results.push(...(await client.request('import.apply', { app, items: batch })).results);
      }
      setSummary(summarize({ results }, scan));
    } catch (reason) {
      setError(t('settings.import.applyFailed', { error: describe(reason) }));
    } finally {
      setApplying(false);
      setGeneration((value) => value + 1);
    }
  };

  return (
    <>
      <div className="mb-6">
        <Segmented<ImportApp>
          label={t('settings.import.app')}
          value={app}
          onChange={changeApp}
          disabled={applying}
          options={IMPORT_APPS.map((value) => ({ value, label: t(IMPORT_APP_LABEL[value]) }))}
        />
      </div>
      {(summary || error) && (
        <div className="mb-6 space-y-2" data-testid="import-result">
          {error && <NoticeBanner notice={{ tone: 'error', text: error }} />}
          {summary && <ImportSummaryView summary={summary} />}
        </div>
      )}
      {state.status === 'error' && state.app === app ? (
        <NoticeBanner
          notice={{ tone: 'error', text: t('settings.import.scanFailed', { error: state.error }) }}
        />
      ) : scan === undefined ? (
        <p className="text-sm text-muted-foreground">{t('settings.import.scanning')}</p>
      ) : !scan.found ? (
        <EmptyList>{t('settings.import.notFound', { app: t(IMPORT_APP_LABEL[app]) })}</EmptyList>
      ) : (
        <>
          {IMPORT_KINDS.map((kind) => (
            <CandidateGroup
              key={kind}
              kind={kind}
              scan={scan}
              selection={selection}
              targets={targets}
              disabled={applying}
              onChange={setSelection}
            />
          ))}
          <div className="flex justify-end">
            <Button
              onClick={() => void submit()}
              disabled={applying || count === 0 || blocked}
              data-action="apply-import"
            >
              {applying ? t('settings.import.applying') : t('settings.import.submit', { count })}
            </Button>
          </div>
        </>
      )}
    </>
  );
}

function ImportSummaryView({ summary }: { summary: ImportSummary }) {
  return (
    <>
      <NoticeBanner
        notice={{
          tone: summary.failed.length === 0 ? 'success' : 'warning',
          text: t('settings.import.result', {
            imported: summary.imported,
            skipped: summary.skipped,
            failed: summary.failed.length,
          }),
        }}
      />
      {summary.failed.length > 0 && (
        <ul className={cn(LIST_CARD, 'text-sm')} data-testid="import-failures">
          {summary.failed.map((failure) => (
            <li
              key={failure.key}
              className="flex items-baseline gap-3 px-4 py-2.5"
              data-import-failure={failure.key}
            >
              <span className="min-w-0 truncate font-mono text-xs">{failure.name}</span>
              {failure.kind && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {t(GROUP_TITLE[failure.kind])}
                </span>
              )}
              <span className="ml-auto min-w-0 text-right text-xs break-words text-destructive">
                {failure.reason === undefined
                  ? t('settings.import.failed')
                  : reasonText(failure.reason)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function CandidateGroup({
  kind,
  scan,
  selection,
  targets,
  disabled,
  onChange,
}: {
  kind: ImportKind;
  scan: ImportScanResult;
  selection: ImportSelection;
  targets: readonly SelectOption[];
  disabled: boolean;
  onChange: (next: ImportSelection) => void;
}) {
  const candidates = candidatesOf(scan, kind);
  const unsupported = scan.unsupported.includes(kind);
  const check = groupCheck(kind, candidates, selection);
  const pickable = candidates.some((candidate) => selectable(kind, candidate));
  const title = t(GROUP_TITLE[kind]);
  return (
    <SettingsSection
      title={title}
      data-import-kind={kind}
      action={
        !unsupported &&
        candidates.length > 0 && (
          <label className="flex cursor-default items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              size="sm"
              checked={check === 'all'}
              indeterminate={check === 'some'}
              disabled={disabled || !pickable}
              onCheckedChange={(checked) =>
                onChange(setGroup(kind, candidates, selection, checked))
              }
              aria-label={t('settings.import.selectAllOf', { group: title })}
              data-select-all={kind}
            />
            {t('settings.import.selectAll')}
          </label>
        )
      }
    >
      {unsupported ? (
        <EmptyList>{t('settings.import.unsupportedKind')}</EmptyList>
      ) : candidates.length === 0 ? (
        <EmptyList>{t(GROUP_EMPTY[kind])}</EmptyList>
      ) : (
        <ul className={cn(LIST_CARD, 'overflow-hidden')}>
          {candidates.map((candidate) => (
            <CandidateRow
              key={candidate.key}
              kind={kind}
              candidate={candidate}
              state={rowState(selection, candidate.key)}
              targets={targets}
              disabled={disabled}
              onChange={(patch) => onChange(updateRow(selection, candidate.key, patch))}
            />
          ))}
        </ul>
      )}
    </SettingsSection>
  );
}

function CandidateRow({
  kind,
  candidate,
  state,
  targets,
  disabled,
  onChange,
}: {
  kind: ImportKind;
  candidate: ImportCandidate;
  state: ImportRowState;
  targets: readonly SelectOption[];
  disabled: boolean;
  onChange: (patch: Partial<ImportRowState>) => void;
}) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const pickable = selectable(kind, candidate);
  const error = renameError(kind, candidate, state);
  const connector = kind === 'connector' ? (candidate as ImportConnectorCandidate) : undefined;
  const renaming = kind !== 'skill' && candidate.status === 'exists' && pickable && state.checked;
  return (
    <li
      className="px-4 py-3"
      data-import-candidate={candidate.key}
      data-status={candidate.status}
      data-checked={(pickable && state.checked) || undefined}
    >
      <div className="flex items-start gap-3">
        <label className="flex min-w-0 flex-1 cursor-default items-start gap-3">
          <Checkbox
            className="mt-0.5"
            checked={pickable && state.checked}
            disabled={disabled || !pickable}
            onCheckedChange={(checked) => onChange({ checked })}
            aria-label={t('settings.import.select', { name: candidate.name })}
            data-action="select-candidate"
          />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span
                className={cn('truncate font-mono text-sm', !pickable && 'text-muted-foreground')}
              >
                {candidate.name}
              </span>
              {candidate.status !== 'new' && (
                <span className="shrink-0 rounded-sm bg-muted px-1.5 text-[11px] leading-4.5 text-muted-foreground">
                  {t(
                    candidate.status === 'same'
                      ? 'settings.import.status.same'
                      : 'settings.import.status.exists',
                  )}
                </span>
              )}
              {connector && needsValues(connector) && (
                <span className="shrink-0 rounded-sm bg-warning/10 px-1.5 text-[11px] leading-4.5 text-warning">
                  {t('plugins.secret.missing')}
                </span>
              )}
            </span>
            {'description' in candidate && candidate.description !== '' && (
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                {candidate.description}
              </span>
            )}
            <CandidateMeta candidate={candidate} connector={connector} />
            {candidate.problem !== undefined && (
              <span className="mt-1 block text-xs text-warning" data-import-problem>
                {reasonText(candidate.problem)}
              </span>
            )}
          </span>
        </label>
        {kind !== 'skill' && (
          <Select
            className="w-40"
            aria-label={t('settings.import.targetOf', { name: candidate.name })}
            value={state.target}
            onValueChange={(target) => onChange({ target })}
            options={targets}
            disabled={disabled || !pickable}
            data-action="import-target"
          />
        )}
        <IconButton
          label={t(open ? 'settings.import.collapse' : 'settings.import.expand')}
          aria-expanded={open}
          aria-controls={detailId}
          onClick={() => setOpen(!open)}
          data-action="toggle-candidate"
        >
          <ChevronRight
            className={cn('transition-transform duration-150 ease-smooth', open && 'rotate-90')}
          />
        </IconButton>
      </div>
      {renaming && (
        <div className="mt-2 pl-7">
          <Input
            value={state.rename}
            onChange={(event) => onChange({ rename: event.target.value })}
            placeholder={t('settings.import.rename')}
            aria-label={t('settings.import.renameOf', { name: candidate.name })}
            aria-invalid={error !== undefined && state.rename !== '' ? true : undefined}
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
            className="h-8 max-w-64 font-mono text-xs"
            data-field="rename"
          />
          {error !== undefined && (
            <p
              className={cn(
                'mt-1 text-xs',
                error === 'required' ? 'text-muted-foreground' : 'text-destructive',
              )}
              data-rename-error={error}
            >
              {t(RENAME_ERROR[kind][error])}
            </p>
          )}
        </div>
      )}
      <Collapse open={open} id={detailId}>
        <div className="mt-3 space-y-2 pl-7 text-sm">
          {kind === 'memory' && (
            <MonoBlock className="max-h-60 overflow-y-auto">
              {(candidate as ImportMemoryCandidate).content}
            </MonoBlock>
          )}
          {connector?.config && <ConnectorConfigLines config={connector.config} />}
          <ConfigLine label={t('settings.import.path')}>
            <MonoBlock>{candidate.path}</MonoBlock>
          </ConfigLine>
        </div>
      </Collapse>
    </li>
  );
}

/** 名称下面的一行：来源项目；连接器加传输方式与命令或地址。 */
function CandidateMeta({
  candidate,
  connector,
}: {
  candidate: ImportCandidate;
  connector: ImportConnectorCandidate | undefined;
}) {
  const config = connector?.config;
  return (
    <>
      {config && (
        <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <span className="shrink-0 rounded-sm bg-muted px-1.5 text-[11px] leading-4.5">
            {t(`plugins.connector.transport.${config.transport}`)}
          </span>
          <span className="min-w-0 truncate font-mono">
            {config.transport === 'stdio' ? commandLine(config.command, config.args) : config.url}
          </span>
        </span>
      )}
      {candidate.project !== undefined && (
        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
          {t('settings.import.project', { project: candidate.project })}
        </span>
      )}
    </>
  );
}

/** 详情里的连接器配置：命令或地址、工作目录，环境变量与请求头只有键名。 */
function ConnectorConfigLines({
  config,
}: {
  config: NonNullable<ImportConnectorCandidate['config']>;
}) {
  const keys = Object.keys((config.transport === 'stdio' ? config.env : config.headers) ?? {});
  return (
    <>
      {config.transport === 'stdio' ? (
        <>
          <ConfigLine label={t('plugins.field.command')}>
            <MonoBlock>{commandLine(config.command, config.args)}</MonoBlock>
          </ConfigLine>
          {config.cwd !== undefined && (
            <ConfigLine label={t('plugins.field.cwd')}>
              <MonoBlock>{config.cwd}</MonoBlock>
            </ConfigLine>
          )}
        </>
      ) : (
        <ConfigLine label={t('plugins.field.url')}>
          <MonoBlock>{config.url}</MonoBlock>
        </ConfigLine>
      )}
      {keys.length > 0 && (
        <ConfigLine
          label={config.transport === 'stdio' ? t('plugins.field.env') : t('plugins.field.headers')}
        >
          <MonoBlock className="space-y-0.5">
            {keys.map((key) => (
              <div key={key} className="flex gap-3">
                <span className="min-w-0 flex-1">{key}</span>
                <span className="shrink-0 font-sans text-warning">
                  {t('plugins.secret.missing')}
                </span>
              </div>
            ))}
          </MonoBlock>
        </ConfigLine>
      )}
    </>
  );
}
