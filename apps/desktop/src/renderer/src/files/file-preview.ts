// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/shared/src/filePreview.ts、packages/shared/src/video.ts
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：只留文件窗格用到的分类（filePreviewKind 与媒体类型），去掉附件与 Markdown 链接的部分；filePaneView 与 Office 的分类是
// Wevir 的。
//
// 文件窗格（0.32.0，desktop-layout.md §19）按文件名决定怎么显示。纯逻辑。

import { OFFICE_PDF_EXTENSIONS } from '@wevir/protocol';

const GENERIC_MIME_TYPES = new Set([
  'application/octet-stream',
  'binary/octet-stream',
  'application/unknown',
]);

export type FilePreviewKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'html'
  | 'markdown'
  | 'text'
  | 'unsupported';

/** Content classification is identical for captured attachments and workspace references. */
export function filePreviewKind(file: {
  readonly name: string;
  readonly mimeType?: string;
}): FilePreviewKind {
  const mime = file.mimeType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const name = file.name.toLowerCase();
  const extension = name.slice(name.lastIndexOf('.'));
  const generic = !mime || mime === 'application/octet-stream' || mime === 'text/plain';
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'text/html') return 'html';
  if (mime === 'text/markdown' || mime === 'text/x-markdown') return 'markdown';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (generic) {
    if (extension === '.pdf') return 'pdf';
    if (/^\.html?$/.test(extension)) return 'html';
    if (/^\.(md|markdown|mdown|mkd|mdx)$/.test(extension)) return 'markdown';
    const media = mediaMimeTypeFromExtension(extension);
    if (media?.startsWith('image/')) return 'image';
    if (media?.startsWith('video/')) return 'video';
    if (audioMimeTypeFromExtension(extension) !== null) return 'audio';
    if (
      /^\.(txt|log|json|jsonc|jsonl|ndjson|yaml|yml|toml|ini|conf|config|env|csv|tsv|xml|css|scss|sass|less|js|jsx|mjs|cjs|ts|tsx|mts|cts|py|pyi|rb|go|rs|swift|kt|kts|java|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|sql|graphql|gql|vue|svelte|r|lua|ex|exs|erl|hs|clj|dart|diff|patch|lock|properties|gradle)$/.test(
        extension,
      ) ||
      /^(dockerfile|makefile|gemfile|rakefile|license|readme|\.gitignore|\.gitattributes|\.editorconfig|\.env)(\.|$)/i.test(
        name.split(/[\\/]/).at(-1) ?? '',
      )
    )
      return 'text';
  }
  if (
    mime.startsWith('text/') ||
    /^(application\/(json|.*\+json|xml|.*\+xml|javascript|x-javascript|yaml|x-yaml|toml|sql))$/.test(
      mime,
    )
  )
    return 'text';
  return 'unsupported';
}

const IMAGE_MIME_TYPE_BY_EXTENSION = new Map([
  ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
]);

const AUDIO_MIME_TYPE_BY_EXTENSION = new Map([
  ['.mp3', 'audio/mpeg'],
  ['.wav', 'audio/wav'],
  ['.ogg', 'audio/ogg'],
  ['.oga', 'audio/ogg'],
  ['.flac', 'audio/flac'],
  ['.aac', 'audio/aac'],
  ['.m4a', 'audio/mp4'],
  ['.opus', 'audio/ogg'],
  ['.aiff', 'audio/aiff'],
]);

const VIDEO_MIME_TYPE_BY_EXTENSION = new Map([
  ['avi', 'video/x-msvideo'],
  ['m4v', 'video/mp4'],
  ['mkv', 'video/x-matroska'],
  ['mov', 'video/quicktime'],
  ['mp4', 'video/mp4'],
  ['ogv', 'video/ogg'],
  ['webm', 'video/webm'],
]);

/** Recognizes videos even when the file picker omitted their MIME type. */
export function videoMimeType(attachment: {
  readonly name: string;
  readonly mimeType: string;
}): string | null {
  const mimeType = attachment.mimeType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (mimeType.startsWith('video/')) return mimeType;
  // The name is only evidence when nothing recorded what this is. A definite type already
  // answers the question, and a `.mp4` on a PDF must not override it.
  if (mimeType !== '' && !GENERIC_MIME_TYPES.has(mimeType)) return null;
  const dotIndex = attachment.name.lastIndexOf('.');
  return dotIndex < 0
    ? null
    : (VIDEO_MIME_TYPE_BY_EXTENSION.get(attachment.name.slice(dotIndex + 1).toLowerCase()) ?? null);
}

/** Audio a player can request inline; the server serves these with byte ranges like video. */
export function audioMimeTypeFromExtension(extension: string): string | null {
  if (!/^\.[a-z0-9]+$/i.test(extension)) return null;
  return AUDIO_MIME_TYPE_BY_EXTENSION.get(extension.toLowerCase()) ?? null;
}

/** Classifies a literal filesystem extension, without URL decoding or suffix removal. */
export function mediaMimeTypeFromExtension(extension: string): string | null {
  if (!/^\.[a-z0-9]+$/i.test(extension)) return null;
  return (
    IMAGE_MIME_TYPE_BY_EXTENSION.get(extension.toLowerCase()) ??
    videoMimeType({ name: `media${extension}`, mimeType: '' })
  );
}

/** Office 文件里能在窗格里显示的三种（OpenWork 的 officeKindFromMimeOrFilename），其余的交给系统预览。 */
export type OfficeKind = 'docx' | 'pptx' | 'xlsx';

/** 窗格里看不了、只能交给系统预览（macOS 的 Quick Look）或默认应用的文档。 */
const OTHER_DOCUMENT_EXTENSIONS = new Set([
  'doc',
  'xls',
  'ppt',
  'odt',
  'ods',
  'odp',
  'rtf',
  'key',
  'numbers',
  'pages',
]);

function extensionOf(path: string): string {
  const name = (path.split('/').pop() ?? '').toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1) : '';
}

/**
 * 文件窗格的显示方式：
 * - `image` / `video` / `audio` / `pdf` / `html`：从 Host 的流式地址加载（`workspace.fileUrl`，0.32.0）；
 * - `table`：CSV / TSV，可切换为源码；`markdown`：可切换渲染与源码；
 * - `spreadsheet`：xlsx 的表格；`document`：docx / pptx 抽出的文字；`office`：只能交给系统预览或默认应用；
 * - `text`：文本（未知的扩展名也先当文本读，Host 判断是不是二进制）。
 */
export type FilePaneView =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'html'
  | 'markdown'
  | 'table'
  | 'spreadsheet'
  | 'document'
  | 'office'
  | 'text';

export function filePaneView(path: string): FilePaneView {
  const extension = extensionOf(path);
  if (extension === 'xlsx') return 'spreadsheet';
  if (extension === 'docx' || extension === 'pptx') return 'document';
  if (OTHER_DOCUMENT_EXTENSIONS.has(extension)) return 'office';
  if (extension === 'csv' || extension === 'tsv') return 'table';
  const kind = filePreviewKind({ name: path });
  if (kind === 'unsupported') return 'text';
  return kind;
}

const OFFICE_PDF = new Set<string>(OFFICE_PDF_EXTENSIONS);

/** 预览引擎（0.138.0，`workspace.officePdf`）能转成 PDF 的办公文档：Word、Excel、PowerPoint 与 OpenDocument。 */
export function officePdfConvertible(path: string): boolean {
  return OFFICE_PDF.has(extensionOf(path));
}

/** 这几种由 Host 的流式地址加载，不读文本。 */
export function isStreamedView(view: FilePaneView): boolean {
  return (
    view === 'image' ||
    view === 'video' ||
    view === 'audio' ||
    view === 'pdf' ||
    view === 'spreadsheet' ||
    view === 'document' ||
    view === 'office'
  );
}
