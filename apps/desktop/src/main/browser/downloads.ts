// agent 要的下载（0.48.0，browser_download）：内置浏览器的下载默认一律拦下，只有 agent 用 browser_download 明确要的那一个存进
// 会话文件夹的 `downloads/`。这里是文件名、保存位置与等下载结束的部分；接住下载（`will-download`）在 browser-host.ts。

import { existsSync, rmSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { BROWSER_DOWNLOAD_MAX_BYTES } from '@wevir/protocol';

/** 保存在会话文件夹的哪个子目录。 */
export const DOWNLOADS_DIR = 'downloads';

/** Electron 的 DownloadItem 里用到的部分。 */
export interface DownloadItemLike {
  getURL(): string;
  getMimeType(): string;
  getReceivedBytes(): number;
  cancel(): void;
  on(event: 'updated', listener: () => void): void;
  removeListener(event: 'updated', listener: () => void): void;
  once(event: 'done', listener: (event: unknown, state: string) => void): void;
}

/** 网站建议的文件名只留最后一段、去掉控制字符与路径分隔符；空的叫 `download`。 */
export function downloadFilename(suggested: string): string {
  const cleaned = basename(suggested.replace(/\\/g, '/'))
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 去掉文件名里的控制字符
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 200);
  return cleaned === '' ? 'download' : cleaned;
}

/** 目录里不重名的路径：`report.csv`、`report (1).csv` …。 */
export function uniqueSavePath(
  dir: string,
  filename: string,
  exists: (path: string) => boolean = existsSync,
): string {
  const first = join(dir, filename);
  if (!exists(first)) return first;
  const extension = extname(filename);
  const stem = filename.slice(0, filename.length - extension.length);
  for (let index = 1; index < 1_000; index += 1) {
    const candidate = join(dir, `${stem} (${index})${extension}`);
    if (!exists(candidate)) return candidate;
  }
  return join(dir, `${stem} (${Date.now()})${extension}`);
}

/**
 * 等下载结束，最多 `waitMs`：`completed` / `cancelled` / `interrupted`，超过 `BROWSER_DOWNLOAD_MAX_BYTES` 的取消并删掉（`too_large`），
 * 到时还没完的是 `in_progress`（继续在下）。
 */
export function trackDownload(
  item: DownloadItemLike,
  path: string,
  waitMs: number,
  maxBytes = BROWSER_DOWNLOAD_MAX_BYTES,
): Promise<{ state: string; size: number }> {
  return new Promise((resolve) => {
    let tooLarge = false;
    let answered = false;
    const answer = (state: string) => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      resolve({ state, size: item.getReceivedBytes() });
    };
    // 到时限答了 in_progress 之后照样看着：超过上限还会取消，结束时清掉监听。
    const onUpdated = () => {
      if (!tooLarge && item.getReceivedBytes() > maxBytes) {
        tooLarge = true;
        item.cancel();
      }
    };
    item.on('updated', onUpdated);
    item.once('done', (_event, state) => {
      item.removeListener('updated', onUpdated);
      if (tooLarge) rmSync(path, { force: true });
      answer(tooLarge ? 'too_large' : state);
    });
    const timer = setTimeout(() => answer('in_progress'), waitMs);
  });
}
