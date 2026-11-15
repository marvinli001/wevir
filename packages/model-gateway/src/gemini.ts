import { toChatRequest } from './chat/request.js';
import { ChatStreamTranslator } from './chat/response.js';
import { isObject, type ToolNames } from './tools.js';
import type {
  ChatContentPart,
  GatewayProvider,
  JsonObject,
  ResponsesEvent,
  ResponsesRequest,
} from './types.js';

/** Reuse the gateway's tool names and history envelopes for native generateContent. */
export function toGeminiRequest(body: ResponsesRequest, provider: GatewayProvider) {
  const chat = toChatRequest(body, {
    ...provider,
    compat: { ...provider.compat, systemMessageMode: 'merge' },
  });
  const contents: JsonObject[] = [];
  const system: JsonObject[] = [];
  const callNames = new Map<string, string>();
  for (const message of chat.request.messages) {
    if (message.role === 'system' || message.role === 'developer') {
      if (typeof message.content === 'string') system.push({ text: message.content });
      continue;
    }
    const parts: JsonObject[] =
      typeof message.content === 'string'
        ? message.content === ''
          ? []
          : [{ text: message.content }]
        : (message.content ?? []).map(contentPart);
    for (const call of message.tool_calls ?? []) {
      callNames.set(call.id, call.function.name);
      const google = call.extra_content?.google;
      let args: unknown;
      try {
        args = JSON.parse(call.function.arguments);
      } catch {
        return {
          ok: false as const,
          message: 'Gemini tool history contains invalid JSON arguments',
        };
      }
      if (!isObject(args))
        return { ok: false as const, message: 'Gemini tool arguments must be a JSON object' };
      parts.push({
        functionCall: {
          id: call.id,
          name: call.function.name,
          args,
        },
        ...(isObject(google) &&
          typeof google.thought_signature === 'string' && {
            thoughtSignature: google.thought_signature,
          }),
      });
    }
    if (message.role === 'tool') {
      const id = message.tool_call_id ?? '';
      const name = callNames.get(id);
      if (name === undefined)
        return { ok: false as const, message: 'Gemini tool result has no matching function call' };
      parts.splice(0, parts.length, {
        functionResponse: {
          id,
          name,
          response: { result: message.content },
        },
      });
    }
    if (parts.length === 0) continue;
    const role = message.role === 'assistant' ? 'model' : 'user';
    const last = contents.at(-1);
    if (last?.role === role && Array.isArray(last.parts)) last.parts.push(...parts);
    else contents.push({ role, parts });
  }
  const request: JsonObject = { contents };
  if (system.length > 0) request.systemInstruction = { parts: system };
  if (chat.request.tools?.length) {
    request.tools = [
      {
        functionDeclarations: chat.request.tools.map(({ function: tool }) => ({
          name: tool.name,
          ...(tool.description !== undefined && { description: tool.description }),
          parametersJsonSchema: tool.parameters,
        })),
      },
    ];
    const choice = chat.request.tool_choice;
    request.toolConfig = {
      functionCallingConfig: {
        mode: choice === 'none' ? 'NONE' : choice === 'required' ? 'ANY' : 'AUTO',
        ...(isObject(choice) &&
          isObject(choice.function) && {
            mode: 'ANY',
            allowedFunctionNames: [choice.function.name],
          }),
      },
    };
  }
  const generation: JsonObject = {};
  for (const [from, to] of [
    ['max_output_tokens', 'maxOutputTokens'],
    ['temperature', 'temperature'],
    ['top_p', 'topP'],
  ] as const) {
    if (typeof body[from] === 'number') generation[to] = body[from];
  }
  const format = chat.request.response_format;
  if (isObject(format)) {
    generation.responseMimeType = 'application/json';
    if (isObject(format.json_schema)) generation.responseJsonSchema = format.json_schema.schema;
  }
  if (Object.keys(generation).length > 0) request.generationConfig = generation;
  return { ok: true as const, request, names: chat.names };
}

function contentPart(part: ChatContentPart): JsonObject {
  if (part.type === 'text') return { text: part.text };
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(part.image_url.url);
  return match
    ? { inlineData: { mimeType: match[1], data: match[2] } }
    : { fileData: { fileUri: part.image_url.url } };
}

export class GeminiStreamTranslator extends ChatStreamTranslator {
  #callIndex = 0;

  constructor(names: ToolNames, origin: { provider: string; model: string }) {
    super(names, { signatures: origin });
  }

  override data(data: string): ResponsesEvent[] {
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      return this.fail({
        message: 'Gemini returned invalid JSON',
        code: 'upstream_protocol_error',
      });
    }
    return this.whole(value);
  }

  override whole(value: unknown): ResponsesEvent[] {
    if (!isObject(value)) return [];
    if (isObject(value.error)) return super.chunk(value);
    const candidate = Array.isArray(value.candidates) ? value.candidates[0] : undefined;
    const delta: JsonObject = {};
    if (
      isObject(candidate) &&
      isObject(candidate.content) &&
      Array.isArray(candidate.content.parts)
    ) {
      for (const part of candidate.content.parts as unknown[]) {
        if (!isObject(part)) continue;
        if (typeof part.text === 'string') {
          const field = part.thought === true ? 'reasoning_content' : 'content';
          delta[field] = String(delta[field] ?? '') + part.text;
        }
        if (isObject(part.functionCall)) {
          const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
          const index = this.#callIndex++;
          calls.push({
            index,
            id:
              typeof part.functionCall.id === 'string'
                ? part.functionCall.id
                : `${this.responseId}_call_${index}`,
            type: 'function',
            function: {
              name: part.functionCall.name,
              arguments: JSON.stringify(part.functionCall.args ?? {}),
            },
            ...(typeof part.thoughtSignature === 'string' && {
              extra_content: { google: { thought_signature: part.thoughtSignature } },
            }),
          });
          delta.tool_calls = calls;
        }
      }
    }
    const finish = isObject(candidate) ? candidate.finishReason : undefined;
    const blocked =
      isObject(value.promptFeedback) && value.promptFeedback.blockReason !== undefined;
    const usage = isObject(value.usageMetadata) ? value.usageMetadata : undefined;
    return super.chunk({
      choices: [
        {
          delta,
          ...(typeof finish === 'string' || blocked
            ? {
                finish_reason:
                  blocked || (finish !== 'STOP' && finish !== 'MAX_TOKENS')
                    ? 'content_filter'
                    : finish === 'MAX_TOKENS'
                      ? 'length'
                      : 'stop',
              }
            : {}),
        },
      ],
      ...(usage && {
        usage: {
          prompt_tokens: usage.promptTokenCount ?? 0,
          completion_tokens:
            Number(usage.candidatesTokenCount ?? 0) + Number(usage.thoughtsTokenCount ?? 0),
          total_tokens: usage.totalTokenCount ?? 0,
          prompt_tokens_details: { cached_tokens: usage.cachedContentTokenCount ?? 0 },
          completion_tokens_details: { reasoning_tokens: usage.thoughtsTokenCount ?? 0 },
        },
      }),
    });
  }
}
