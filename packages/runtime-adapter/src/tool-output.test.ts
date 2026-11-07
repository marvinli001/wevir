import { describe, expect, it } from 'vitest';
import { ADAPTER_TOOL_OUTPUT_BYTES, boundedToolOutput, ToolOutputBuffer } from './tool-output.js';

describe('adapter tool output', () => {
  it('leaves small results unchanged, including split surrogate pairs', () => {
    const output = new ToolOutputBuffer();
    output.append('a\uD83D');
    output.append('\uDE00z');
    expect(output.snapshot()).toEqual({ output: 'a😀z' });
  });

  it('bounds cumulative output and retains the original head, latest tail and counts', () => {
    const output = new ToolOutputBuffer();
    const chunks = ['head\n', 'x'.repeat(ADAPTER_TOOL_OUTPUT_BYTES), 'last\n'];
    for (const chunk of chunks) output.append(chunk);
    const result = output.snapshot();
    expect(Buffer.byteLength(result.output)).toBe(ADAPTER_TOOL_OUTPUT_BYTES);
    expect(result.output.startsWith('head\n')).toBe(true);
    expect(result.output.endsWith('last\n')).toBe(true);
    expect(result.outputMeta).toEqual({
      truncated: true,
      totalBytes: Buffer.byteLength(chunks.join('')),
      originalLength: chunks.join('').length,
    });
    expect(boundedToolOutput(chunks.join(''))).toEqual(result);
  });

  it('cuts UTF-8 at character boundaries, keeping the same head after later appends', () => {
    const output = new ToolOutputBuffer();
    const text = '中😀'.repeat(400_000);
    output.append(text);
    const first = output.snapshot();
    output.append('tail😀');
    const last = output.snapshot();
    expect(Buffer.byteLength(last.output)).toBeLessThanOrEqual(ADAPTER_TOOL_OUTPUT_BYTES);
    expect(last.output).not.toContain('�');
    expect(last.output.slice(0, 10_000)).toBe(first.output.slice(0, 10_000));
    expect(last.output.endsWith('tail😀')).toBe(true);
    expect(last.outputMeta).toEqual({
      truncated: true,
      totalBytes: Buffer.byteLength(`${text}tail😀`),
      originalLength: text.length + 'tail😀'.length,
    });
  });
});
