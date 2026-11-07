import type { AgentToolOutputMeta } from './events.js';

export const ADAPTER_TOOL_OUTPUT_BYTES = 2 * 1024 * 1024;
export const ADAPTER_TOOL_OUTPUT_HEAD_BYTES = 32 * 1024;

/** Display copies only; the engine's tool result is unchanged. */
export class ToolOutputBuffer {
  #text = '';
  #bytes = 0;
  #originalLength = 0;
  #retainedBytes = 0;
  #truncated = false;
  #head: string | undefined;
  #headBytes = 0;

  append(text: string): void {
    let bytes = Buffer.byteLength(text);
    // JSON deltas can split a UTF-16 surrogate pair.
    if (/[\uD800-\uDBFF]$/.test(this.#text) && /^[\uDC00-\uDFFF]/.test(text)) bytes -= 2;
    this.#bytes += bytes;
    this.#originalLength += text.length;
    this.#retainedBytes += bytes;
    this.#text += text;
    if (this.#retainedBytes <= ADAPTER_TOOL_OUTPUT_BYTES) return;
    if (this.#head === undefined) {
      const end = byteOffset(this.#text, ADAPTER_TOOL_OUTPUT_HEAD_BYTES, false);
      this.#head = copy(this.#text.slice(0, end.index));
      this.#headBytes = end.bytes;
    }
    const start = byteOffset(
      this.#text,
      this.#retainedBytes - ADAPTER_TOOL_OUTPUT_BYTES + this.#headBytes,
      true,
    );
    let tail = this.#text.slice(start.index);
    // A final engine result may be huge; don't retain its backing string through a slice.
    if (this.#retainedBytes > 2 * ADAPTER_TOOL_OUTPUT_BYTES) tail = copy(tail);
    this.#text = this.#head + tail;
    this.#retainedBytes = this.#headBytes + this.#retainedBytes - start.bytes;
    this.#truncated = true;
  }

  snapshot(): { output: string; outputMeta?: AgentToolOutputMeta } {
    return {
      output: this.#text,
      ...(this.#truncated && {
        outputMeta: {
          truncated: true as const,
          totalBytes: this.#bytes,
          originalLength: this.#originalLength,
        },
      }),
    };
  }
}

export function boundedToolOutput(text: string): ReturnType<ToolOutputBuffer['snapshot']> {
  const buffer = new ToolOutputBuffer();
  buffer.append(text);
  return buffer.snapshot();
}

function byteOffset(
  text: string,
  limit: number,
  roundUp: boolean,
): { index: number; bytes: number } {
  let index = 0;
  let bytes = 0;
  while (index < text.length && bytes < limit) {
    const point = text.codePointAt(index) as number;
    const size = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    if (!roundUp && bytes + size > limit) break;
    bytes += size;
    index += point > 0xffff ? 2 : 1;
  }
  return { index, bytes };
}

function copy(text: string): string {
  return Buffer.from(text, 'utf16le').toString('utf16le');
}
