import { type ModelGateway, SseParser } from '@wevir/model-gateway';
import { AdapterError, type ProviderModelConfig, type TitleRequest } from '@wevir/runtime-adapter';
import { toCodexEffort } from './config.js';
import { isRecord } from './mapping.js';

// 会话标题的两条路（R3，codex-event-mapping.md §4.4；Host 一侧见 packages/host/src/title.ts）：
// - 经网关的会话：Host 进程里的适配器直接经自己持有的网关发一次不带工具的 Responses 请求，与 Codex 的请求同样的处理
//   （透传、方言修正，或 Chat / Messages 转换）；
// - 不经网关的会话（ChatGPT 登录，R6）：照 Codex 终端界面（tui/src/app/thread_title.rs 与 temporary_structured_request.rs）
//   开一个临时 thread（`thread/start` 的 `ephemeral`），关掉工具，`turn/start` 带 `outputSchema`，取最终的助手消息。
// 推理档位都取这个模型最低的一档。

/** Wevir 推理档位从低到高（protocol `ProviderReasoningLevel`）。 */
const EFFORT_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** 模型支持的最低推理档位，换成 Codex 的值（`off` → `none`）；模型不推理时 undefined。 */
export function lowestEffort(model: ProviderModelConfig): string | undefined {
  const efforts = model.reasoningEfforts ?? [];
  const lowest =
    EFFORT_ORDER.find((level) => efforts.includes(level)) ??
    (efforts.length > 0 ? efforts[0] : undefined);
  return lowest === undefined ? undefined : toCodexEffort(lowest);
}

/** 模型输出的上限（字符）：标题与摘要只有几十个字，超过就是模型没按要求输出。 */
const MAX_OUTPUT_CHARS = 8 * 1024;

/** 经网关发一次不带工具的流式 Responses 请求，返回最终的助手文本。 */
export async function titleViaGateway(
  gateway: ModelGateway,
  providerId: string,
  model: ProviderModelConfig,
  request: TitleRequest,
): Promise<string> {
  const effort = lowestEffort(model);
  const body = {
    model: model.id,
    instructions: request.instructions,
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: request.input }] },
    ],
    stream: true,
    store: false,
    ...(effort !== undefined && { reasoning: { effort } }),
  };
  let response: Response;
  try {
    response = await fetch(`${gateway.baseURL(providerId)}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: request.signal ?? null,
    });
  } catch (error) {
    throw new AdapterError('engine_unavailable', `生成标题的请求没有发出：${describe(error)}`, {
      cause: error,
    });
  }
  if (!response.ok || response.body === null) {
    const text = await response.text().catch(() => '');
    throw new AdapterError(
      'engine_unavailable',
      `生成标题的请求失败：HTTP ${response.status} ${text.slice(0, 500)}`,
    );
  }
  return readResponsesText(response.body);
}

/** 读 Responses 的流：拼 `response.output_text.delta`，`response.completed` 里有完整的消息时以它为准。 */
async function readResponsesText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const parser = new SseParser();
  let text = '';
  let completed: string | undefined;
  const handle = (data: string): void => {
    if (data.trim() === '' || data.trim() === '[DONE]') return;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(event)) return;
    if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') {
      text += event.delta;
    } else if (event.type === 'response.completed' && isRecord(event.response)) {
      completed = outputText(event.response.output);
    } else if (event.type === 'response.failed' || event.type === 'error') {
      throw new AdapterError('engine_unavailable', `生成标题失败：${data.slice(0, 500)}`);
    }
    if (text.length > MAX_OUTPUT_CHARS) {
      throw new AdapterError('engine_unavailable', '生成标题的输出太长，模型没有按要求输出');
    }
  };
  for await (const chunk of stream) {
    for (const message of parser.push(chunk)) handle(message.data);
  }
  for (const message of parser.end()) handle(message.data);
  return completed !== undefined && completed !== '' ? completed : text;
}

/** `response.output` 里 message 项的 output_text 拼起来。 */
function outputText(output: unknown): string | undefined {
  if (!Array.isArray(output)) return undefined;
  const parts: string[] = [];
  for (const item of output) {
    if (!isRecord(item) || item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (isRecord(part) && part.type === 'output_text' && typeof part.text === 'string') {
        parts.push(part.text);
      }
    }
  }
  return parts.length === 0 ? undefined : parts.join('');
}

/**
 * 临时 thread 的配置覆盖：关掉命令、子 agent、计划、图片等工具与联网搜索，skills 列表不进上下文（取自终端界面
 * `start_temporary_thread` 的同名键；沙箱另设只读、审批 `never`）。标题输入是不可信的对话内容，不给它任何工具。
 */
export const TITLE_THREAD_CONFIG: Readonly<Record<string, unknown>> = Object.freeze({
  'features.shell_tool': false,
  'features.unified_exec': false,
  'features.multi_agent': false,
  'features.multi_agent_v2': false,
  'features.view_image': false,
  'features.image_generation': false,
  'features.request_permissions_tool': false,
  'features.goals': false,
  'features.memories': false,
  'features.plugins': false,
  'tools.update_plan.enabled': false,
  'skills.include_instructions': false,
  web_search: 'disabled',
});

/** 收临时 thread 的通知：最后一条已提交的助手消息；`turn/completed` 时给出结果。 */
export class TitleCollector {
  #text = '';
  #settle!: { resolve: (text: string) => void; reject: (error: unknown) => void };
  readonly done: Promise<string>;

  constructor() {
    this.done = new Promise<string>((resolve, reject) => {
      this.#settle = { resolve, reject };
    });
    // 调用方可能在拿到结果之前就放弃（abort），不让它变成未处理的拒绝。
    this.done.catch(() => {});
  }

  onNotification(method: string, params: unknown): void {
    if (!isRecord(params)) return;
    if (method === 'item/completed') {
      const item = params.item;
      if (isRecord(item) && item.type === 'agentMessage' && typeof item.text === 'string') {
        this.#text = item.text;
      }
      return;
    }
    if (method !== 'turn/completed' || !isRecord(params.turn)) return;
    const { status, error } = params.turn;
    if (status === 'completed') {
      this.#settle.resolve(this.#text);
    } else {
      const message = isRecord(error) && typeof error.message === 'string' ? error.message : '';
      this.#settle.reject(
        new AdapterError(
          'engine_unavailable',
          `生成标题的回合没有完成（${String(status)}）${message}`,
        ),
      );
    }
  }

  fail(error: unknown): void {
    this.#settle.reject(error);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
