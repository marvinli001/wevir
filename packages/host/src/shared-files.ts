// Agent 交给用户的文件（0.40.0，`wevir_share_file`，domain-model §3.15.2）：只认会话文件夹里的普通文件，记相对路径、显示名、
// 交出时的大小与按扩展名推断的类型。

import { realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { SharedFile } from '@wevir/protocol';

/** 按扩展名推断的类型；认不出的不写。 */
const MIME_TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.tsv': 'text/tab-separated-values',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.yaml': 'application/yaml',
  '.yml': 'application/yaml',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.rtf': 'application/rtf',
  '.epub': 'application/epub+zip',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.7z': 'application/x-7z-compressed',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

export function sharedMimeType(path: string): string | undefined {
  return MIME_TYPES[extname(path).toLowerCase()];
}

/** 交不出的原因，原样给 agent 看。 */
export class SharedFileError extends Error {}

/**
 * 会话文件夹里的一个文件 → `SharedFile`。`path` 可以是绝对路径或相对 `cwd`；按 realpath 判断在不在文件夹里（指到外面的符号
 * 链接不认），要是普通文件。
 */
export async function describeSharedFile(cwd: string, path: string): Promise<SharedFile> {
  const root = await realpath(cwd);
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  let real: string;
  try {
    real = await realpath(absolute);
  } catch {
    throw new SharedFileError(`${path} does not exist in this session's folder (${cwd}).`);
  }
  const rel = relative(root, real);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new SharedFileError(
      `${path} is not inside this session's folder (${cwd}). Save or copy it there first.`,
    );
  }
  const info = await stat(real);
  if (!info.isFile()) throw new SharedFileError(`${path} is not a file.`);
  const mimeType = sharedMimeType(real);
  return {
    path: rel.split(sep).join('/'),
    name: basename(real),
    size: info.size,
    ...(mimeType !== undefined && { mimeType }),
  };
}
