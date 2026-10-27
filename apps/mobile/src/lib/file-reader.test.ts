import type { FilesReadParams, FilesReadResult, SessionId } from '@wevir/protocol';
import { describe, expect, it, vi } from 'vitest';
import { ChunkedFile, decodeBase64, FILE_CHUNK_BYTES } from './file-reader';

const SES = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR' as SessionId;

/** 假的 `files.read`：按 `offset` / `length` 切一份字节，每次可以换修改时间。 */
function fakeRead(bytes: Uint8Array, chunk: number, mtimes: number[] = [1]) {
  let call = 0;
  return vi.fn(async (params: FilesReadParams): Promise<FilesReadResult> => {
    const offset = params.offset ?? 0;
    const end = Math.min(bytes.length, offset + Math.min(chunk, params.length ?? chunk));
    const mtimeMs = mtimes[Math.min(call, mtimes.length - 1)] as number;
    call += 1;
    return {
      path: params.path,
      data: Buffer.from(bytes.subarray(offset, end)).toString('base64'),
      mime: 'text/plain',
      size: bytes.length,
      offset,
      eof: end >= bytes.length,
      mtimeMs,
    };
  });
}

async function readAll(file: ChunkedFile) {
  while (!file.done) await file.next();
  return file.view;
}

describe('decodeBase64', () => {
  it('decodes padded and unpadded input like Buffer', () => {
    for (const text of ['', 'a', 'ab', 'abc', 'abcd', '文件\n\u0000ÿ']) {
      const encoded = Buffer.from(text).toString('base64');
      expect(Buffer.from(decodeBase64(encoded)).toString()).toBe(text);
    }
    expect(() => decodeBase64('a$==')).toThrow();
  });
});

describe('ChunkedFile', () => {
  it('reads in chunks, splitting lines and multi-byte characters across chunk edges', async () => {
    const text = 'line 一\nline 二\r\nline 三 with more text\nlast';
    const bytes = new TextEncoder().encode(text);
    // 5 字节一块：中文字符（3 字节）与换行都会被切开。
    const read = fakeRead(bytes, 5);
    const file = new ChunkedFile(read, { sessionId: SES, path: 'a.txt' });
    const first = await file.next();
    expect(first.lines).toEqual([]);
    expect(first.eof).toBe(false);
    const view = await readAll(file);
    expect(view.lines).toEqual(['line 一', 'line 二', 'line 三 with more text', 'last']);
    expect(view.loaded).toBe(bytes.length);
    expect(view.size).toBe(bytes.length);
    expect(read.mock.calls[0]?.[0]).toEqual({
      sessionId: SES,
      path: 'a.txt',
      offset: 0,
      length: FILE_CHUNK_BYTES,
    });
    expect(read.mock.calls[1]?.[0].offset).toBe(5);
  });

  it('does not add an empty line for a trailing newline, and has none for an empty file', async () => {
    const trailing = new ChunkedFile(fakeRead(new TextEncoder().encode('a\nb\n'), 1024), {
      sessionId: SES,
      path: 'a',
    });
    expect((await readAll(trailing)).lines).toEqual(['a', 'b']);
    const empty = new ChunkedFile(fakeRead(new Uint8Array(0), 1024), { sessionId: SES, path: 'e' });
    const view = await readAll(empty);
    expect(view.lines).toEqual([]);
    expect(view.eof).toBe(true);
  });

  it('stops at a NUL byte near the start (binary)', async () => {
    const read = fakeRead(Uint8Array.from([0x41, 0x0a, 0x89, 0x00, 0x47, 0x0a, 0x41]), 3);
    const file = new ChunkedFile(read, { sessionId: SES, path: 'logo.png' });
    expect((await file.next()).lines).toEqual(['A']);
    const view = await file.next();
    expect(view.binary).toBe(true);
    expect(view.lines).toEqual([]);
    expect(file.done).toBe(true);
    await file.next();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('notices the file changing between chunks', async () => {
    const read = fakeRead(new TextEncoder().encode('one\ntwo\nthree\n'), 4, [1, 2]);
    const file = new ChunkedFile(read, { sessionId: SES, path: 'a' });
    expect((await file.next()).changed).toBe(false);
    expect((await file.next()).changed).toBe(true);
  });

  it('shares one request when next() is called while reading', async () => {
    const read = fakeRead(new TextEncoder().encode('a\nb\n'), 2);
    const file = new ChunkedFile(read, { sessionId: SES, path: 'a' });
    const [one, two] = await Promise.all([file.next(), file.next()]);
    expect(one).toEqual(two);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('passes errors through and can try again', async () => {
    const read = vi
      .fn<(params: FilesReadParams) => Promise<FilesReadResult>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(fakeRead(new TextEncoder().encode('x'), 8));
    const file = new ChunkedFile(read, { sessionId: SES, path: 'a' });
    await expect(file.next()).rejects.toThrow('offline');
    expect((await file.next()).lines).toEqual(['x']);
  });
});
