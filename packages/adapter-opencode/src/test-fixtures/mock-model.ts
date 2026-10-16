// 本机的假模型服务（OpenAI 兼容的 /v1/chat/completions，流式）：让真实的 `opencode serve` 不连外网、不用订阅也能跑完一个回合，
// 录事件（record-events.test.ts）与真实 opencode 上的契约（opencode-adapter.contract.real.integration.test.ts）都用它。回答按
// 最后一条用户消息选脚本（契约的默认提示词，见 runtime-adapter 的 DEFAULT_CONTRACT_PROMPTS），最后一条是工具结果时给收尾的回答；
// 请求里有 StructuredOutput 工具的（`format: json_schema`，Wevir 的标题）调用它交出 MOCK_STRUCTURED_TITLE；请求里没有工具的
// （opencode 自己生成标题等）一律回一句短话。慢回答（`slow`）流得够久，插话（`steer`）来得及在这一步结束前进来。

import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DEFAULT_CONTRACT_PROMPTS } from '@wevir/runtime-adapter/contract';

/** 交给 opencode 的 Provider ID 与模型 ID（模型在 Wevir 里是 `mock/echo`）。 */
export const MOCK_PROVIDER_ID = 'mock';
export const MOCK_MODEL_ID = 'echo';

/** 契约之外录事件用的提示词。 */
export const EXTRA_PROMPTS = Object.freeze({
  todo: 'Please plan the work',
  question: 'Please ask me a question',
  fail: 'Please fail',
  reasoning: 'Please think first',
  /** 应用级工具（app-tools.ts）：一个只读的、一个要审批的。 */
  appList: 'Please list the Wevir sessions',
  appCreate: 'Please open a Wevir session',
});

/** 应用级工具调用之后，假模型把工具结果原样带进回答（核对结果交到了模型）。 */
export const APP_TOOL_REPLY_PREFIX = 'Wevir said: ';

/** 子 agent 收到的任务（task 工具的 prompt），子会话按它选脚本。 */
export const SUBAGENT_PROMPT = 'Reply with hi';
export const SUBAGENT_APPROVAL_PROMPT = 'Run echo in the subagent';

/** `format: json_schema` 时 opencode 加给模型的工具（模型调用它交出结构化结果）。 */
export const STRUCTURED_OUTPUT_TOOL = 'StructuredOutput';
/** 假模型交出的标题（`generateTitle`）。 */
export const MOCK_STRUCTURED_TITLE = Object.freeze({
  title: 'Mock title',
  description: 'A title from the mock model',
});

interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: unknown[];
}

interface ChatRequest {
  messages?: ChatMessage[];
  tools?: unknown[];
  stream?: boolean;
}

type Step =
  | { kind: 'text'; chunks: string[]; reasoning?: string[]; delayMs?: number }
  | { kind: 'tool'; name: string; args: Record<string, unknown>; text?: string }
  | { kind: 'error'; status: number; message: string };

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === 'object' &&
        part !== null &&
        typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join('');
  }
  return '';
}

function toolNames(request: ChatRequest): string[] {
  return (request.tools ?? []).map(
    (tool) => (tool as { function?: { name?: unknown } }).function?.name as string,
  );
}

/** 按请求选这一步的回答。 */
export function scriptStep(request: ChatRequest): Step {
  const messages = request.messages ?? [];
  if (toolNames(request).includes(STRUCTURED_OUTPUT_TOOL)) {
    return { kind: 'tool', name: STRUCTURED_OUTPUT_TOOL, args: MOCK_STRUCTURED_TITLE };
  }
  if (!Array.isArray(request.tools) || request.tools.length === 0) {
    return { kind: 'text', chunks: ['Mock title'] };
  }
  const lastUser = [...messages].reverse().find((message) => message.role === 'user');
  const prompt = textOf(lastUser?.content).trim();
  const afterTool = messages.at(-1)?.role === 'tool';
  const has = (needle: string) => prompt.includes(needle);

  if (has(SUBAGENT_APPROVAL_PROMPT)) {
    return afterTool
      ? { kind: 'text', chunks: ['The subagent ran ', 'the command.'] }
      : {
          kind: 'tool',
          name: 'bash',
          args: { command: 'echo wevir-subagent', description: 'Print a marker' },
        };
  }
  if (has(SUBAGENT_PROMPT)) {
    return { kind: 'text', chunks: ['hi from ', 'the subagent'] };
  }
  if (has(DEFAULT_CONTRACT_PROMPTS.subagentApproval)) {
    return afterTool
      ? { kind: 'text', chunks: ['The subagent finished.'] }
      : {
          kind: 'tool',
          name: 'task',
          args: {
            description: 'Run a command',
            prompt: SUBAGENT_APPROVAL_PROMPT,
            subagent_type: 'general',
          },
        };
  }
  if (has(DEFAULT_CONTRACT_PROMPTS.subagent)) {
    return afterTool
      ? { kind: 'text', chunks: ['The subagent replied.'] }
      : {
          kind: 'tool',
          name: 'task',
          args: { description: 'Say hi', prompt: SUBAGENT_PROMPT, subagent_type: 'general' },
        };
  }
  if (has(DEFAULT_CONTRACT_PROMPTS.approval)) {
    return afterTool
      ? { kind: 'text', chunks: ['The command ', 'ran.'] }
      : {
          kind: 'tool',
          name: 'bash',
          args: { command: 'echo wevir', description: 'Print a marker' },
        };
  }
  if (has(DEFAULT_CONTRACT_PROMPTS.toolCall)) {
    return afterTool
      ? { kind: 'text', chunks: ['Found ', 'the file.'] }
      : { kind: 'tool', name: 'glob', args: { pattern: '*.txt' } };
  }
  if (has(DEFAULT_CONTRACT_PROMPTS.steer)) {
    return { kind: 'text', chunks: ['The weather ', 'is sunny.'] };
  }
  if (has(DEFAULT_CONTRACT_PROMPTS.slow)) {
    return {
      kind: 'text',
      chunks: Array.from({ length: 60 }, (_, index) => `word${index} `),
      delayMs: 100,
    };
  }
  if (has(EXTRA_PROMPTS.todo)) {
    return afterTool
      ? { kind: 'text', chunks: ['Planned.'] }
      : {
          kind: 'tool',
          name: 'todowrite',
          args: {
            todos: [
              { content: 'Read the code', status: 'completed', priority: 'high' },
              { content: 'Write the fix', status: 'in_progress', priority: 'high' },
              { content: 'Run the tests', status: 'pending', priority: 'medium' },
            ],
          },
        };
  }
  if (has(EXTRA_PROMPTS.question)) {
    return afterTool
      ? { kind: 'text', chunks: ['Thanks for ', 'answering.'] }
      : {
          kind: 'tool',
          name: 'question',
          args: {
            questions: [
              {
                question: 'Which colour should the button be?',
                header: 'Colour',
                options: [
                  { label: 'Blue', description: 'The default accent' },
                  { label: 'Green', description: 'Matches the logo' },
                ],
              },
            ],
          },
        };
  }
  if (has(EXTRA_PROMPTS.appList) || has(EXTRA_PROMPTS.appCreate)) {
    if (afterTool) {
      return { kind: 'text', chunks: [APP_TOOL_REPLY_PREFIX, textOf(messages.at(-1)?.content)] };
    }
    return has(EXTRA_PROMPTS.appList)
      ? { kind: 'tool', name: 'wevir_session_list', args: { scope: 'all' } }
      : { kind: 'tool', name: 'wevir_session_create', args: { prompt: 'Say hi' } };
  }
  if (has(EXTRA_PROMPTS.fail)) {
    return { kind: 'error', status: 400, message: 'mock model rejected the request' };
  }
  if (has(EXTRA_PROMPTS.reasoning)) {
    return {
      kind: 'text',
      reasoning: ['Thinking about ', 'the answer.'],
      chunks: ['Here is ', 'the answer.'],
    };
  }
  return { kind: 'text', chunks: ['Hello from ', 'the mock model.'] };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface MockModel {
  /** 交给 opencode 的 `baseURL`（带 /v1）。 */
  readonly baseUrl: string;
  /** 收到的请求（按顺序）。 */
  readonly requests: ChatRequest[];
  close(): Promise<void>;
}

/** 在 127.0.0.1 的随机端口上起假模型。 */
export async function startMockModel(): Promise<MockModel> {
  const requests: ChatRequest[] = [];
  let callCounter = 0;
  const server: Server = createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'not found' } }));
        return;
      }
      const request = JSON.parse(await readBody(req)) as ChatRequest;
      requests.push(request);
      const step = scriptStep(request);
      if (step.kind === 'error') {
        res.writeHead(step.status, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ error: { message: step.message, type: 'invalid_request_error' } }),
        );
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      const id = `chatcmpl-${++callCounter}`;
      const send = (
        delta: Record<string, unknown>,
        finish: string | null = null,
        usage?: object,
      ) => {
        res.write(
          `data: ${JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created: 0,
            model: MOCK_MODEL_ID,
            choices: [{ index: 0, delta, finish_reason: finish }],
            ...(usage !== undefined && { usage }),
          })}\n\n`,
        );
      };
      const usage = { prompt_tokens: 120, completion_tokens: 12, total_tokens: 132 };
      send({ role: 'assistant', content: '' });
      if (step.kind === 'tool') {
        send({
          tool_calls: [
            {
              index: 0,
              id: `call_${callCounter}`,
              type: 'function',
              function: { name: step.name, arguments: JSON.stringify(step.args) },
            },
          ],
        });
        send({}, 'tool_calls', usage);
      } else {
        for (const chunk of step.reasoning ?? []) send({ reasoning_content: chunk });
        for (const chunk of step.chunks) {
          if (res.destroyed) return;
          send({ content: chunk });
          if (step.delayMs !== undefined) await sleep(step.delayMs);
        }
        send({}, 'stop', usage);
      }
      res.end('data: [DONE]\n\n');
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** 交给 opencode 的配置（`OPENCODE_CONFIG_CONTENT`）：只有假模型，不更新、不分享、不起 LSP 与格式化。 */
export function mockOpenCodeConfig(baseUrl: string): string {
  return JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    share: 'disabled',
    lsp: false,
    formatter: false,
    model: `${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}`,
    small_model: `${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}`,
    enabled_providers: [MOCK_PROVIDER_ID],
    provider: {
      [MOCK_PROVIDER_ID]: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Mock',
        options: { baseURL: baseUrl, apiKey: 'mock-key' },
        models: {
          [MOCK_MODEL_ID]: {
            name: 'Mock Echo',
            reasoning: true,
            tool_call: true,
            limit: { context: 128000, output: 8192 },
          },
        },
      },
    },
  });
}

/**
 * 跑真实 opencode 的隔离环境：数据、配置、缓存、状态都放进 `root`（不碰用户自己的 ~/.local/share/opencode 与登录），
 * 只有假模型，不拉 models.dev、不自动更新。
 */
export function isolatedOpenCodeEnv(root: string, baseUrl: string): NodeJS.ProcessEnv {
  return {
    HOME: root,
    PATH: process.env.PATH,
    USER: process.env.USER,
    TMPDIR: process.env.TMPDIR,
    XDG_DATA_HOME: `${root}/data`,
    XDG_CONFIG_HOME: `${root}/config`,
    XDG_CACHE_HOME: `${root}/cache`,
    XDG_STATE_HOME: `${root}/state`,
    OPENCODE_CONFIG_CONTENT: mockOpenCodeConfig(baseUrl),
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
  };
}
