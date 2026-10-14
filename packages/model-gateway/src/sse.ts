// 最小的 SSE 解析与写出。上游的流（Chat Completions 与 Responses）都是 `data:` 行，事件之间空一行。
// 解析按 WHATWG 的规则：`data:` 后的一个空格去掉，同一事件的多行 data 用换行拼接，`:` 开头是注释，
// 兼容 CRLF；`event:` 记下但网关不依赖它（Codex 也只看 data 里 JSON 的 type，codex-api/src/sse/responses.rs）。

import type { ResponsesEvent } from './types.js';

export interface SseMessage {
  event?: string;
  data: string;
}

export class SseParser {
  #buffer = '';
  #data: string[] = [];
  #event: string | undefined;
  readonly #decoder = new TextDecoder();

  /** 喂一段字节，返回其中完整的事件。 */
  push(chunk: Uint8Array | string): SseMessage[] {
    this.#buffer +=
      typeof chunk === 'string' ? chunk : this.#decoder.decode(chunk, { stream: true });
    const out: SseMessage[] = [];
    for (;;) {
      const newline = this.#buffer.indexOf('\n');
      if (newline < 0) break;
      let line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.#line(line, out);
    }
    return out;
  }

  /** 流结束：没有以空行收尾的最后一个事件也交出去。 */
  end(): SseMessage[] {
    const out: SseMessage[] = [];
    const rest = this.#buffer + this.#decoder.decode();
    this.#buffer = '';
    if (rest !== '') this.#line(rest.endsWith('\r') ? rest.slice(0, -1) : rest, out);
    this.#line('', out);
    return out;
  }

  #line(line: string, out: SseMessage[]): void {
    if (line === '') {
      if (this.#data.length > 0) {
        out.push({
          ...(this.#event === undefined ? {} : { event: this.#event }),
          data: this.#data.join('\n'),
        });
      }
      this.#data = [];
      this.#event = undefined;
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.#data.push(value);
    else if (field === 'event') this.#event = value;
  }
}

/** 一个 Responses 事件的 SSE 文本：带 `event:` 行，与 OpenAI 的格式一致。 */
export function sseEvent(event: ResponsesEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
