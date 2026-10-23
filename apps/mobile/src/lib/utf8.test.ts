import { describe, expect, it } from 'vitest';
import { Utf8Decoder } from './utf8';

const encode = (text: string) => new TextEncoder().encode(text);

describe('Utf8Decoder', () => {
  it('decodes like the platform TextDecoder', () => {
    for (const text of ['', 'hello', '会话列表', '😀 émoji ✓', 'a'.repeat(10_000)]) {
      expect(new Utf8Decoder('utf-8', { fatal: true }).decode(encode(text))).toBe(text);
    }
  });

  it('throws on invalid bytes when fatal, replaces them otherwise', () => {
    const bad = Uint8Array.of(0x61, 0xc3, 0x28, 0xed, 0xa0, 0x80, 0xf8);
    expect(() => new Utf8Decoder('utf-8', { fatal: true }).decode(bad)).toThrow(TypeError);
    expect(new Utf8Decoder().decode(bad)).toBe(new TextDecoder().decode(bad));
  });

  it('skips a leading BOM and decodes views into a larger buffer', () => {
    const bytes = Uint8Array.of(0xef, 0xbb, 0xbf, ...encode('ok'));
    expect(new Utf8Decoder().decode(bytes)).toBe('ok');
    const view = new DataView(encode('xyz').buffer, 1, 2);
    expect(new Utf8Decoder().decode(view)).toBe('yz');
  });
});
