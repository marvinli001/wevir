// 文件窗格（0.32.0）交给系统打开的文件：Quick Look 与默认应用只认文档与媒体，不打开可执行文件、脚本与应用包（`.app`、
// `.command`、`.exe` 等经 `shell.openPath` 会直接运行）。渲染进程与主进程共用，主进程按它校验。纯逻辑。

const DOCUMENT_EXTENSIONS = new Set([
  // Office 与 iWork、OpenDocument、RTF
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'odp',
  'rtf',
  'pages',
  'numbers',
  'key',
  // PDF、表格与文本
  'pdf',
  'csv',
  'tsv',
  'txt',
  'md',
  'markdown',
  // 图片
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'avif',
  'bmp',
  'ico',
  'svg',
  'heic',
  'tif',
  'tiff',
  // 音视频
  'mp3',
  'wav',
  'ogg',
  'oga',
  'opus',
  'flac',
  'aac',
  'm4a',
  'aiff',
  'mp4',
  'm4v',
  'mov',
  'webm',
  'ogv',
  'mkv',
  'avi',
]);

/** 绝对路径、扩展名是文档或媒体。 */
export function canOpenExternally(path: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return DOCUMENT_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}
