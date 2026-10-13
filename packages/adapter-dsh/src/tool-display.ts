import type { TodoItem, ToolDisplay, ToolDisplayKind } from '@wevir/runtime-adapter';

// dsh 工具名 → 展示类型（domain-model.md §7）。dsh 的 ACP `tool_call.kind` 恒为 `other`，没有 `locations`
// 与 `diff`（T0.3 §3.3），界面要的类型与路径只能按工具名（`tool_call.title`）从 `rawInput` 里取。
// 字段名对照上游 `d743267` 的工具定义；本表与 docs/architecture/acp-event-mapping.md 的「工具名 → 展示类型」
// 一致，由 acp-event-mapping.test.ts 检查。

type Fields = Omit<ToolDisplay, 'kind'>;
type Extract = (input: Record<string, unknown>) => Fields;

interface ToolRule {
  kind: ToolDisplayKind;
  extract?: Extract;
}

/** `file_path` / `path` 这类单个路径：进 `paths`，同时作摘要。 */
const pathField =
  (field: string): Extract =>
  (input) => {
    const path = nonEmptyString(input[field]);
    return path === undefined ? {} : { summary: path, paths: [path] };
  };

const shell: Extract = (input) => {
  const command = nonEmptyString(input.command);
  return command === undefined ? {} : { command, summary: firstLine(command) };
};

const jobId: Extract = (input) => {
  const id = nonEmptyString(input.job_id);
  return id === undefined ? {} : { summary: id };
};

/** grep / glob：`pattern` 是查询，`path` 是搜索范围。 */
const search: Extract = (input) => {
  const query = nonEmptyString(input.pattern);
  const path = nonEmptyString(input.path);
  return {
    ...(query !== undefined && { query, summary: query }),
    ...(path !== undefined && { paths: [path] }),
  };
};

const webSearch: Extract = (input) => {
  const queries = Array.isArray(input.queries)
    ? input.queries.filter((q): q is string => typeof q === 'string' && q !== '')
    : [];
  if (queries.length === 0) return {};
  const query = queries.join(' | ');
  return { query, summary: query };
};

const webFetch: Extract = (input) => {
  const url = nonEmptyString(input.url);
  return url === undefined ? {} : { url, summary: url };
};

/** 计划模式的 `plan` 是 Markdown，摘要取第一行（去掉标题记号）。 */
const plan: Extract = (input) => {
  const text = nonEmptyString(input.plan);
  if (text === undefined) return {};
  const summary = firstLine(text).replace(/^#+\s*/, '');
  return summary === '' ? {} : { summary };
};

const subagent: Extract = (input) => {
  const description = nonEmptyString(input.description);
  return description === undefined ? {} : { summary: description };
};

/** `present` 交付的文件列表（将来的 Artifact 来源）。 */
const present: Extract = (input) => {
  const files = Array.isArray(input.files) ? input.files : [];
  const paths = files.flatMap((file) => {
    const path = isRecord(file) ? nonEmptyString(file.path) : undefined;
    return path === undefined ? [] : [path];
  });
  return paths.length === 0 ? {} : { paths };
};

/** dsh 工具名 → 展示类型与字段提取。表里没有的工具名一律 `unknown`；`mcp__<server>__<tool>` 另行处理。 */
export const DSH_TOOLS: Readonly<Record<string, ToolRule>> = Object.freeze({
  read: { kind: 'read', extract: pathField('file_path') },
  read_image: { kind: 'read', extract: pathField('file_path') },
  write: { kind: 'write', extract: pathField('file_path') },
  edit: { kind: 'edit', extract: pathField('file_path') },
  str_replace_editor: { kind: 'edit', extract: pathField('path') },
  bash: { kind: 'shell', extract: shell },
  pwsh: { kind: 'shell', extract: shell },
  job_output: { kind: 'shell', extract: jobId },
  job_list: { kind: 'shell' },
  job_kill: { kind: 'shell', extract: jobId },
  grep: { kind: 'search', extract: search },
  glob: { kind: 'search', extract: search },
  web_search: { kind: 'search', extract: webSearch },
  web_fetch: { kind: 'fetch', extract: webFetch },
  todo_write: { kind: 'plan' },
  plan: { kind: 'plan', extract: plan },
  subagent: { kind: 'sub_agent', extract: subagent },
  send_message: { kind: 'sub_agent' },
  interrupt_agent: { kind: 'sub_agent' },
  list_agents: { kind: 'sub_agent' },
  list_subagent_models: { kind: 'sub_agent' },
  present: { kind: 'unknown', extract: present },
});

const MCP_TOOL = /^mcp__(.+?)__.+$/;

/**
 * 工具调用的展示类型与界面字段。`rawInput` 是模型给的参数（dsh 解析 JSON 失败时是原始字符串），
 * 字段缺失或类型不对时只少字段，不报错；路径保留原值（可能是相对路径）。
 */
export function toolDisplay(toolName: string, rawInput: unknown): ToolDisplay {
  const input = isRecord(rawInput) ? rawInput : {};
  const mcp = MCP_TOOL.exec(toolName);
  if (mcp !== null) return { kind: 'unknown', mcpServer: mcp[1] as string };
  const rule = Object.hasOwn(DSH_TOOLS, toolName) ? DSH_TOOLS[toolName] : undefined;
  if (rule === undefined) return { kind: 'unknown' };
  return { kind: rule.kind, ...rule.extract?.(input) };
}

/** dsh 的待办工具名；它的 `rawInput.todos` 是完整列表。 */
export const TODO_TOOL = 'todo_write';

/**
 * 解析 `todo_write` 的 `rawInput`（`{todos: [{content, status}]}`，每次都是完整列表）。结构不对、或任一项
 * 缺 `content` / `status` 时返回 undefined：宁可不更新待办，也不发半截列表。`status` 原样保留。
 */
export function parseTodoItems(rawInput: unknown): TodoItem[] | undefined {
  if (!isRecord(rawInput) || !Array.isArray(rawInput.todos)) return undefined;
  const items: TodoItem[] = [];
  for (const todo of rawInput.todos) {
    if (!isRecord(todo) || typeof todo.content !== 'string' || typeof todo.status !== 'string') {
      return undefined;
    }
    items.push({ content: todo.content, status: todo.status });
  }
  return items;
}

function firstLine(text: string): string {
  return (text.split('\n').find((line) => line.trim() !== '') ?? '').trim();
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
