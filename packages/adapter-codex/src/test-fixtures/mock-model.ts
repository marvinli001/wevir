// 集成测试与桌面验收用的本地脚本化模型：最小的 OpenAI Responses 流式服务（POST …/responses）。改写自
// packages/model-gateway/src/test-fixtures/mock-responses.ts（同一仓库，MIT），事件格式照
// upstream/codex/codex-rs/core/tests/common/responses.rs 的 ev_* 帮手。Provider 用 `openai-responses`，经网关透传到这里，
// 不需要 Key（网关仍要求 Provider 有一个 Key，用 `MOCK_UPSTREAM_KEY`）。

import { createServer, type IncomingHttpHeaders, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProviderConfig } from '@wevir/runtime-adapter';

export const MOCK_MODEL = 'wevir-mock';
/** 不是密钥：网关要求 Provider 有 Key，mock 不校验。 */
export const MOCK_UPSTREAM_KEY = 'wevir-mock-upstream-key-not-a-secret';

export interface MockRequestBody {
  model: string;
  input: Array<{ type: string; role?: string; content?: unknown; [key: string]: unknown }>;
  tools?: Array<{ type: string; name?: string; tools?: unknown[]; [key: string]: unknown }>;
  [key: string]: unknown;
}

/** 模型看到的这一步。 */
export interface MockView {
  /** 第几个请求（从 0 起）。 */
  index: number;
  /** 最后一条真正的用户输入（跳过 Codex 注入的 `<environment_context>` 等以 `<` 开头的消息）。 */
  lastUserText: string;
  /** 最后一条用户输入之后已经回来的工具输出，按顺序。 */
  toolOutputs: string[];
  body: MockRequestBody;
}

export interface MockToolCall {
  kind: 'function' | 'custom';
  name: string;
  /** Responses 的工具命名空间（如 multi_agent_v1）。 */
  namespace?: string;
  /** function：参数对象。 */
  args?: unknown;
  /** custom：自由文本输入（apply_patch 的补丁）。 */
  input?: string;
}

export interface MockReply {
  reasoning?: string[];
  text?: string[];
  toolCalls?: MockToolCall[];
  /** 每个分片之后停多久。 */
  delayMs?: number;
  /** 不发流，直接回 HTTP 错误。 */
  httpError?: { status: number; message: string };
  /** 报的输入 token 数（默认 1000；输出总是 20）。 */
  inputTokens?: number;
  /** 发出这么多个文本分片之后结束响应，不发 `response.completed`：流中途断开，Codex 按 `stream_max_retries` 重试。 */
  endAfterText?: number;
  /** 以 `response.incomplete`（`incomplete_details.reason` 是这个值）结束，代替 `response.completed`。 */
  incomplete?: string;
}

export type MockScript = (view: MockView) => MockReply;

export interface MockRequestRecord {
  body: MockRequestBody;
  headers: IncomingHttpHeaders;
}

export interface MockModel {
  /** 到 `/v1` 为止（Provider 的 `baseURL`）。 */
  baseURL: string;
  requests: MockRequestRecord[];
  close(): Promise<void>;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part?.text === 'string' ? (part.text as string) : ''))
    .join('');
}

export function viewOf(body: MockRequestBody, index: number): MockView {
  let lastUser = -1;
  body.input.forEach((item, i) => {
    if (
      item.type === 'message' &&
      item.role === 'user' &&
      !textOf(item.content).trimStart().startsWith('<')
    ) {
      lastUser = i;
    }
  });
  const toolOutputs = body.input
    .slice(lastUser + 1)
    .filter(
      (item) => item.type === 'function_call_output' || item.type === 'custom_tool_call_output',
    )
    .map((item) => (typeof item.output === 'string' ? item.output : JSON.stringify(item.output)));
  return {
    index,
    lastUserText: lastUser < 0 ? '' : textOf(body.input[lastUser]?.content),
    toolOutputs,
    body,
  };
}

function hasCustomTool(tools: MockRequestBody['tools'], name: string): boolean {
  return (tools ?? []).some(
    (tool) =>
      (tool.type === 'custom' && tool.name === name) ||
      (tool.type === 'namespace' && hasCustomTool(tool.tools as MockRequestBody['tools'], name)),
  );
}

let callCounter = 0;

/** 一次回复的 Responses 事件序列（null 表示停顿）。 */
function* render(
  reply: MockReply,
  responseId: string,
  body: MockRequestBody,
): Generator<Record<string, unknown> | null> {
  yield { type: 'response.created', response: { id: responseId } };
  let outputIndex = 0;
  const output: Record<string, unknown>[] = [];
  if (reply.reasoning?.length) {
    const id = `rs_${responseId}`;
    yield {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: { type: 'reasoning', id, summary: [] },
    };
    for (const delta of reply.reasoning) {
      yield {
        type: 'response.reasoning_text.delta',
        item_id: id,
        output_index: outputIndex,
        content_index: 0,
        delta,
      };
      if (reply.delayMs) yield null;
    }
    const item = {
      type: 'reasoning',
      id,
      summary: [],
      content: [{ type: 'reasoning_text', text: reply.reasoning.join('') }],
    };
    output.push(item);
    yield { type: 'response.output_item.done', output_index: outputIndex, item };
    outputIndex += 1;
  }
  if (reply.text?.length) {
    const id = `msg_${responseId}`;
    yield {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: { type: 'message', role: 'assistant', id, content: [] },
    };
    for (const delta of reply.text) {
      yield {
        type: 'response.output_text.delta',
        item_id: id,
        output_index: outputIndex,
        content_index: 0,
        delta,
      };
      if (reply.delayMs) yield null;
    }
    const item = {
      type: 'message',
      role: 'assistant',
      id,
      content: [{ type: 'output_text', text: reply.text.join('') }],
    };
    output.push(item);
    yield { type: 'response.output_item.done', output_index: outputIndex, item };
    outputIndex += 1;
  }
  for (const call of reply.toolCalls ?? []) {
    callCounter += 1;
    const callId = `call_wevir_mock_${callCounter}`;
    const namespace = call.namespace === undefined ? {} : { namespace: call.namespace };
    const item =
      call.kind === 'custom' && hasCustomTool(body.tools, call.name)
        ? {
            type: 'custom_tool_call',
            call_id: callId,
            name: call.name,
            input: call.input ?? '',
            ...namespace,
          }
        : {
            type: 'function_call',
            call_id: callId,
            name: call.name,
            arguments: JSON.stringify(
              call.kind === 'custom' ? { input: call.input ?? '' } : (call.args ?? {}),
            ),
            ...namespace,
          };
    yield {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: item.type === 'function_call' ? { ...item, arguments: '' } : { ...item, input: '' },
    };
    output.push(item);
    yield { type: 'response.output_item.done', output_index: outputIndex, item };
    outputIndex += 1;
  }
  yield {
    type: reply.incomplete === undefined ? 'response.completed' : 'response.incomplete',
    response: {
      id: responseId,
      ...(reply.incomplete !== undefined && {
        status: 'incomplete',
        incomplete_details: { reason: reply.incomplete },
      }),
      output,
      usage: {
        input_tokens: reply.inputTokens ?? 1000,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 20,
        output_tokens_details: { reasoning_tokens: reply.reasoning?.length ?? 0 },
        total_tokens: (reply.inputTokens ?? 1000) + 20,
      },
    },
  };
}

export async function startMockModel(script: MockScript = defaultMockScript): Promise<MockModel> {
  const requests: MockRequestRecord[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      raw += chunk;
    });
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.endsWith('/responses')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `mock：不支持 ${req.method} ${req.url}` } }));
        return;
      }
      const body = JSON.parse(raw) as MockRequestBody;
      const index = requests.length;
      requests.push({ body, headers: req.headers });
      void respond(script(viewOf(body, index)), `resp_${index}`, body, res).catch(() =>
        res.destroy(),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function respond(
  reply: MockReply,
  id: string,
  body: MockRequestBody,
  res: ServerResponse,
): Promise<void> {
  if (reply.httpError) {
    res.writeHead(reply.httpError.status, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { message: reply.httpError.message, type: 'invalid_request_error' },
      }),
    );
    return;
  }
  let closed = false;
  res.on('close', () => {
    closed = !res.writableFinished;
  });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  let texts = 0;
  for (const event of render(reply, id, body)) {
    if (closed) return;
    if (event === null) await new Promise((resolve) => setTimeout(resolve, reply.delayMs ?? 0));
    else res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    if (event?.type === 'response.output_text.delta') texts += 1;
    if (reply.endAfterText !== undefined && texts >= reply.endAfterText) break;
  }
  res.end();
}

/** 新建文件 `wevir-mock.txt` 的补丁（apply_patch 的 freeform 格式）。 */
export const MOCK_PATCH = [
  '*** Begin Patch',
  '*** Add File: wevir-mock.txt',
  '+hello from the Wevir mock model',
  '*** End Patch',
].join('\n');

/** 生成会话标题的请求（prompts/thread-title.md 的第一句在说明里）。 */
const TITLE_PROMPT = '你为 Wevir 的会话起标题';

/** 子 agent 的任务描述的开头：mock 看到它就知道这是子 agent 的请求（子 thread 的第一条用户消息就是任务描述）。 */
export const SUBAGENT_TASK_PREFIX = 'Helper task:';

/** 让父 agent 派出子 agent 的提示词。 */
export const SUBAGENT_PATTERN = /subagent|子智能体/i;

/** `spawn_agent` 的结果里取子 agent 的 ID（与 Spike 的 subagent 场景相同）。 */
function spawnedAgentId(output: string): string {
  return /"(?:agent_id|id)"\s*:\s*"([^"]+)"/.exec(output)?.[1] ?? output;
}

/**
 * 父 agent 派一个子 agent、等它结束（与 Spike 的 subagent 场景相同的 spawn → wait）：先 `spawn_agent`，任务描述是
 * `Helper task:` 加用户的话；拿到 ID 后 `wait_agent`；等到结果后回一句话。
 */
function subagentParent(view: MockView): MockReply {
  const outputs = view.toolOutputs;
  if (outputs.length === 0) {
    return {
      text: ['我派一个子 agent 去做。'],
      toolCalls: [
        {
          kind: 'function',
          namespace: 'multi_agent_v1',
          name: 'spawn_agent',
          args: { message: `${SUBAGENT_TASK_PREFIX} ${view.lastUserText}\n做完说一声。` },
        },
      ],
      delayMs: 5,
    };
  }
  if (outputs.length === 1) {
    return {
      toolCalls: [
        {
          kind: 'function',
          namespace: 'multi_agent_v1',
          name: 'wait_agent',
          args: { targets: [spawnedAgentId(outputs[0] ?? '')], timeout_ms: 30_000 },
        },
      ],
    };
  }
  return { text: ['子 agent ', '已经完成了。'], delayMs: 5 };
}

/**
 * 默认脚本，按最后一条用户输入里的关键词决定（契约测试的默认提示词与桌面验收都用它）：
 * - 生成会话标题的请求：回 `{"title", "description"}`，标题是“Mock：”加用户消息的开头；
 * - 含 `tool` 或“工具”：先调一次 `exec_command`（`ls`，在工作区里，沙箱内不需要审批），拿到输出后再回一句话；
 * - 含 `patch` 或“补丁”：用 apply_patch 新建 `wevir-mock.txt`，再回一句话；
 * - 含 `outside` 或“工作区外”：越出沙箱 `touch` 工作区外的文件（要审批），再回一句话。文件名取提示词里第一个
 *   `*.txt`，没有时是 `wevir-mock-outside.txt`；目录是 `WEVIR_MOCK_OUTSIDE_DIR`，没设时是家目录；
 * - 含 `long` 或“长”：慢慢流出一段长回答（约 6 秒），给流式中途取消用；
 * - 含 `slow` 或“慢”：流出一段约 1.5 秒的回答，给回合进行中插话与排队用（R11）；插话进回合后，下一次请求的最后一条
 *   用户输入就是插话，照这些规则回答；
 * - 含 `subagent` 或“子智能体”：派一个子 agent 并等它结束（spawn → wait，`subagentParent`）；子 agent 的请求（用户消息以
 *   `Helper task:` 开头）照上面的规则回答，所以“子智能体 + 工作区外”让子 agent 请求审批，“子智能体 + 长”让它慢慢回答；
 *   子 agent 的普通回答是“子 agent 完成了。”；
 * - 其余：先逐片发推理，再逐片发文本。
 */
export const defaultMockScript: MockScript = (view) => {
  const prompt = view.lastUserText;
  if (JSON.stringify(view.body).includes(TITLE_PROMPT)) {
    const asked = view.body.input
      .map((item) => /<user_prompt>\n([\s\S]*?)\n<\/user_prompt>/.exec(textOf(item.content))?.[1])
      .find((text) => text !== undefined)
      ?.trim();
    const title = `Mock：${Array.from(asked ?? '')
      .slice(0, 10)
      .join('')}`;
    return { text: [JSON.stringify({ title, description: `mock 生成的标题：${asked ?? ''}` })] };
  }
  const child = prompt.trimStart().startsWith(SUBAGENT_TASK_PREFIX);
  if (!child && SUBAGENT_PATTERN.test(prompt)) return subagentParent(view);
  if (view.toolOutputs.length > 0) {
    return { text: ['工具已经运行完了', '，结果在上面。'], delayMs: 5 };
  }
  if (/tool|工具/i.test(prompt)) {
    return {
      reasoning: ['需要看一下', '工作区里有什么。'],
      text: ['我先列一下工作区的文件。'],
      toolCalls: [{ kind: 'function', name: 'exec_command', args: { cmd: 'ls' } }],
      delayMs: 5,
    };
  }
  if (/patch|补丁/i.test(prompt)) {
    return {
      text: ['我来新建一个文件。'],
      toolCalls: [{ kind: 'custom', name: 'apply_patch', input: MOCK_PATCH }],
      delayMs: 5,
    };
  }
  if (/outside|工作区外/i.test(prompt)) {
    const name = /[\w.-]+\.txt/.exec(prompt)?.[0] ?? 'wevir-mock-outside.txt';
    const target = join(process.env.WEVIR_MOCK_OUTSIDE_DIR || homedir(), name);
    return {
      text: ['这个文件在工作区之外，我申请一下权限。'],
      toolCalls: [
        {
          kind: 'function',
          name: 'exec_command',
          args: {
            cmd: `touch ${JSON.stringify(target)}`,
            sandbox_permissions: 'require_escalated',
            justification: `要在工作区之外新建 ${name}`,
          },
        },
      ],
      delayMs: 5,
    };
  }
  if (/long|长/i.test(prompt)) {
    return {
      text: Array.from({ length: 40 }, (_, i) => `这是长回答的第 ${i + 1} 段。`),
      delayMs: 150,
    };
  }
  if (/slow|慢/i.test(prompt)) {
    return {
      text: Array.from({ length: 10 }, (_, i) => `慢慢说第 ${i + 1} 句。`),
      delayMs: 150,
    };
  }
  if (child) return { text: ['子 agent ', '完成了。'], delayMs: 5 };
  return {
    reasoning: ['用户在打招呼，', '简单回应即可。'],
    text: ['你好！', '我是 Wevir 的', ' mock 模型。'],
    delayMs: 5,
  };
};

/** 指向 mock 的 Provider（`openai-compatible` + `openai-responses`，经网关透传）。 */
export function mockProvider(
  model: MockModel,
  overrides: Partial<ProviderConfig> = {},
): ProviderConfig {
  return {
    id: 'mock',
    kind: 'openai-compatible',
    displayName: 'Wevir Mock',
    api: 'openai-responses',
    baseURL: model.baseURL,
    models: [{ id: MOCK_MODEL, displayName: 'Wevir Mock', contextWindow: 128_000 }],
    defaultModelId: MOCK_MODEL,
    apiKey: MOCK_UPSTREAM_KEY,
    ...overrides,
  };
}
