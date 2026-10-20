// “添加 / 编辑连接器”对话框的表单（0.42.0，desktop-layout.md §23）：表单状态、校验，以及 `connector.add` 的配置与 `connector.update`
// 的补丁。纯函数。密钥的规则同协议：已有的环境变量与请求头只知道键，值留空表示不变，null 删除。

import {
  type Connector,
  ConnectorNameSchema,
  type McpServerConfig,
  type McpServerPatch,
} from '@wevir/protocol';

export type ConnectorMode = 'stdio' | 'http';

export interface KeyValueRow {
  /** 稳定的列表 key。 */
  id: number;
  key: string;
  value: string;
  /** 编辑时已有的键：值在 Host、不回传，留空表示不变。 */
  existing: boolean;
  /** 已有的键被移除（补丁里写 null）。 */
  removed: boolean;
  /** 已有的键还没有值（导入的连接器，0.71.0），要用户填。 */
  missing?: boolean;
}

export interface ConnectorForm {
  name: string;
  mode: ConnectorMode;
  command: string;
  /** 每行一个参数。 */
  args: string;
  cwd: string;
  url: string;
  env: KeyValueRow[];
  headers: KeyValueRow[];
}

/**
 * 地址是 http(s) 且不带用户名密码（协议的 `McpServerConfigSchema` 同样要求）。协议里那个校验在地址根本不是 URL 时会抛
 * `TypeError`，不是返回校验失败，所以先在这里判断，不把不合法的地址交给它。
 */
export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}

let rowId = 0;

export function newRow(key = '', existing = false, missing = false): KeyValueRow {
  return { id: ++rowId, key, value: '', existing, removed: false, ...(missing && { missing }) };
}

export function emptyForm(mode: ConnectorMode = 'stdio'): ConnectorForm {
  return { name: '', mode, command: '', args: '', cwd: '', url: '', env: [], headers: [] };
}

/** 编辑：从连接器的视图（密钥只有键）填表单，传输方式固定。 */
export function formFromConnector(connector: Connector): ConnectorForm {
  const { config } = connector;
  const base = { ...emptyForm(config.transport), name: connector.name };
  // 散装连接器的 missingInputs 是还没填值的键（导入的连接器）；插件的是插件输入项，与这里无关。
  const missing = new Set(connector.pluginId === undefined ? (connector.missingInputs ?? []) : []);
  const rows = (keys: Record<string, true> | undefined) =>
    Object.keys(keys ?? {}).map((key) => newRow(key, true, missing.has(key)));
  if (config.transport === 'stdio') {
    return {
      ...base,
      command: config.command,
      args: (config.args ?? []).join('\n'),
      cwd: config.cwd ?? '',
      env: rows(config.env),
    };
  }
  return {
    ...base,
    url: config.url,
    headers: rows(config.headers),
  };
}

/** 参数文本：一行一个，空行丢掉。 */
export function parseArgs(text: string): string[] {
  return text.split(/\r?\n/).filter((line) => line.trim() !== '');
}

// ---- 键值行的操作 ----

export function updateRow(
  rows: readonly KeyValueRow[],
  id: number,
  patch: Partial<Pick<KeyValueRow, 'key' | 'value'>>,
): KeyValueRow[] {
  return rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
}

/** 新加的行直接删掉；已有的键只标成移除（再点一次恢复）。 */
export function removeRow(rows: readonly KeyValueRow[], id: number): KeyValueRow[] {
  return rows.flatMap((row) => {
    if (row.id !== id) return [row];
    return row.existing ? [{ ...row, removed: !row.removed, value: '' }] : [];
  });
}

// ---- 校验 ----

export type NameError = 'required' | 'invalid' | 'reserved' | 'exists';
export type RowsError = 'emptyKey' | 'duplicateKey';

export interface FormErrors {
  name?: NameError;
  command?: 'required';
  url?: 'required' | 'invalid';
  env?: RowsError;
  headers?: RowsError;
}

/** 名字的问题；`existing` 是已有连接器的名字，`own` 是编辑时它自己现在的名字。 */
export function nameError(
  name: string,
  existing: ReadonlySet<string>,
  own?: string,
): NameError | undefined {
  const value = name.trim();
  if (value === '') return 'required';
  if (value.toLowerCase().startsWith('wevir')) return 'reserved';
  if (!ConnectorNameSchema.safeParse(value).success) return 'invalid';
  if (value !== own && existing.has(value)) return 'exists';
  return undefined;
}

function rowsError(rows: readonly KeyValueRow[]): RowsError | undefined {
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.removed) continue;
    const key = row.key.trim();
    if (key === '') {
      // 完全空白的行当作没写；有值没键才算错。
      if (row.value !== '') return 'emptyKey';
      continue;
    }
    if (seen.has(key)) return 'duplicateKey';
    seen.add(key);
  }
  return undefined;
}

export function formErrors(
  form: ConnectorForm,
  existing: ReadonlySet<string>,
  own?: string,
): FormErrors {
  const errors: FormErrors = {};
  const name = nameError(form.name, existing, own);
  if (name) errors.name = name;
  if (form.mode === 'stdio') {
    if (form.command.trim() === '') errors.command = 'required';
    const env = rowsError(form.env);
    if (env) errors.env = env;
  } else {
    const url = form.url.trim();
    if (url === '') errors.url = 'required';
    else if (!isHttpUrl(url)) errors.url = 'invalid';
    const headers = rowsError(form.headers);
    if (headers) errors.headers = headers;
  }
  return errors;
}

export function hasErrors(errors: FormErrors): boolean {
  return Object.keys(errors).length > 0;
}

// ---- 请求 ----

/** 新键值：非空键（去掉首尾空白）→ 值；已移除与空白行不算。 */
function newValues(rows: readonly KeyValueRow[]): Record<string, string> | undefined {
  const values: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!row.removed && key !== '') values[key] = row.value;
  }
  return Object.keys(values).length > 0 ? values : undefined;
}

/** `connector.add` 的配置。表单要先通过 `formErrors`。 */
export function buildConfig(form: ConnectorForm): McpServerConfig {
  if (form.mode === 'stdio') {
    const args = parseArgs(form.args);
    const cwd = form.cwd.trim();
    const env = newValues(form.env);
    return {
      transport: 'stdio',
      command: form.command.trim(),
      ...(args.length > 0 && { args }),
      ...(cwd !== '' && { cwd }),
      ...(env && { env }),
    };
  }
  const headers = newValues(form.headers);
  return { transport: 'http', url: form.url.trim(), ...(headers && { headers }) };
}

/**
 * `connector.update` 的补丁（散装连接器，传输方式不变）：名字改了才带；命令、参数、地址整个替换；环境变量与请求头只送改动——
 * 已有的键留空不动、移除是 null、写了值或新加的是值。工作目录清空不会移除原值（协议的补丁没有清除它的写法），所以空的不带。
 */
export function buildPatch(
  form: ConnectorForm,
  connector: Connector,
): { name?: string; config: McpServerPatch } {
  const name = form.name.trim();
  const rename = name !== connector.name ? { name } : {};
  if (form.mode === 'stdio') {
    const cwd = form.cwd.trim();
    const env = secretChanges(form.env);
    return {
      ...rename,
      config: {
        transport: 'stdio',
        command: form.command.trim(),
        args: parseArgs(form.args),
        ...(cwd !== '' && { cwd }),
        ...(env && { env }),
      },
    };
  }
  const headers = secretChanges(form.headers);
  return {
    ...rename,
    config: { transport: 'http', url: form.url.trim(), ...(headers && { headers }) },
  };
}

function secretChanges(rows: readonly KeyValueRow[]): Record<string, string | null> | undefined {
  const changes: Record<string, string | null> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key === '') continue;
    if (row.removed) changes[key] = null;
    else if (!row.existing || row.value !== '') changes[key] = row.value;
  }
  return Object.keys(changes).length > 0 ? changes : undefined;
}
