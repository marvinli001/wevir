// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-opencode/src/server/textGeneration.ts（`runOpenCodeJson` 的 `runAgainstServer`、
// `getOpenCodePromptFailure`、`isOpenCodeTextPart`、`getOpenCodeTextResponse`）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：只做会话标题（T3 还生成提交信息、PR、分支名与审阅指南）；说明经 `system` 给、输出经 `format: json_schema` 约束，取 assistant
// 消息的 `structured`（T3 把说明与输入拼成一段文本，取模型的文本再自己解析 JSON），临时会话的规则留下 StructuredOutput；变体取
// 模型最低的一档（T3 用会话选的那一档）；用完删掉临时会话（T3 留着，会出现在用户的 opencode 会话列表里）；解析与整理交给 Host。
//
// 会话标题（R3，prompts/thread-title.md，opencode-event-mapping.md §5.11）：在会话的工作目录里开一个临时 opencode 会话，用会话的
// 模型同步 `prompt` 一次，删掉临时会话。opencode 的系统提示照样在前面（它没有不带 agent 提示的请求），Wevir 的说明接在后面。

import type { TitleRequest } from '@wevir/runtime-adapter';
import type { ParsedModelId } from './models.js';
import { TITLE_PERMISSION_RULES } from './permissions.js';
import { errorMessage, type Message, type OpenCodeClient, type Part } from './sdk.js';

/** 临时会话的标题（给了标题 opencode 就不再为它生成一个，省一次模型请求）。 */
export const TITLE_SESSION_TITLE = 'Wevir title';

interface PromptFailure {
  readonly name?: string;
  readonly message: string;
}

/** T3 的 `getOpenCodePromptFailure`：assistant 消息的 `error` → 名字与原文。 */
export function promptFailure(error: unknown): PromptFailure | undefined {
  if (error === null || typeof error !== 'object') return undefined;
  const record = error as { name?: unknown; data?: unknown };
  const name =
    typeof record.name === 'string' && record.name.trim() !== '' ? record.name.trim() : undefined;
  const data = record.data as { message?: unknown } | undefined;
  const message = typeof data?.message === 'string' ? data.message.trim() : '';
  if (message !== '') return { ...(name !== undefined && { name }), message };
  return name === undefined ? undefined : { name, message: name };
}

/** T3 的 `getOpenCodeTextResponse`：文本 part 拼起来。 */
export function textResponse(parts: readonly Part[]): string {
  return parts
    .filter((part): part is Extract<Part, { type: 'text' }> => part.type === 'text')
    .map((part) => part.text)
    .join('')
    .trim();
}

export interface TitleRun {
  client: OpenCodeClient;
  model: ParsedModelId;
  variant?: string;
  request: TitleRequest;
  /** 删不掉临时会话时的告警。 */
  warn?: (message: string, fields: Record<string, unknown>) => void;
}

/**
 * 跑一次标题请求，返回模型的输出：结构化结果的 JSON，模型没走 StructuredOutput 时退回到它的文本（Host 照样试着解析）。
 * 失败抛出带原文的 Error，由适配器归为 `engine_unavailable`。
 */
export async function generateTitleText(run: TitleRun): Promise<string> {
  const { client, request } = run;
  const signal = request.signal;
  signal?.throwIfAborted();
  const session = await client.createSession({
    title: TITLE_SESSION_TITLE,
    permission: [...TITLE_PERMISSION_RULES],
  });
  const onAbort = () => void client.abort(session.id).catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const result = await client.prompt(
      {
        sessionID: session.id,
        model: run.model,
        ...(run.variant !== undefined && { variant: run.variant }),
        system: request.instructions,
        format: { type: 'json_schema', schema: request.outputSchema },
        parts: [{ type: 'text', text: request.input }],
      },
      signal,
    );
    const info = result.info;
    if (info.role === 'assistant') reportUsage(info, request.onUsage);
    const structured = info.role === 'assistant' ? info.structured : undefined;
    if (structured !== undefined && structured !== null) return JSON.stringify(structured);
    const text = textResponse(result.parts);
    const failure = info.role === 'assistant' ? promptFailure(info.error) : undefined;
    // 模型没调 StructuredOutput 而是直接写了文本（opencode 记一个 StructuredOutputError）：文本可能就是那段 JSON。
    if (failure !== undefined && (failure.name !== 'StructuredOutputError' || text === '')) {
      throw new Error(
        failure.name === undefined ? failure.message : `${failure.name}: ${failure.message}`,
      );
    }
    if (text === '') {
      throw new Error(`OpenCode returned empty output (${result.parts.length} response parts)`);
    }
    return text;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await client.deleteSession(session.id).catch((error: unknown) => {
      run.warn?.('could not delete the OpenCode title session', {
        engineSessionId: session.id,
        error: errorMessage(error),
      });
    });
  }
}

/**
 * 标题请求的用量：opencode 的 `tokens.input` 已经减掉缓存的读写、`output` 减掉了推理（mapping.ts 的 `#record`），报给 Host 的
 * 输入含缓存、输出含推理。
 */
function reportUsage(
  info: Extract<Message, { role: 'assistant' }>,
  onUsage: TitleRequest['onUsage'],
): void {
  if (onUsage === undefined) return;
  const count = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  const tokens = info.tokens;
  const cacheRead = count(tokens.cache?.read);
  const cacheWrite = count(tokens.cache?.write);
  const reasoning = count(tokens.reasoning);
  const input = count(tokens.input) + cacheRead + cacheWrite;
  const output = count(tokens.output) + reasoning;
  if (input + output === 0) return;
  onUsage({
    inputTokens: input,
    outputTokens: output,
    ...(cacheRead > 0 && { cacheReadTokens: cacheRead }),
    ...(cacheWrite > 0 && { cacheWriteTokens: cacheWrite }),
    ...(reasoning > 0 && { reasoningTokens: reasoning }),
    ...(info.modelID !== '' && { model: info.modelID }),
    ...(info.providerID !== '' && { upstream: info.providerID }),
  });
}
