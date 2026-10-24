import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tomlString } from './config.js';

// 建议的后续任务（0.16.0，U23，codex-event-mapping.md §6.8）：Codex 没有“向用户建议任务”的工具，Wevir 给它一个本机
// MCP 服务。脚本的源码在这里，启动 codex-app-server 之前写进 CODEX_HOME（打包后不必另带一个文件），由 Host 自己的
// Node 运行（Electron 里带 `ELECTRON_RUN_AS_NODE=1`）。工具调用只回“已交给用户”；建议由适配器从 Codex 的
// `item/completed`（mcpToolCall）里取出，报 `tasks.suggested`。

/** config.toml 里的 MCP 服务名：模型看到的工具是 `mcp__wevir_tasks__suggest_tasks`。 */
export const SUGGEST_TASKS_SERVER = 'wevir_tasks';
export const SUGGEST_TASKS_TOOL = 'suggest_tasks';
/** 一次最多建议几项（工具的 inputSchema 里的 `maxItems`）。 */
export const SUGGEST_TASKS_MAX = 5;

const DESCRIPTION =
  'Suggest follow-up tasks to the user: work you noticed that is outside the current request but worth ' +
  'doing in its own session (a bug found in passing, missing tests, a refactor that can stand alone). Do ' +
  'not do that work yourself. The user can start each suggestion as a separate session with one click; ' +
  "its result is reported back to you. Write the title in the user's language; the prompt must be " +
  'self-contained, because the new session starts from scratch with it as its first message. Suggest at ' +
  'most a few tasks, and never the same task twice.';

const TOOL = {
  name: SUGGEST_TASKS_TOOL,
  description: DESCRIPTION,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  inputSchema: {
    type: 'object',
    properties: {
      tasks: {
        type: 'array',
        minItems: 1,
        maxItems: SUGGEST_TASKS_MAX,
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'A short title, under 80 characters.' },
            prompt: {
              type: 'string',
              description: 'Complete, self-contained instructions for the new session.',
            },
            reason: { type: 'string', description: 'One sentence: why this is worth doing.' },
          },
          required: ['title', 'prompt'],
          additionalProperties: false,
        },
      },
    },
    required: ['tasks'],
    additionalProperties: false,
  },
};

/** MCP 服务的源码（stdio，一行一条 JSON-RPC）。只用 Node 内置模块。 */
export const SUGGEST_TASKS_SCRIPT = `// 由 Wevir 生成（packages/adapter-codex/src/suggest-tasks.ts），每次启动 codex-app-server 之前重写，不要手改。
import { createInterface } from 'node:readline';

const TOOL = ${JSON.stringify(TOOL)};

const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
const text = (value) => typeof value === 'string' && value.trim() !== '';

function call(args) {
  const tasks = args && Array.isArray(args.tasks) ? args.tasks.filter((t) => t && text(t.title) && text(t.prompt)) : [];
  if (tasks.length === 0) {
    return { content: [{ type: 'text', text: 'Nothing was suggested: each task needs a non-empty title and prompt.' }], isError: true };
  }
  return {
    content: [{
      type: 'text',
      text: 'Showed ' + tasks.length + ' suggested task(s) to the user. They decide whether to start each one as a separate session; you will be told when one finishes. Do not start that work here.',
    }],
  };
}

createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!message || typeof message.method !== 'string' || message.id === undefined) return;
  const params = message.params || {};
  switch (message.method) {
    case 'initialize':
      return reply(message.id, {
        protocolVersion: params.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: '${SUGGEST_TASKS_SERVER}', version: '1.0.0' },
      });
    case 'ping':
      return reply(message.id, {});
    case 'tools/list':
      return reply(message.id, { tools: [TOOL] });
    case 'tools/call':
      return params.name === TOOL.name
        ? reply(message.id, call(params.arguments))
        : fail(message.id, -32602, 'unknown tool: ' + params.name);
    default:
      return fail(message.id, -32601, 'method not found: ' + message.method);
  }
});
`;

/** 怎样运行这个 MCP 服务：脚本的位置与运行它的 Node。 */
export interface SuggestTasksServer {
  script: string;
  /** 默认 `process.execPath`（Host 自己的 Node；Electron 里是 Electron，靠 `ELECTRON_RUN_AS_NODE`）。 */
  node: string;
}

/** 把脚本写进 CODEX_HOME（`wevir-suggest-tasks.mjs`，0600，覆盖）。 */
export function writeSuggestTasksServer(
  codexHome: string,
  node = process.execPath,
): SuggestTasksServer {
  const script = join(codexHome, 'wevir-suggest-tasks.mjs');
  writeFileSync(script, SUGGEST_TASKS_SCRIPT, { mode: 0o600 });
  chmodSync(script, 0o600);
  return { script, node };
}

/**
 * config.toml 里的 `[mcp_servers.wevir_tasks]`：工具不需要用户批准（`default_tools_approval_mode = "approve"`），只开
 * 这一个工具。
 */
export function suggestTasksToml(server: SuggestTasksServer): string[] {
  return [
    '',
    `[mcp_servers.${SUGGEST_TASKS_SERVER}]`,
    `command = ${tomlString(server.node)}`,
    `args = [${tomlString(server.script)}]`,
    'env = { ELECTRON_RUN_AS_NODE = "1" }',
    'default_tools_approval_mode = "approve"',
    `enabled_tools = [${tomlString(SUGGEST_TASKS_TOOL)}]`,
    'omit_tools_from = ["deferred"]',
    'startup_timeout_sec = 10',
  ];
}

/** `suggest_tasks` 调用的参数里的建议；标题或说明不是非空字符串的去掉，最多 `SUGGEST_TASKS_MAX` 项。 */
export function suggestedTasksOf(
  args: unknown,
): Array<{ title: string; prompt: string; reason?: string }> {
  if (typeof args === 'string') {
    try {
      return suggestedTasksOf(JSON.parse(args));
    } catch {
      return [];
    }
  }
  if (typeof args !== 'object' || args === null) return [];
  const tasks = (args as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks)) return [];
  return tasks
    .flatMap((task: unknown) => {
      if (typeof task !== 'object' || task === null) return [];
      const { title, prompt, reason } = task as Record<string, unknown>;
      if (typeof title !== 'string' || typeof prompt !== 'string') return [];
      if (title.trim() === '' || prompt.trim() === '') return [];
      return [
        {
          title: title.trim(),
          prompt: prompt.trim(),
          ...(typeof reason === 'string' && reason.trim() !== '' && { reason: reason.trim() }),
        },
      ];
    })
    .slice(0, SUGGEST_TASKS_MAX);
}
