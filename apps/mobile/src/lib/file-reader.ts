// 完整文件：`files.read` 一块一块往下读（每块最多 512 KiB），按行攒给列表。块的边界可能切在一个 UTF-8 字符或一行的中间，
// 所以只解码到最后一个换行，余下的字节留给下一块。开头 8000 字节里有 NUL 的当二进制文件（同 git 的判断），不显示内容。

import type { FilesReadParams, FilesReadResult } from '@wevir/protocol';

/** 一块读多少字节：比上限小，经中继时一块的等待短一些。 */
export const FILE_CHUNK_BYTES = 256 * 1024;
/** 开头这么多字节里有 NUL 就当二进制文件。 */
const BINARY_SNIFF_BYTES = 8000;
/** 最多攒这么多行，再多就停（手机上看不完，也占内存）。 */
export const FILE_MAX_LINES = 50_000;

export type ReadChunk = (params: FilesReadParams) => Promise<FilesReadResult>;

export interface FileView {
  lines: readonly string[];
  /** 读到的字节数与读时的文件大小。 */
  loaded: number;
  size: number;
  eof: boolean;
  binary: boolean;
  /** 到了 `FILE_MAX_LINES`，后面不再读。 */
  capped: boolean;
  /** 分块读的过程中文件被改过（`mtimeMs` 变了）。 */
  changed: boolean;
}

export class ChunkedFile {
  readonly #read: ReadChunk;
  readonly #target: Pick<FilesReadParams, 'workspaceId' | 'sessionId' | 'path'>;
  readonly #decoder = new TextDecoder();
  #lines: string[] = [];
  #pending: Uint8Array = new Uint8Array(0);
  #offset = 0;
  #size = 0;
  #mtime: number | undefined;
  #eof = false;
  #binary = false;
  #capped = false;
  #changed = false;
  #reading: Promise<FileView> | undefined;

  constructor(
    read: ReadChunk,
    target: Pick<FilesReadParams, 'workspaceId' | 'sessionId' | 'path'>,
  ) {
    this.#read = read;
    this.#target = target;
  }

  get view(): FileView {
    return {
      lines: this.#lines,
      loaded: this.#offset,
      size: this.#size,
      eof: this.#eof,
      binary: this.#binary,
      capped: this.#capped,
      changed: this.#changed,
    };
  }

  get done(): boolean {
    return this.#eof || this.#binary || this.#capped;
  }

  /** 读下一块；正在读时返回同一次。 */
  next(): Promise<FileView> {
    if (this.done) return Promise.resolve(this.view);
    this.#reading ??= this.#readNext().finally(() => {
      this.#reading = undefined;
    });
    return this.#reading;
  }

  async #readNext(): Promise<FileView> {
    const result = await this.#read({
      ...this.#target,
      offset: this.#offset,
      length: FILE_CHUNK_BYTES,
    });
    const bytes = decodeBase64(result.data);
    if (result.offset < BINARY_SNIFF_BYTES) {
      if (bytes.subarray(0, BINARY_SNIFF_BYTES - result.offset).includes(0)) this.#binary = true;
    }
    if (this.#mtime !== undefined && result.mtimeMs !== this.#mtime) this.#changed = true;
    this.#mtime = result.mtimeMs;
    this.#size = result.size;
    this.#offset = result.offset + bytes.length;
    this.#eof = result.eof;
    if (this.#binary) this.#lines = [];
    else this.#append(bytes, result.eof);
    return this.view;
  }

  #append(bytes: Uint8Array, eof: boolean): void {
    const joined = new Uint8Array(this.#pending.length + bytes.length);
    joined.set(this.#pending);
    joined.set(bytes, this.#pending.length);
    const cut = eof ? joined.length : joined.lastIndexOf(0x0a) + 1;
    this.#pending = joined.slice(cut);
    if (cut === 0) return;
    let text = this.#decoder.decode(joined.subarray(0, cut));
    if (text.endsWith('\n')) text = text.slice(0, -1);
    // 以换行结尾的文件不多出一个空行。
    const lines = text.split('\n').map(stripCr);
    const room = FILE_MAX_LINES - this.#lines.length;
    if (lines.length > room) {
      lines.length = room;
      this.#capped = true;
    }
    this.#lines = this.#lines.concat(lines);
  }
}

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const LOOKUP = new Uint8Array(128).fill(255);
for (let i = 0; i < BASE64.length; i += 1) LOOKUP[BASE64.charCodeAt(i)] = i;

/** 标准 base64（带填充）解码；不依赖 `atob`（Hermes 不一定有）。 */
export function decodeBase64(input: string): Uint8Array {
  const clean = input.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const code = LOOKUP[clean.charCodeAt(i)] ?? 255;
    if (code === 255) throw new Error('invalid base64');
    value = ((value << 6) | code) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (value >> bits) & 0xff;
    }
  }
  return out.subarray(0, index);
}
