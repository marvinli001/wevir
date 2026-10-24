// 没有自带工具搜索的引擎（OpenCode）的按需工具：端点的 `dispatch` 列法（`?tier=dispatch`）只列常驻那层与这里的三个工具。
// `wevir_tool_search` 按关键词找按需那层的工具，回名字、描述与参数；搜到的工具不登记进引擎，经 `wevir_call_readonly`（只读，
// 不用批准，目标不是只读的就回错）或 `wevir_call`（按引擎的审批策略问）调用。调用照常经 `filterTools`（角色、预设、设置）、目标
// 工具自己的 `call` 与大输出落盘（app-mcp.ts）；事件与审批卡片由引擎的适配器换成目标工具（OpenCode 的 mapping.ts）。

import { APP_TOOLS_CALL, APP_TOOLS_CALL_READONLY, APP_TOOLS_SEARCH } from '@wevir/runtime-adapter';
import { type AppTool, type AppToolCall, AppToolError, type AppToolResult } from './app-mcp.js';

/** 一次最多回几个工具。 */
export const TOOL_SEARCH_LIMIT = 5;

export interface DispatchDeps {
  /** 这个会话能搜的工具（按需那层，`filterTools` 之后）。 */
  searchable(sessionId: AppToolCall['sessionId']): Promise<readonly AppTool[]>;
  /** 这个会话能调的工具；看不到或没有时 `undefined`。 */
  resolve(sessionId: AppToolCall['sessionId'], name: string): Promise<AppTool | undefined>;
  /** 照常调一个工具（出错转成结果、大输出落盘）。 */
  run(tool: AppTool, args: Record<string, unknown>, call: AppToolCall): Promise<AppToolResult>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const callSchema = (what: string) => ({
  type: 'object',
  properties: {
    name: { type: 'string', description: `Tool name from wevir_tool_search (${what}).` },
    arguments: {
      type: 'object',
      description: "The tool's arguments, matching its parameters.",
      additionalProperties: true,
    },
  },
  required: ['name'],
  additionalProperties: false,
});

/** `dispatch` 列法里加的三个工具。 */
export function dispatchTools(deps: DispatchDeps): AppTool[] {
  const dispatch = async (
    args: Record<string, unknown>,
    call: AppToolCall,
    readOnly: boolean,
  ): Promise<AppToolResult> => {
    const name = typeof args.name === 'string' ? args.name : '';
    const target = name === '' ? undefined : await deps.resolve(call.sessionId, name);
    if (target === undefined) {
      throw new AppToolError(
        `${name || 'That tool'} is not available to this session. Find tools with ${APP_TOOLS_SEARCH}.`,
      );
    }
    if (readOnly && target.annotations.readOnlyHint !== true) {
      throw new AppToolError(`${name} can change things: call it with ${APP_TOOLS_CALL}.`);
    }
    return deps.run(target, isObject(args.arguments) ? args.arguments : {}, call);
  };
  return [
    {
      name: APP_TOOLS_SEARCH,
      title: 'Find Wevir tools',
      description:
        'Find Wevir tools that are not in your tool list by keywords: the browser pane (browser), code intelligence (lsp), ' +
        'previews, plugins and skills, computer use, the iOS simulator, models and roles, automations, and more. Returns up to ' +
        `${TOOL_SEARCH_LIMIT} tools with name, description and parameters; call read-only ones with ${APP_TOOLS_CALL_READONLY} ` +
        `and the others with ${APP_TOOLS_CALL}.`,
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Keywords, e.g. "browser click" or "lsp references".',
          },
          limit: { type: 'integer', minimum: 1, maximum: TOOL_SEARCH_LIMIT },
        },
        required: ['query'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
      call: async (args, call) => {
        const query = typeof args.query === 'string' ? args.query : '';
        const limit =
          typeof args.limit === 'number' && Number.isInteger(args.limit)
            ? Math.min(Math.max(args.limit, 1), TOOL_SEARCH_LIMIT)
            : TOOL_SEARCH_LIMIT;
        return {
          content: [
            { type: 'text', text: searchText(await deps.searchable(call.sessionId), query, limit) },
          ],
        };
      },
    },
    {
      name: APP_TOOLS_CALL_READONLY,
      title: 'Call a read-only Wevir tool',
      description: `Call a read-only tool that ${APP_TOOLS_SEARCH} found (readOnly: true). Others need ${APP_TOOLS_CALL}.`,
      inputSchema: callSchema('readOnly: true'),
      annotations: { readOnlyHint: true },
      call: (args, call) => dispatch(args, call, true),
    },
    {
      name: APP_TOOLS_CALL,
      title: 'Call a Wevir tool',
      description: `Call a tool that ${APP_TOOLS_SEARCH} found. The user may be asked to approve it.`,
      inputSchema: callSchema('any tool'),
      annotations: {},
      call: (args, call) => dispatch(args, call, false),
    },
  ];
}

/**
 * 搜索结果：查询拆成词，名字里有的一个词算 3 分、标题或描述里有的算 1 分，取分数最高的 `limit` 个，再按名字排序（同一查询每次
 * 文本相同）。
 */
export function searchText(tools: readonly AppTool[], query: string, limit: number): string {
  const words = [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((word) => word.length > 1),
    ),
  ];
  const scored = tools
    .map((tool) => {
      const name = tool.name.toLowerCase();
      const text = `${tool.title} ${tool.description}`.toLowerCase();
      const score = words.reduce(
        (sum, word) => sum + (name.includes(word) ? 3 : 0) + (text.includes(word) ? 1 : 0),
        0,
      );
      return { tool, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || compare(a.tool.name, b.tool.name))
    .slice(0, limit)
    .map((entry) => entry.tool)
    .sort((a, b) => compare(a.name, b.name));
  if (scored.length === 0) {
    return 'No matching tools. Try other keywords, e.g. browser, lsp, preview, plugin, computer, simulator, models.';
  }
  return [
    `Found tools. Call them with ${APP_TOOLS_CALL_READONLY} (readOnly: true) or ${APP_TOOLS_CALL}, as {"name": <name>, "arguments": {...}}:`,
    ...scored.map((tool) =>
      JSON.stringify({
        name: tool.name,
        description: tool.description,
        ...(tool.annotations.readOnlyHint === true && { readOnly: true }),
        parameters: tool.inputSchema,
      }),
    ),
  ].join('\n');
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
