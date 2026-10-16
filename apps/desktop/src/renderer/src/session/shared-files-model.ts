// Agent 交给用户的文件（0.40.0）：卡片上的大小、类型与绝对路径。纯逻辑。

import type { SharedFile } from '@wevir/protocol';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** 大小按 1000 进位（同访达），整数字节不带小数，其余最多一位小数。 */
export function formatFileSize(bytes: number, locale: string): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const number = new Intl.NumberFormat(locale, {
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value);
  return `${number} ${UNITS[unit]}`;
}

/** 类型标签：扩展名的大写（`DOCX`），没有扩展名时没有。 */
export function fileTypeLabel(name: string): string | undefined {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return undefined;
  return name.slice(dot + 1).toUpperCase();
}

/** 文件在本机的绝对路径：会话的 `cwd` 加上 `path`（`/` 分隔）。Windows 的 `cwd` 用反斜杠时接反斜杠。 */
export function sharedFilePath(cwd: string, file: Pick<SharedFile, 'path'>): string {
  const windows = /^[a-z]:\\/i.test(cwd) || cwd.startsWith('\\\\');
  const separator = windows ? '\\' : '/';
  const relative = windows ? file.path.replaceAll('/', '\\') : file.path;
  return cwd.endsWith(separator) ? `${cwd}${relative}` : `${cwd}${separator}${relative}`;
}
