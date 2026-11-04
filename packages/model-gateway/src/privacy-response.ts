import { escapeRegex, mapJsonStrings, PrivacyMaskingError } from './privacy.js';
import { type SseMessage, SseParser } from './sse.js';
import { isObject } from './tools.js';
import type { ResponsesEvent } from './types.js';

/** JSON 中只跟踪引号、转义与 arguments 字符串的嵌套层，不保留值正文。 */
class JsonContext {
  #quoted = false;
  #escape = '';
  #name = '';
  #lastName: string | undefined;
  #field: string | undefined;
  #arguments: JsonContext | undefined;

  encode(value: string): string {
    if (!this.#quoted) return JSON.stringify(value);
    return JSON.stringify(this.#arguments?.encode(value) ?? value).slice(1, -1);
  }

  track(text: string): void {
    for (const char of text) {
      if (!this.#quoted) {
        if (char === '"') {
          this.#quoted = true;
          this.#name = '';
          this.#arguments = this.#field === 'arguments' ? new JsonContext() : undefined;
          this.#field = undefined;
        } else if (char === ':') {
          this.#field = this.#lastName;
          this.#lastName = undefined;
        } else if (!/\s/.test(char)) {
          this.#field = undefined;
          this.#lastName = undefined;
        }
      } else if (this.#escape !== '') {
        this.#escape += char;
        if ((this.#escape.length === 2 && char !== 'u') || this.#escape.length === 6) {
          let decoded: string;
          try {
            decoded = JSON.parse(`"${this.#escape}"`);
          } catch {
            throw new PrivacyMaskingError('隐私还原失败：上游 JSON 转义无效');
          }
          this.#character(decoded);
          this.#escape = '';
        }
      } else if (char === '\\') this.#escape = char;
      else if (char === '"') {
        this.#quoted = false;
        this.#lastName = this.#name;
        this.#arguments = undefined;
      } else this.#character(char);
    }
  }

  #character(char: string): void {
    if (this.#name.length < 10) this.#name += char;
    this.#arguments?.track(char);
  }
}

/** 每条文本/参数流各持有一个实例；只留下可能组成占位符的末尾。 */
export class SecretRestorer {
  readonly #values: ReadonlyMap<string, string>;
  readonly #tokens: string[];
  readonly #pattern: RegExp;
  readonly #json: JsonContext | undefined;
  readonly #longest: number;
  #pending = '';

  constructor(values: ReadonlyMap<string, string>, json = false) {
    this.#values = values;
    this.#tokens = [...values.keys()];
    this.#pattern = new RegExp(this.#tokens.map(escapeRegex).join('|'), 'g');
    this.#json = json ? new JsonContext() : undefined;
    this.#longest = this.#tokens.reduce((longest, token) => Math.max(longest, token.length), 0);
  }

  push(text: string): string {
    const input = this.#pending + text;
    let end = input.length;
    for (let start = Math.max(0, end - this.#longest + 1); start < end; start++) {
      if (input[start] !== '{') continue;
      const suffix = input.slice(start);
      if (this.#tokens.some((token) => token.length > suffix.length && token.startsWith(suffix))) {
        end = start;
        break;
      }
    }
    this.#pending = input.slice(end);
    const ready = input.slice(0, end);
    let offset = 0;
    let output = '';
    for (const match of ready.matchAll(this.#pattern)) {
      const literal = ready.slice(offset, match.index);
      output += literal;
      this.#json?.track(literal);
      const value = this.#values.get(match[0]) as string;
      output += this.#json?.encode(value) ?? value;
      this.#json?.track(match[0]);
      offset = match.index + match[0].length;
    }
    const rest = ready.slice(offset);
    this.#json?.track(rest);
    return output + rest;
  }

  end(): string {
    const rest = this.#pending;
    this.#pending = '';
    this.#json?.track(rest);
    return rest;
  }
}

class ResponseRestorer {
  readonly #values: ReadonlyMap<string, string>;
  readonly #streams = new Map<string, { restorer: SecretRestorer; event: ResponsesEvent }>();

  constructor(values: ReadonlyMap<string, string>) {
    this.#values = values;
  }

  restore(value: unknown): unknown {
    return mapJsonStrings(value, (text, key) => {
      const restorer = new SecretRestorer(this.#values, key === 'arguments');
      return restorer.push(text) + restorer.end();
    });
  }

  message(message: SseMessage): string {
    if (message.data.trim() === '[DONE]') return this.end() + encode(message);
    let event: unknown;
    try {
      event = JSON.parse(message.data);
    } catch {
      throw new PrivacyMaskingError('隐私还原失败：上游事件不是合法 JSON');
    }
    if (!isObject(event) || typeof event.type !== 'string')
      throw new PrivacyMaskingError('隐私还原失败：上游事件缺少类型');
    const type = event.type;
    let prefix = '';
    if (type === 'error' || /^response\.(completed|failed|incomplete)$/.test(type))
      prefix = this.end();
    else if (type.endsWith('.done')) {
      prefix = this.#flush((stream) => {
        const sameItem =
          event.item_id !== undefined && stream.item_id !== undefined
            ? event.item_id === stream.item_id
            : event.output_index === stream.output_index;
        return (
          sameItem &&
          (event.content_index === undefined || event.content_index === stream.content_index) &&
          (event.summary_index === undefined || event.summary_index === stream.summary_index) &&
          (type === stream.type.replace(/\.delta$/, '.done') ||
            /\.(output_item|content_part|reasoning_summary_part)\.done$/.test(type))
        );
      });
    }
    if (type.endsWith('.delta') && typeof event.delta === 'string') {
      const key = JSON.stringify([
        type,
        event.item_id ?? event.output_index,
        event.content_index,
        event.summary_index,
      ]);
      let state = this.#streams.get(key);
      const { delta, ...rest } = event;
      if (state === undefined) {
        state = {
          restorer: new SecretRestorer(this.#values, type.endsWith('_arguments.delta')),
          event: { ...rest, type },
        };
        this.#streams.set(key, state);
      }
      state.event = { ...rest, type };
      return (
        prefix +
        encode({
          ...message,
          data: JSON.stringify({
            ...(this.restore(rest) as object),
            delta: state.restorer.push(delta),
          }),
        })
      );
    }
    return prefix + encode({ ...message, data: JSON.stringify(this.restore(event)) });
  }

  end(): string {
    return this.#flush(() => true);
  }

  #flush(matches: (event: ResponsesEvent) => boolean): string {
    let out = '';
    for (const [key, state] of this.#streams) {
      if (!matches(state.event)) continue;
      const delta = state.restorer.end();
      if (delta !== '') {
        const { sequence_number: _sequence, ...event } = state.event;
        out += encode({ event: event.type as string, data: JSON.stringify({ ...event, delta }) });
      }
      this.#streams.delete(key);
    }
    return out;
  }
}

function encode(message: SseMessage): string {
  return `${message.event === undefined ? '' : `event: ${message.event}\n`}data: ${message.data}\n\n`;
}

export async function* restoreResponses(
  source: AsyncIterable<string | Uint8Array>,
  values: ReadonlyMap<string, string>,
  contentType: string,
): AsyncGenerator<string | Uint8Array> {
  if (values.size === 0) {
    yield* source;
    return;
  }
  const restorer = new ResponseRestorer(values);
  if (contentType.includes('application/json')) {
    const raw = new SecretRestorer(values, true);
    const decoder = new TextDecoder();
    for await (const piece of source) {
      yield raw.push(typeof piece === 'string' ? piece : decoder.decode(piece, { stream: true }));
    }
    yield raw.push(decoder.decode()) + raw.end();
    return;
  }
  const parser = new SseParser();
  for await (const piece of source) {
    for (const message of parser.push(piece)) yield restorer.message(message);
  }
  for (const message of parser.end()) yield restorer.message(message);
  const tail = restorer.end();
  if (tail !== '') yield tail;
}
