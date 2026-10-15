// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-opencode/src/server/OpenCodeRuntime.ts（`createOpenCodeSdkClient`、`runOpenCodeSdk`、
// `openCodeRuntimeErrorDetail`）与 adapter.ts（`isOpenCodeNotFound`）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：Effect 的服务换成窄接口 OpenCodeClient，第一次用到时才动态 import SDK，测试换成假的（test-fixtures/fake-opencode.ts）。
//
// OpenCode 的官方 SDK（`@opencode-ai/sdk`，只有本包能声明与 import，AGENTS.md 规则 2）。它只是 `opencode serve` 的 HTTP 客户端：
// 引擎是用户自己装的 `opencode`，适配器在本机起它的服务器（server.ts），经这里的窄接口说话。用 SDK 的 `v2` 入口（T3 同）：
// 1.x 服务器的会话、消息、权限与提问接口。2.x 是另一套协议（`@opencode/client`），还不支持（opencode-event-mapping.md §1）。

import type {
  AssistantMessage,
  Event,
  Message,
  OutputFormat,
  Part,
  PermissionRule,
  PermissionRuleset,
  ProviderListResponse,
  QuestionAnswer,
  Session,
  SessionStatus,
} from '@opencode-ai/sdk/v2/client';

/** 锁定的 SDK 版本（package.json 钉的确切版本）。 */
export const OPENCODE_SDK_VERSION = '1.18.34';

/** 一次 `promptAsync` 的参数（文本与图片文件）。 */
export interface PromptInput {
  sessionID: string;
  /** 客户端给的用户消息 ID（opencode 的 `msg_` 格式，messageId.ts），用来认出这次输入对应的回合。 */
  messageID: string;
  model: { providerID: string; modelID: string };
  /** 模型的变体（opencode 的推理档位）。 */
  variant?: string;
  /** 图片（0.28.0）是 `file` 部件：opencode 自己读 `file://` 地址的文件（同 T3 Code 的 toOpenCodeFileParts）。 */
  parts: Array<
    { type: 'text'; text: string } | { type: 'file'; mime: string; filename?: string; url: string }
  >;
}

/**
 * 一次同步的 `prompt`（opencode 跑完这一轮才返回）：生成标题（`format: json_schema`，T3 的 textGeneration.ts）与只写进历史、
 * 不开回合的说明（`noReply: true`，此时 opencode 存下用户消息就返回）。
 */
export interface SyncPromptInput {
  sessionID: string;
  messageID?: string;
  /** 省略时 opencode 用会话上一条消息的模型。 */
  model?: { providerID: string; modelID: string };
  variant?: string;
  /** 接在 opencode 自己的系统提示之后。 */
  system?: string;
  format?: OutputFormat;
  noReply?: boolean;
  parts: Array<{ type: 'text'; text: string }>;
}

/** 适配器用到的 opencode 服务器接口（一个客户端对应一个工作目录，`x-opencode-directory`）。 */
export interface OpenCodeClient {
  health(signal?: AbortSignal): Promise<{ healthy: true; version: string }>;
  providers(signal?: AbortSignal): Promise<ProviderListResponse>;
  createSession(input: { permission: PermissionRuleset; title?: string }): Promise<Session>;
  getSession(sessionID: string): Promise<Session>;
  deleteSession(sessionID: string): Promise<void>;
  /** 分出一个新会话，带着 `messageID` 之前（不含）的消息；省略时带全部。 */
  forkSession(sessionID: string, messageID?: string): Promise<Session>;
  updateSession(sessionID: string, input: { permission: PermissionRuleset }): Promise<Session>;
  children(sessionID: string): Promise<Session[]>;
  messages(sessionID: string): Promise<Array<{ info: Message; parts: Part[] }>>;
  status(): Promise<Record<string, SessionStatus>>;
  /** 发出输入，opencode 接受即返回（204），回合经事件流推进。 */
  promptAsync(input: PromptInput, signal?: AbortSignal): Promise<void>;
  /** `noReply` 时返回存下的用户消息，否则返回这一轮最后的 assistant 消息。 */
  prompt(input: SyncPromptInput, signal?: AbortSignal): Promise<{ info: Message; parts: Part[] }>;
  deleteMessage(sessionID: string, messageID: string): Promise<void>;
  abort(sessionID: string): Promise<void>;
  replyPermission(
    requestID: string,
    reply: 'once' | 'always' | 'reject',
    message?: string,
  ): Promise<void>;
  replyQuestion(requestID: string, answers: QuestionAnswer[]): Promise<void>;
  rejectQuestion(requestID: string): Promise<void>;
  /** 这个目录实例的事件流（SSE），`signal` 中止时结束。 */
  subscribe(signal: AbortSignal): Promise<AsyncIterable<Event>>;
}

/** 连到一个 opencode 服务器。 */
export interface OpenCodeConnectInput {
  baseUrl: string;
  directory: string;
  /** 服务器的密码（`OPENCODE_SERVER_PASSWORD`，HTTP Basic，用户名 `opencode`）。 */
  password?: string;
}

export interface OpenCodeSdk {
  connect(input: OpenCodeConnectInput): OpenCodeClient;
}

export type {
  AssistantMessage,
  Event,
  Message,
  OutputFormat,
  Part,
  PermissionRule,
  PermissionRuleset,
  ProviderListResponse,
  QuestionAnswer,
  Session,
  SessionStatus,
};

/** SSE 断开后最多重连几次（SDK 默认无限重连；服务器没了时让事件流结束，适配器据此脱开会话）。 */
export const SSE_MAX_RETRY_ATTEMPTS = 3;

function required<T>(operation: string, data: T | undefined): T {
  if (data === undefined) throw new Error(`OpenCode ${operation} returned no response payload`);
  return data;
}

let loading: Promise<OpenCodeSdk> | undefined;

/** 第一次调用时加载 `@opencode-ai/sdk`，之后复用。 */
export function loadOpenCodeSdk(): Promise<OpenCodeSdk> {
  loading ??= import('@opencode-ai/sdk/v2/client').then(
    ({ createOpencodeClient }): OpenCodeSdk => ({
      connect: (input) => {
        const client = createOpencodeClient({
          baseUrl: input.baseUrl,
          directory: input.directory,
          ...(input.password !== undefined && {
            headers: {
              Authorization: `Basic ${Buffer.from(`opencode:${input.password}`, 'utf8').toString('base64')}`,
            },
          }),
          throwOnError: true,
        });
        return {
          health: async (signal) =>
            required('global.health', (await client.global.health({ signal })).data),
          providers: async (signal) =>
            required('provider.list', (await client.provider.list(undefined, { signal })).data),
          createSession: async (body) =>
            required('session.create', (await client.session.create(body)).data),
          getSession: async (sessionID) =>
            required('session.get', (await client.session.get({ sessionID })).data),
          deleteSession: async (sessionID) => {
            await client.session.delete({ sessionID });
          },
          forkSession: async (sessionID, messageID) =>
            required(
              'session.fork',
              (
                await client.session.fork({
                  sessionID,
                  ...(messageID !== undefined && { messageID }),
                })
              ).data,
            ),
          updateSession: async (sessionID, body) =>
            required('session.update', (await client.session.update({ sessionID, ...body })).data),
          children: async (sessionID) =>
            required('session.children', (await client.session.children({ sessionID })).data),
          messages: async (sessionID) =>
            required('session.messages', (await client.session.messages({ sessionID })).data),
          status: async () => required('session.status', (await client.session.status()).data),
          promptAsync: async (body, signal) => {
            await client.session.promptAsync(body, { ...(signal !== undefined && { signal }) });
          },
          prompt: async (body, signal) =>
            required(
              'session.prompt',
              (await client.session.prompt(body, { ...(signal !== undefined && { signal }) })).data,
            ) as { info: Message; parts: Part[] },
          deleteMessage: async (sessionID, messageID) => {
            await client.session.deleteMessage({ sessionID, messageID });
          },
          abort: async (sessionID) => {
            await client.session.abort({ sessionID });
          },
          replyPermission: async (requestID, reply, message) => {
            await client.permission.reply({
              requestID,
              reply,
              ...(message !== undefined && { message }),
            });
          },
          replyQuestion: async (requestID, answers) => {
            await client.question.reply({ requestID, answers });
          },
          rejectQuestion: async (requestID) => {
            await client.question.reject({ requestID });
          },
          subscribe: async (signal) =>
            (
              await client.event.subscribe(undefined, {
                signal,
                sseMaxRetryAttempts: SSE_MAX_RETRY_ATTEMPTS,
              })
            ).stream,
        };
      },
    }),
    (error: unknown) => {
      loading = undefined;
      throw error;
    },
  );
  return loading;
}

/** 错误的原文（T3 的 `openCodeRuntimeErrorDetail`）：SDK 的错误带 `cause: { body, status }`。 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message.trim();
  if (typeof error === 'object' && error !== null) {
    try {
      return JSON.stringify(error);
    } catch {
      // 落到 String。
    }
  }
  return String(error);
}

/** opencode 回 404 或 NotFoundError（T3 的 `isOpenCodeNotFound`：沿 cause / body / error / data 找）。 */
export function isNotFound(error: unknown): boolean {
  const seen = new Set<unknown>();
  const queue: unknown[] = [error];
  for (let steps = 0; queue.length > 0 && steps < 32; steps += 1) {
    const node = queue.shift();
    if (node === null || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    const record = node as Record<string, unknown>;
    const response = record.response;
    const statuses = [
      record.status,
      record.statusCode,
      response !== null && typeof response === 'object'
        ? (response as { status?: unknown }).status
        : undefined,
    ].filter((status): status is number => typeof status === 'number');
    if (statuses.includes(404)) return true;
    if (statuses.length > 0) continue;
    if (typeof record.name === 'string' && record.name.toLowerCase() === 'notfounderror') {
      return true;
    }
    for (const key of ['cause', 'body', 'error', 'data'] as const) {
      if (record[key] !== undefined) queue.push(record[key]);
    }
  }
  return false;
}
