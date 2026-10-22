// 分块读文件（0.102.0，host-api.md §3.1 的 `files.read`，domain-model §3.45）：远程客户端读工作区文件只走 JSON-RPC，`GET /files/…`
// 只服务本机。路径规则与“realpath 之后仍在目录里”由调用方（host-methods 的 resolveWorkspaceFile，同 `workspace.fileUrl`）先查过，
// 这里只按偏移读一块。

import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import {
  FILES_READ_CHUNK_MAX_BYTES,
  FILES_READ_FILE_MAX_BYTES,
  type FilesReadResult,
} from '@wevir/protocol';
import { fileMimeType } from './file-urls.js';

/** `files.read` 拒绝读的原因（host-methods 把它换成 `INVALID_PARAMS`）。 */
export class FileReadRejected extends Error {}

/**
 * 从 `real`（已核对过的 realpath）的 `offset` 起读最多 `length` 个字节。文件超过 `FILES_READ_FILE_MAX_BYTES`、`offset` 超过文件大小、
 * 打开时已不是普通文件（被换成了符号链接或目录）都拒绝。`size` 与 `mtimeMs` 取打开之后的这个文件。
 */
export async function readFileChunk(
  real: string,
  path: string,
  offset = 0,
  length = FILES_READ_CHUNK_MAX_BYTES,
): Promise<FilesReadResult> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    // 核对之后最后一段被换成符号链接时不跟过去（Windows 没有 O_NOFOLLOW）。
    handle = await open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new FileReadRejected('path is not an existing file inside the directory');
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new FileReadRejected('path is not an existing file inside the directory');
    }
    if (info.size > FILES_READ_FILE_MAX_BYTES) {
      throw new FileReadRejected(
        `file is ${info.size} bytes, larger than the ${FILES_READ_FILE_MAX_BYTES}-byte limit`,
      );
    }
    if (offset > info.size) {
      throw new FileReadRejected(
        `offset ${offset} is past the end of the file (${info.size} bytes)`,
      );
    }
    const want = Math.min(length, FILES_READ_CHUNK_MAX_BYTES, info.size - offset);
    const buffer = Buffer.alloc(want);
    let read = 0;
    while (read < want) {
      const { bytesRead } = await handle.read(buffer, read, want - read, offset + read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return {
      path,
      data: buffer.subarray(0, read).toString('base64'),
      mime: fileMimeType(path),
      size: info.size,
      offset,
      eof: offset + read >= info.size,
      mtimeMs: info.mtimeMs,
    };
  } finally {
    await handle.close();
  }
}
