import { isObject } from './tools.js';
import type { ResponsesEvent, ResponsesItem, ResponsesRequest } from './types.js';

const PREFIX = 'wevir-gw:zuv-replay:v1:';
type Origin = { provider: string; model: string; content: string };

function decode(value: unknown): Origin | undefined {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return;
  try {
    const origin: unknown = JSON.parse(
      Buffer.from(value.slice(PREFIX.length), 'base64').toString('utf8'),
    );
    if (
      isObject(origin) &&
      typeof origin.provider === 'string' &&
      typeof origin.model === 'string' &&
      typeof origin.content === 'string'
    )
      return origin as Origin;
  } catch {
    return;
  }
}

/** Codex retains encrypted_content across model changes; ZUV must only receive the issuing model's state. */
export function zuvReplay(provider: string, request: ResponsesRequest) {
  const input = Array.isArray(request.input)
    ? request.input.flatMap((item) => {
        const origin = item.type === 'reasoning' ? decode(item.encrypted_content) : undefined;
        if (origin === undefined) return [item];
        return origin.provider === provider && origin.model === request.model
          ? [{ ...item, encrypted_content: origin.content }]
          : [];
      })
    : request.input;
  const wrap = (item: ResponsesItem): ResponsesItem => {
    if (
      item.type !== 'reasoning' ||
      typeof item.encrypted_content !== 'string' ||
      item.encrypted_content === ''
    )
      return item;
    const origin: Origin = { provider, model: request.model, content: item.encrypted_content };
    return {
      ...item,
      encrypted_content: PREFIX + Buffer.from(JSON.stringify(origin)).toString('base64'),
    };
  };
  const rewrite = (event: ResponsesEvent): ResponsesEvent => {
    if (isObject(event.item)) return { ...event, item: wrap(event.item as ResponsesItem) };
    if (isObject(event.response) && Array.isArray(event.response.output))
      return {
        ...event,
        response: {
          ...event.response,
          output: (event.response.output as ResponsesItem[]).map(wrap),
        },
      };
    return event;
  };
  return { body: { ...request, input }, rewrite };
}
