import type { ToolDisplay } from '@wevir/runtime-adapter';
import { WEB_FETCH_TOOL, WEB_SEARCH_TOOL, WEB_TOOL_SERVER } from '@wevir/runtime-adapter/web-tool';
import type {
  CollabAgentToolCallItem,
  CommandAction,
  CommandExecutionItem,
  FileUpdateChange,
  McpToolCallItem,
  ToolItem,
} from './protocol.js';

// 工具类 item → 展示类型与工具名（docs/architecture/codex-event-mapping.md §6.3）。Codex 的 item 自带类型，命令还有
// 解析好的 `commandActions`，不必像 dsh 那样按工具名猜（domain-model.md §7）。只读、列目录、搜索的命令归为 read /
// search，与桌面端把连续的读取 / 搜索合并成一组的规则（apps/desktop 的 tool-model.ts）对上，也与 Codex 自己的终端
// 界面把它们合成“探索”单元一致（codex-notes §2.7）。

/** 映射成工具调用的 item 类型。 */
export const TOOL_ITEM_TYPES = Object.freeze([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'dynamicToolCall',
  'collabAgentToolCall',
  'webSearch',
  'imageView',
] as const);

/** 是映射成工具调用的 item，并且映射要读的字段都在（不在的整条保留为 engine.raw）。 */
export function isToolItem(item: unknown): item is ToolItem {
  if (typeof item !== 'object' || item === null) return false;
  const fields = item as Record<string, unknown>;
  const str = (key: string) => typeof fields[key] === 'string';
  switch (fields.type) {
    case 'commandExecution':
      return (
        str('command') &&
        (fields.commandActions === undefined || Array.isArray(fields.commandActions))
      );
    case 'fileChange':
      return (
        Array.isArray(fields.changes) &&
        fields.changes.every(
          (change: unknown) =>
            typeof change === 'object' &&
            change !== null &&
            typeof (change as { path?: unknown }).path === 'string' &&
            typeof (change as { kind?: { type?: unknown } }).kind?.type === 'string',
        )
      );
    case 'mcpToolCall':
      return str('server') && str('tool');
    case 'dynamicToolCall':
      return str('tool');
    case 'collabAgentToolCall':
      return str('tool') && Array.isArray(fields.receiverThreadIds);
    case 'webSearch':
      return str('query');
    case 'imageView':
      return str('path');
    default:
      return false;
  }
}

/**
 * 工具名（`tool.started.toolName`，引擎原值）：Codex 不给工具名，用 item 类型；MCP 用 `mcp__<server>__<tool>`
 * （与 domain-model §7 的命名一致），动态工具用 `<namespace>.<tool>`，子 agent 用 `collabAgentToolCall.<tool>`。
 */
export function toolName(item: ToolItem): string {
  switch (item.type) {
    case 'mcpToolCall':
      return `mcp__${item.server}__${item.tool}`;
    case 'dynamicToolCall':
      return item.namespace === null ? item.tool : `${item.namespace}.${item.tool}`;
    case 'collabAgentToolCall':
      return `collabAgentToolCall.${item.tool}`;
    default:
      return item.type;
  }
}

export function toolDisplay(item: ToolItem): ToolDisplay {
  switch (item.type) {
    case 'commandExecution':
      return commandDisplay(item);
    case 'fileChange':
      return fileChangeDisplay(item.changes);
    case 'mcpToolCall':
      return (
        webToolDisplay(item) ?? {
          kind: 'unknown',
          summary: `${item.server}/${item.tool}`,
          mcpServer: item.server,
        }
      );
    case 'dynamicToolCall':
      return { kind: 'unknown', summary: toolName(item) };
    case 'collabAgentToolCall':
      return subAgentDisplay(item);
    case 'webSearch':
      return { kind: 'search', summary: item.query, query: item.query };
    case 'imageView':
      return { kind: 'read', summary: item.path, paths: [item.path] };
  }
}

/**
 * 命令：`commandActions` 全是 read → `read`（路径取各 action 的 path）；全是 read / listFiles / search 且至少一个
 * listFiles 或 search → `search`（`query` 取第一个搜索词）；其余（含 unknown、空列表）→ `shell`。三种都带原始命令。
 */
export function commandDisplay(
  item: Pick<CommandExecutionItem, 'command' | 'commandActions'>,
): ToolDisplay {
  const actions: readonly CommandAction[] = item.commandActions ?? [];
  const command = displayCommand(item.command, actions);
  const exploring = actions.length > 0 && actions.every((action) => action.type !== 'unknown');
  if (!exploring) return { kind: 'shell', summary: command, command };
  // every 的回调是推断出的类型谓词：这里的 actions 已经没有 unknown。
  const paths = unique(actions.flatMap((action) => (action.path ? [action.path] : [])));
  if (actions.every((action) => action.type === 'read')) {
    return { kind: 'read', summary: paths.join(', ') || command, paths, command };
  }
  const query =
    actions.find(
      (action): action is Extract<CommandAction, { type: 'search' }> =>
        action.type === 'search' && action.query !== null && action.query !== '',
    )?.query ?? undefined;
  return {
    kind: 'search',
    summary: query ?? (paths.join(', ') || command),
    ...(paths.length > 0 && { paths }),
    ...(query !== undefined && { query }),
    command,
  };
}

/**
 * 给人看的命令：`item.command` 是 Codex 实际执行的、带 shell 外壳的形式（`/bin/zsh -lc 'cat README.md'`，R2 录制的
 * 样本），去掉 `<sh|bash|zsh> -lc '…'` 外壳；认不出外壳时，只有一个解析出的动作就用它的命令，否则原样。
 */
export function displayCommand(command: string, actions: readonly CommandAction[] = []): string {
  const wrapped = /^(?:\S*[/\\])?(?:ba|z)?sh(?:\.exe)?\s+-l?c\s+([\s\S]+)$/.exec(command.trim());
  const inner = wrapped?.[1];
  if (inner !== undefined) {
    const quoted = /^'([\s\S]*)'$/.exec(inner);
    return quoted?.[1] === undefined ? inner : quoted[1].replaceAll("'\\''", "'");
  }
  return actions.length === 1 && actions[0] !== undefined ? actions[0].command : command;
}

/** 文件改动：全是新建 → `write`，否则 `edit`；`paths` 是全部改动的路径（移动的写目标路径）。 */
export function fileChangeDisplay(changes: readonly FileUpdateChange[]): ToolDisplay {
  const paths = unique(
    changes.map((change) =>
      change.kind.type === 'update' && change.kind.move_path ? change.kind.move_path : change.path,
    ),
  );
  const kind =
    changes.length > 0 && changes.every((change) => change.kind.type === 'add') ? 'write' : 'edit';
  const summary = paths.length <= 1 ? (paths[0] ?? '') : `${paths[0]} 等 ${paths.length} 个文件`;
  return { kind, summary, paths };
}

/** 子 agent 的工具调用（R4 才有子会话）：摘要取任务描述的第一行，没有时用工具名。 */
function subAgentDisplay(item: CollabAgentToolCallItem): ToolDisplay {
  const firstLine = item.prompt
    ?.split('\n')
    .find((line) => line.trim() !== '')
    ?.trim();
  return { kind: 'sub_agent', summary: firstLine ?? item.tool };
}

/** 工具结束时的输出文本（`tool.finished.output`）。没有可显示的内容时省略。 */
export function toolOutput(item: ToolItem, streamed: string): string | undefined {
  switch (item.type) {
    case 'commandExecution':
      return item.aggregatedOutput ?? (streamed === '' ? undefined : streamed);
    case 'fileChange':
      return item.changes.length === 0
        ? undefined
        : item.changes.map((change) => change.diff).join('\n');
    case 'mcpToolCall':
      if (item.error !== null) return item.error.message ?? JSON.stringify(item.error);
      if (item.result === null || item.result === undefined) return undefined;
      // Wevir 的联网工具回的是给模型看的文字，原样显示（0.34.0）。
      return (
        (item.server === WEB_TOOL_SERVER ? mcpText(item.result) : undefined) ??
        JSON.stringify(item.result)
      );
    case 'dynamicToolCall': {
      const text = (item.contentItems ?? [])
        .map((content) => content.text ?? '')
        .filter((piece) => piece !== '')
        .join('\n');
      return text === '' ? undefined : text;
    }
    case 'collabAgentToolCall':
      return Object.keys(item.agentsStates ?? {}).length === 0
        ? undefined
        : JSON.stringify(item.agentsStates);
    case 'webSearch':
    case 'imageView':
      return undefined;
  }
}

/**
 * Wevir 的联网工具（0.34.0，`wevir_web`，docs/architecture/web-tools.md §6）：搜索按 `search`、抓取按 `fetch` 展示，摘要是查询词
 * 或网址（桌面端按工具名给网页搜索换地球图标）。参数不全时 undefined，按普通 MCP 工具展示。
 */
function webToolDisplay(item: McpToolCallItem): ToolDisplay | undefined {
  if (item.server !== WEB_TOOL_SERVER) return undefined;
  const args = parseArguments(item.arguments);
  if (item.tool === WEB_SEARCH_TOOL && typeof args.query === 'string' && args.query.trim() !== '') {
    const query = args.query.trim();
    return { kind: 'search', summary: query, query, mcpServer: item.server };
  }
  if (item.tool === WEB_FETCH_TOOL && typeof args.url === 'string' && args.url.trim() !== '') {
    const url = args.url.trim();
    return { kind: 'fetch', summary: url, url, mcpServer: item.server };
  }
  return undefined;
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return parseArguments(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

/** MCP 结果里的文字段落；没有时 undefined。 */
function mcpText(result: unknown): string | undefined {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .flatMap((part: unknown) =>
      typeof part === 'object' &&
      part !== null &&
      typeof (part as { text?: unknown }).text === 'string'
        ? [(part as { text: string }).text]
        : [],
    )
    .join('\n');
  return text === '' ? undefined : text;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
