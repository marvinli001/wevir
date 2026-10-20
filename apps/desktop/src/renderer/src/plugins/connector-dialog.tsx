// “添加 / 编辑连接器”对话框（0.42.0，desktop-layout.md §23）：添加有“命令”“地址”“粘贴 JSON”三个模式，编辑沿用前两个的字段、传输方式固定。
// 校验失败与名字冲突就地显示在对话框里。纯逻辑在 connector-form.ts、connector-import.ts。

import type { Connector, WorkspaceId } from '@wevir/protocol';
import { Plus, Undo2, X } from 'lucide-react';
import { type FormEvent, type ReactNode, useMemo, useState } from 'react';
import { IconButton } from '@/components/icon-button';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { describe } from '@/host/host-connection';
import { type PlainMessageKey, t } from '@/i18n';
import { Segmented } from '@/settings/settings-ui';
import {
  buildConfig,
  buildPatch,
  type ConnectorForm,
  emptyForm,
  type FormErrors,
  formErrors,
  formFromConnector,
  hasErrors,
  type KeyValueRow,
  type NameError,
  newRow,
  type RowsError,
  removeRow,
  updateRow,
} from './connector-form';
import {
  type ImportIssue,
  type ImportResult,
  parseConnectorJson,
  withExisting,
  withoutAdded,
} from './connector-import';
import { usePluginsContext } from './plugins-context';
import { conflictingNames, replaceConnector } from './plugins-model';

export type ConnectorDialogRequest = { kind: 'add' } | { kind: 'edit'; connector: Connector };

/** 粘贴框的占位：一个 Claude / Cursor 常见的 MCP 配置（代码，不翻译）。 */
const JSON_PLACEHOLDER =
  '{\n  "mcpServers": {\n    "name": { "command": "npx", "args": ["-y", "pkg"] }\n  }\n}';

type Tab = 'stdio' | 'http' | 'json';

const NAME_ERRORS: Record<NameError, PlainMessageKey | undefined> = {
  required: undefined,
  invalid: 'plugins.connector.error.nameInvalid',
  reserved: 'plugins.connector.error.nameReserved',
  exists: 'plugins.connector.error.nameExists',
};
const ROWS_ERRORS: Record<RowsError, PlainMessageKey> = {
  emptyKey: 'plugins.connector.error.emptyKey',
  duplicateKey: 'plugins.connector.error.duplicateKey',
};

export function ConnectorDialog({
  request,
  onClose,
}: {
  request: ConnectorDialogRequest | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && onClose()}>
      {request && <ConnectorDialogBody request={request} onClose={onClose} />}
    </Dialog>
  );
}

function ConnectorDialogBody({
  request,
  onClose,
}: {
  request: ConnectorDialogRequest;
  onClose: () => void;
}) {
  const { client, list, data, notify, scoped, workspaces } = usePluginsContext();
  const editing = request.kind === 'edit' ? request.connector : undefined;
  // 范围（0.71.0）：添加时选全局或某个项目；编辑时沿用连接器的，不能改。
  const [scope, setScope] = useState<string>('global');
  const workspaceId = editing ? editing.workspaceId : scope === 'global' ? undefined : scope;
  const [tab, setTab] = useState<Tab>(editing ? editing.config.transport : 'stdio');
  const [form, setForm] = useState<ConnectorForm>(() =>
    editing ? formFromConnector(editing) : emptyForm(),
  );
  const [jsonText, setJsonText] = useState('');
  const [added, setAdded] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const existing = useMemo(
    () => conflictingNames(list.connectors, workspaceId, editing?.id),
    [list, workspaceId, editing],
  );
  const errors = formErrors(form, existing, editing?.name);
  const imported: ImportResult = useMemo(
    () => withoutAdded(withExisting(parseConnectorJson(jsonText), existing), added),
    [jsonText, existing, added],
  );
  const importable = imported.issues.length === 0 && imported.entries.length > 0;
  const canSubmit = !busy && (tab === 'json' ? importable : !hasErrors(errors));

  const patch = (next: Partial<ConnectorForm>) => {
    setForm((current) => ({ ...current, ...next }));
    setError(undefined);
  };
  const changeTab = (next: Tab) => {
    setTab(next);
    setError(undefined);
    if (next !== 'json') setForm((current) => ({ ...current, mode: next }));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(undefined);
    try {
      if (editing) {
        const { connector } = await client.request('connector.update', {
          id: editing.id,
          ...buildPatch(form, editing),
        });
        data.apply((current) => replaceConnector(current, connector));
        await data.refresh();
        notify({ tone: 'success', text: t('plugins.connector.saved', { name: connector.name }) });
        onClose();
      } else if (tab === 'json') {
        await importAll();
      } else {
        const { connector } = await client.request('connector.add', {
          name: form.name.trim(),
          config: buildConfig(form),
          ...(workspaceId !== undefined && { workspaceId: workspaceId as WorkspaceId }),
        });
        await data.refresh();
        notify({ tone: 'success', text: t('plugins.connector.added', { name: connector.name }) });
        onClose();
      }
    } catch (reason) {
      setError(
        t(editing ? 'plugins.connector.saveFailed' : 'plugins.connector.addFailed', {
          error: describe(reason),
        }),
      );
    } finally {
      setBusy(false);
    }
  };

  /** 按序添加；失败的留在对话框里（已成功的从结果里去掉），全部成功才关闭。 */
  const importAll = async () => {
    const done = new Set(added);
    const failures: string[] = [];
    for (const entry of imported.entries) {
      try {
        await client.request('connector.add', {
          name: entry.name,
          config: entry.config,
          ...(workspaceId !== undefined && { workspaceId: workspaceId as WorkspaceId }),
        });
        done.add(entry.name);
      } catch (reason) {
        failures.push(t('plugins.json.partial', { name: entry.source, error: describe(reason) }));
      }
    }
    await data.refresh();
    setAdded(done);
    if (failures.length === 0) {
      notify({
        tone: 'success',
        text: t('plugins.connector.imported', { count: imported.entries.length }),
      });
      onClose();
    } else {
      setError(failures.join('\n'));
    }
  };

  const title = t(editing ? 'plugins.connector.edit.title' : 'plugins.connector.add.title');
  const submitLabel = editing
    ? t('plugins.connector.submit.save')
    : tab === 'json'
      ? t('plugins.connector.submit.import', { count: imported.entries.length })
      : t('plugins.connector.submit.add');

  return (
    <DialogContent
      className="max-h-[calc(100dvh-2rem)] gap-5 overflow-y-auto p-5 sm:max-w-120"
      data-testid="connector-dialog"
    >
      <DialogTitle className="text-lg font-semibold">{title}</DialogTitle>
      {!editing && (
        <Segmented<Tab>
          label={title}
          value={tab}
          onChange={changeTab}
          options={[
            { value: 'stdio', label: t('plugins.connector.mode.stdio') },
            { value: 'http', label: t('plugins.connector.mode.http') },
            { value: 'json', label: t('plugins.connector.mode.json') },
          ]}
        />
      )}
      <form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
        {!editing && scoped && (
          <div className="space-y-1.5">
            <span className="block text-sm font-medium">{t('plugins.connector.scope')}</span>
            <Select
              aria-label={t('plugins.connector.scope')}
              value={scope}
              onValueChange={setScope}
              options={[
                { value: 'global', label: t('plugins.scope.global') },
                ...workspaces.map((entry) => ({ value: entry.id, label: entry.label })),
              ]}
              data-field="scope"
            />
          </div>
        )}
        {tab === 'json' ? (
          <JsonFields text={jsonText} onChange={setJsonText} result={imported} />
        ) : (
          <>
            <Field label={t('plugins.field.name')} error={nameText(form.name, errors)}>
              <Input
                value={form.name}
                onChange={(event) => patch({ name: event.target.value })}
                aria-invalid={errors.name !== undefined && form.name !== '' ? true : undefined}
                autoComplete="off"
                spellCheck={false}
                autoFocus={!editing}
                data-field="name"
              />
            </Field>
            {tab === 'stdio' ? (
              <StdioFields form={form} errors={errors} patch={patch} />
            ) : (
              <HttpFields form={form} errors={errors} patch={patch} />
            )}
          </>
        )}
        {error && (
          <p role="alert" className="text-sm break-words whitespace-pre-line text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={!canSubmit} data-action="submit-connector">
            {submitLabel}
          </Button>
        </div>
      </form>
    </DialogContent>
  );
}

/** 名字下面的错误：没填时不报（提交键本来就不可用），写了但不合规才说。 */
function nameText(name: string, errors: FormErrors): string | undefined {
  const key = errors.name === undefined || name === '' ? undefined : NAME_ERRORS[errors.name];
  return key && t(key);
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: 控件由 children 传入，包在 label 里。
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {error && <span className="block text-xs text-destructive">{error}</span>}
    </label>
  );
}

function StdioFields({
  form,
  errors,
  patch,
}: {
  form: ConnectorForm;
  errors: FormErrors;
  patch: (next: Partial<ConnectorForm>) => void;
}) {
  return (
    <>
      <Field label={t('plugins.field.command')}>
        <Input
          value={form.command}
          onChange={(event) => patch({ command: event.target.value })}
          autoComplete="off"
          spellCheck={false}
          className="font-mono text-xs"
          data-field="command"
        />
      </Field>
      <Field label={t('plugins.field.args')}>
        <Textarea
          value={form.args}
          onChange={(event) => patch({ args: event.target.value })}
          spellCheck={false}
          rows={3}
          className="max-h-40 min-h-16 overflow-y-auto font-mono text-xs"
          data-field="args"
        />
      </Field>
      <KeyValueEditor
        label={t('plugins.field.env')}
        addLabel={t('plugins.field.addEnv')}
        rows={form.env}
        error={errors.env && t(ROWS_ERRORS[errors.env])}
        onChange={(env) => patch({ env })}
        kind="env"
      />
      <Field label={t('plugins.field.cwd')}>
        <Input
          value={form.cwd}
          onChange={(event) => patch({ cwd: event.target.value })}
          autoComplete="off"
          spellCheck={false}
          className="font-mono text-xs"
          data-field="cwd"
        />
      </Field>
    </>
  );
}

function HttpFields({
  form,
  errors,
  patch,
}: {
  form: ConnectorForm;
  errors: FormErrors;
  patch: (next: Partial<ConnectorForm>) => void;
}) {
  return (
    <>
      <Field
        label={t('plugins.field.url')}
        error={errors.url === 'invalid' ? t('plugins.connector.error.urlInvalid') : undefined}
      >
        <Input
          value={form.url}
          onChange={(event) => patch({ url: event.target.value })}
          aria-invalid={errors.url === 'invalid' ? true : undefined}
          autoComplete="off"
          spellCheck={false}
          className="font-mono text-xs"
          data-field="url"
        />
      </Field>
      <KeyValueEditor
        label={t('plugins.field.headers')}
        addLabel={t('plugins.field.addHeader')}
        rows={form.headers}
        error={errors.headers && t(ROWS_ERRORS[errors.headers])}
        onChange={(headers) => patch({ headers })}
        kind="headers"
      />
    </>
  );
}

/**
 * 环境变量与请求头的键值行：已有的键（编辑时）只显示键，值留空表示不变（占位写“已设置（留空不变）”），可移除、再点恢复；
 * 新加的行键与值都能写。
 */
function KeyValueEditor({
  label,
  addLabel,
  rows,
  error,
  onChange,
  kind,
}: {
  label: string;
  addLabel: string;
  rows: readonly KeyValueRow[];
  error?: string | undefined;
  onChange: (rows: KeyValueRow[]) => void;
  kind: 'env' | 'headers';
}) {
  // 打开时光标落在第一个待填的值上（导入的连接器点“需填写”进来）。
  const firstMissing = rows.find((row) => row.missing)?.id;
  return (
    <fieldset className="min-w-0 space-y-1.5" data-rows={kind}>
      <legend className="p-0 text-sm font-medium">{label}</legend>
      {rows.map((row) => (
        <div key={row.id} className="flex items-center gap-2" data-row-key={row.key || undefined}>
          <Input
            value={row.key}
            readOnly={row.existing}
            disabled={row.removed}
            placeholder={t('plugins.field.key')}
            onChange={(event) => onChange(updateRow(rows, row.id, { key: event.target.value }))}
            autoComplete="off"
            spellCheck={false}
            className="w-2/5 font-mono text-xs"
            data-row="key"
          />
          <Input
            type={row.existing ? 'password' : 'text'}
            value={row.value}
            disabled={row.removed}
            placeholder={
              row.missing
                ? t('plugins.secret.missing')
                : row.existing
                  ? t('plugins.secret.keep')
                  : t('plugins.field.value')
            }
            aria-invalid={row.missing && row.value === '' && !row.removed ? true : undefined}
            autoFocus={row.id === firstMissing}
            onChange={(event) => onChange(updateRow(rows, row.id, { value: event.target.value }))}
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 font-mono text-xs"
            data-row="value"
          />
          <IconButton
            label={t(row.removed ? 'plugins.row.restore' : 'plugins.row.remove', {
              key: row.key || t('plugins.field.key'),
            })}
            size="icon-xs"
            className="text-muted-foreground"
            onClick={() => onChange(removeRow(rows, row.id))}
            data-row="remove"
          >
            {row.removed ? <Undo2 /> : <X />}
          </IconButton>
        </div>
      ))}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={() => onChange([...rows, newRow()])}
        data-action={`add-${kind}-row`}
      >
        <Plus data-icon="inline-start" />
        {addLabel}
      </Button>
    </fieldset>
  );
}

function JsonFields({
  text,
  onChange,
  result,
}: {
  text: string;
  onChange: (text: string) => void;
  result: ImportResult;
}) {
  const ignored = [...new Set(result.entries.flatMap((entry) => entry.ignored))];
  return (
    <div className="space-y-3">
      <Textarea
        value={text}
        onChange={(event) => onChange(event.target.value)}
        placeholder={JSON_PLACEHOLDER}
        spellCheck={false}
        rows={7}
        className="max-h-60 min-h-40 overflow-y-auto font-mono text-xs"
        autoFocus
        data-field="json"
      />
      {(result.entries.length > 0 || result.issues.length > 0) && (
        <ul className="space-y-1 text-xs" data-testid="import-preview">
          {result.entries.map((entry) => (
            <li key={entry.name} className="flex items-center gap-2" data-import-entry={entry.name}>
              <span className="min-w-0 truncate font-mono">{entry.name}</span>
              {entry.source !== entry.name && (
                <span className="min-w-0 truncate text-muted-foreground">{entry.source}</span>
              )}
              <span className="ml-auto shrink-0 rounded-sm bg-muted px-1.5 leading-4.5 text-muted-foreground">
                {t(`plugins.connector.transport.${entry.config.transport}`)}
              </span>
            </li>
          ))}
          {result.issues.map((issue, index) => (
            <li
              // biome-ignore lint/suspicious/noArrayIndexKey: 同名的问题可能不止一条，列表每次整份重算。
              key={index}
              className="break-words text-destructive"
              data-import-issue={issue.reason}
            >
              {issueText(issue)}
            </li>
          ))}
        </ul>
      )}
      {ignored.length > 0 && (
        <p className="text-xs break-words text-muted-foreground">
          {t('plugins.json.ignored', { fields: ignored.join(t('common.listSeparator')) })}
        </p>
      )}
    </div>
  );
}

function issueText(issue: ImportIssue): string {
  const name = issue.name ?? '';
  switch (issue.reason) {
    case 'syntax':
      return t('plugins.json.syntax');
    case 'shape':
      return t('plugins.json.shape');
    case 'empty':
      return t('plugins.json.empty');
    case 'name':
      return t('plugins.json.name', { name });
    case 'reserved':
      return t('plugins.json.reserved', { name });
    case 'duplicate':
      return t('plugins.json.duplicate', { name });
    case 'exists':
      return t('plugins.json.exists', { name });
    case 'sse':
      return t('plugins.json.sse', { name });
    case 'transport':
      return issue.detail === undefined
        ? t('plugins.json.transport', { name })
        : t('plugins.json.transportType', { name, type: issue.detail });
    case 'invalid':
      return issue.detail === undefined
        ? t('plugins.json.invalid', { name })
        : t('plugins.json.invalidField', { name, field: issue.detail });
  }
}
