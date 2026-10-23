// 只够 client-sdk 用的 `TextDecoder`：UTF-8，`fatal` 时遇到不合法的字节就抛 `TypeError`，否则换成 U+FFFD。Hermes 自带时不用它。

export class Utf8Decoder {
  readonly encoding = 'utf-8';
  readonly fatal: boolean;
  readonly ignoreBOM = false;

  constructor(label = 'utf-8', options: { fatal?: boolean } = {}) {
    if (!/^utf-?8$/i.test(label)) throw new RangeError(`unsupported encoding: ${label}`);
    this.fatal = options.fatal === true;
  }

  decode(input?: ArrayBuffer | ArrayBufferView): string {
    if (input === undefined) return '';
    const bytes =
      input instanceof Uint8Array
        ? input
        : ArrayBuffer.isView(input)
          ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
          : new Uint8Array(input);
    let out = '';
    let i = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
    const units: number[] = [];
    const flush = () => {
      out += String.fromCharCode(...units);
      units.length = 0;
    };
    while (i < bytes.length) {
      const point = this.#next(bytes, i);
      i = point.end;
      if (point.code > 0xffff) {
        const v = point.code - 0x10000;
        units.push(0xd800 + (v >> 10), 0xdc00 + (v & 0x3ff));
      } else {
        units.push(point.code);
      }
      if (units.length >= 4096) flush();
    }
    flush();
    return out;
  }

  /** 按 WHATWG Encoding 的 UTF-8 解码器：第二个字节的范围排除过长编码、代理区与超出 U+10FFFF 的码点。 */
  #next(bytes: Uint8Array, start: number): { code: number; end: number } {
    const first = bytes[start] as number;
    if (first < 0x80) return { code: first, end: start + 1 };
    let length: number;
    let lower = 0x80;
    let upper = 0xbf;
    if (first >= 0xc2 && first <= 0xdf) length = 2;
    else if (first >= 0xe0 && first <= 0xef) {
      length = 3;
      if (first === 0xe0) lower = 0xa0;
      if (first === 0xed) upper = 0x9f;
    } else if (first >= 0xf0 && first <= 0xf4) {
      length = 4;
      if (first === 0xf0) lower = 0x90;
      if (first === 0xf4) upper = 0x8f;
    } else return this.#invalid(start + 1);
    let code = first & (0xff >> (length + 1));
    for (let k = 1; k < length; k += 1) {
      const byte = bytes[start + k];
      const min = k === 1 ? lower : 0x80;
      const max = k === 1 ? upper : 0xbf;
      if (byte === undefined || byte < min || byte > max) return this.#invalid(start + k);
      code = (code << 6) | (byte & 0x3f);
    }
    return { code, end: start + length };
  }

  #invalid(end: number): { code: number; end: number } {
    if (this.fatal) throw new TypeError('The encoded data was not valid utf-8');
    return { code: 0xfffd, end };
  }
}
