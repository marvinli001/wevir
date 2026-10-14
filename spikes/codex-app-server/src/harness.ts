// 一个场景的运行环境：临时目录 + 模型后端（直连 Responses mock，或网关 + Chat mock）+ codex-app-server。

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AppServer, type Notification, type ServerRequest } from './app-server.ts';
import {
  BINARY,
  childEnv,
  makeSandbox,
  type Sandbox,
  SPIKE_ROOT,
  writeConfig,
} from './codex-home.ts';
import { type Gateway, startGateway } from './gateway.ts';
import { type ChatRequest, startMockChat } from './mock-chat.ts';
import { type MockServer, type ResponsesRequest, startMockResponses } from './mock-responses.ts';
import type { Script } from './model-script.ts';

/**
 * direct：Codex → Responses 上游（Key 在 Codex 的环境变量里）。
 * gateway：Codex → 网关（Chat 转换）→ Chat 上游。
 * passthrough：Codex → 网关（Responses 透传）→ Responses 上游。后两者 Codex 只拿到一次性令牌。
 */
export type Transport = 'direct' | 'gateway' | 'passthrough';

/** 真实上游；不给就用本地 mock。 */
export interface RealUpstream {
  responsesBaseURL: string;
  chatBaseURL: string;
  key: string;
  model: string;
  chatModel: string;
  chatExtraBody?: Record<string, unknown>;
}

export const MOCK_MODEL = 'wevir-mock';

/**
 * WEVIR_SPIKE_GATEWAY=product：gateway / passthrough 两种接法改用产品网关（packages/model-gateway 的 dist），
 * 同一组场景验证它（R1）。产品网关总要一个上游 Key，mock 上游用假的。
 */
export const PRODUCT_GATEWAY = process.env.WEVIR_SPIKE_GATEWAY === 'product';
export const MOCK_UPSTREAM_KEY = 'mock-upstream-key';

async function startProductGateway(
  chat: boolean,
  upstreamBaseURL: string,
  real: RealUpstream | undefined,
): Promise<{ token: string; gateway: Gateway }> {
  const { startModelGateway } = (await import(
    join(SPIKE_ROOT, '../../packages/model-gateway/dist/index.js')
  )) as {
    startModelGateway: (options?: unknown) => Promise<{
      token: string;
      baseURL(id: string): string;
      setProviders(providers: unknown[]): void;
      close(): Promise<void>;
    }>;
  };
  const gw = await startModelGateway();
  const model = real ? (chat ? real.chatModel : real.model) : MOCK_MODEL;
  gw.setProviders([
    {
      id: 'spike',
      kind: 'openai-compatible',
      displayName: 'Wevir spike',
      api: chat ? 'openai-completions' : 'openai-responses',
      baseURL: upstreamBaseURL,
      models: [{ id: model }],
      defaultModelId: model,
      apiKey: real?.key ?? MOCK_UPSTREAM_KEY,
    },
  ]);
  return {
    token: gw.token,
    gateway: {
      baseURL: gw.baseURL('spike'),
      translated: [],
      forwardedHeaders: [],
      dropped: [],
      close: () => gw.close(),
    },
  };
}
export const KEY_ENV = 'WEVIR_PROVIDER_SPIKE_KEY';

/** Codex 给未知模型用的基础提示词（models-manager/prompt.md）；目录里的模型必须带 base_instructions。 */
const PROMPT_FILE = join(SPIKE_ROOT, '../../upstream/codex/codex-rs/models-manager/prompt.md');
export const BASE_INSTRUCTIONS = existsSync(PROMPT_FILE)
  ? readFileSync(PROMPT_FILE, 'utf8')
  : 'You are a coding agent running inside Wevir.';

/** 模型目录：声明 apply_patch 用 freeform 自定义工具（未知模型的默认元数据没有 apply_patch，
 * upstream/codex/codex-rs/models-manager/src/model_info.rs model_info_from_slug）。 */
export function mockCatalog(slug = MOCK_MODEL): Record<string, unknown> {
  return {
    models: [
      {
        slug,
        base_instructions: BASE_INSTRUCTIONS,
        display_name: slug,
        description: 'Wevir spike mock model',
        supported_reasoning_levels: [],
        shell_type: 'unified_exec',
        visibility: 'list',
        supported_in_api: true,
        priority: 1,
        availability_nux: null,
        upgrade: null,
        support_verbosity: false,
        default_verbosity: null,
        apply_patch_tool_type: 'freeform',
        truncation_policy: { mode: 'bytes', limit: 10000 },
        experimental_supported_tools: [],
        context_window: 128000,
        input_modalities: ['text'],
      },
    ],
  };
}

export interface HarnessOptions {
  transport: Transport;
  script: Script;
  /** 审批回调；默认一律 decline。 */
  decide?: (request: ServerRequest) => Promise<unknown> | unknown;
  catalog?: boolean;
  extraTop?: string[];
  experimentalApi?: boolean;
  trace?: boolean;
  real?: RealUpstream;
}

export class Harness {
  sandbox!: Sandbox;
  server!: AppServer;
  responses?: MockServer<ResponsesRequest>;
  chat?: MockServer<ChatRequest>;
  gateway?: Gateway;
  threadId = '';
  readonly options: HarnessOptions;
  #token = '';

  constructor(options: HarnessOptions) {
    this.options = options;
  }

  static async start(label: string, options: HarnessOptions): Promise<Harness> {
    const h = new Harness(options);
    h.sandbox = makeSandbox(label);
    let baseURL: string;
    const real = options.real;
    if (options.transport === 'direct') {
      if (real) {
        baseURL = real.responsesBaseURL;
        h.#token = real.key;
      } else {
        h.responses = await startMockResponses(options.script);
        baseURL = h.responses.baseURL;
        h.#token = 'mock-key-not-a-secret';
      }
    } else {
      const chat = options.transport === 'gateway';
      let upstreamBaseURL: string;
      if (real) {
        upstreamBaseURL = chat ? real.chatBaseURL : real.responsesBaseURL;
      } else if (chat) {
        h.chat = await startMockChat(options.script);
        upstreamBaseURL = h.chat.baseURL;
      } else {
        h.responses = await startMockResponses(options.script);
        upstreamBaseURL = h.responses.baseURL;
      }
      if (PRODUCT_GATEWAY) {
        // 产品网关（packages/model-gateway，先 pnpm --filter @wevir/model-gateway build）：令牌由网关生成。
        const product = await startProductGateway(chat, upstreamBaseURL, real);
        h.#token = product.token;
        h.gateway = product.gateway;
        baseURL = product.gateway.baseURL;
      } else {
        // 一次性令牌：只有 Codex 与网关知道；上游 Key 只在网关里。
        h.#token = randomBytes(24).toString('base64url');
        h.gateway = await startGateway({
          upstreamProtocol: chat ? 'chat' : 'responses',
          upstreamBaseURL,
          upstreamKey: real?.key,
          upstreamModel: real ? (chat ? real.chatModel : real.model) : undefined,
          extraBody: chat ? real?.chatExtraBody : undefined,
          sessionToken: h.#token,
          log: options.trace || real ? (l) => console.error(`  [gw] ${l}`) : undefined,
        });
        baseURL = h.gateway.baseURL;
      }
    }
    writeConfig(
      h.sandbox.codexHome,
      {
        id: 'wevir_spike',
        name: 'Wevir spike',
        baseURL,
        envKey: KEY_ENV,
        model: real?.model ?? MOCK_MODEL,
        catalog: options.catalog === false ? undefined : mockCatalog(real?.model ?? MOCK_MODEL),
        // mock 不会 429，别让重试拖慢失败的用例；真实上游用 Codex 的默认重试。
        extra: real ? [] : ['request_max_retries = 0', 'stream_max_retries = 0'],
      },
      options.extraTop,
    );
    h.spawn();
    await h.server.initialize(options.experimentalApi ?? false);
    return h;
  }

  /** 起（或重起）app-server，复用同一个 CODEX_HOME。 */
  spawn(): AppServer {
    this.server = new AppServer({
      binary: BINARY,
      codexHome: this.sandbox.codexHome,
      env: childEnv(this.sandbox, { [KEY_ENV]: this.#token }),
      onServerRequest: (r) => this.options.decide?.(r) ?? { decision: 'decline' },
      trace: this.options.trace,
    });
    return this.server;
  }

  async startThread(params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const result = await this.server.request<{ thread: { id: string } }>('thread/start', {
      cwd: this.sandbox.workspace,
      ...params,
    });
    this.threadId = result.thread.id;
    return result;
  }

  async startTurn(text: string, threadId = this.threadId): Promise<string> {
    const result = await this.server.request<{ turn: { id: string } }>('turn/start', {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
    });
    return result.turn.id;
  }

  /** 发一条消息并等回合结束，返回 turn/completed 的 turn 对象。 */
  async turn(
    text: string,
    timeoutMs = 60_000,
  ): Promise<{ id: string; status: string; error: unknown }> {
    const turnId = await this.startTurn(text);
    const done = await this.server.waitTurnCompleted(this.threadId, turnId, timeoutMs);
    return done.params.turn as { id: string; status: string; error: unknown };
  }

  notificationsFor(turnId: string, threadId = this.threadId): Notification[] {
    return this.server.notifications.filter(
      (n) =>
        n.params.threadId === threadId &&
        (n.params.turnId === turnId ||
          (n.params.turn as { id?: string } | undefined)?.id === turnId),
    );
  }

  itemsCompleted(turnId: string, type?: string): Array<Record<string, unknown>> {
    return this.notificationsFor(turnId)
      .filter((n) => n.method === 'item/completed')
      .map((n) => n.params.item as Record<string, unknown>)
      .filter((item) => type === undefined || item.type === type);
  }

  /** Codex 拿到的 Key（直连）或一次性令牌（网关）：只给 secrets 场景检查落盘用。 */
  envValue(): string {
    return this.#token;
  }

  /** 模型收到的请求数（直连数 Responses mock，网关数 Chat mock）。 */
  get modelRequests(): number {
    return (this.responses?.requests.length ?? 0) + (this.chat?.requests.length ?? 0);
  }

  async dispose(): Promise<void> {
    await this.server?.close();
    await this.responses?.close();
    await this.gateway?.close();
    await this.chat?.close();
    if (!process.argv.includes('--keep')) this.sandbox?.dispose();
    else console.log(`  保留 ${this.sandbox.root}`);
  }
}
