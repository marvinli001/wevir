// 办公文档的高保真预览（0.138.0，Host 功能 `office_preview`）：Host 按需下载 LibreOffice 预览引擎（DeepSeek 的
// `@deepseek-ai/libreoffice-kit`，MPL-2.0；macOS 与 Windows 是原生引擎，Linux 是 WebAssembly 引擎，三个平台同一条路径），把
// Word、Excel、PowerPoint 与 OpenDocument 文件转成 PDF，文件窗格用 Chromium 的 PDF 查看器显示。引擎没装时窗格照旧显示抽出的
// 文字或表格（0.32.0）。转换在本机进行，文件不离开电脑。

import { z } from 'zod';
import { SessionIdSchema, WorkspaceIdSchema } from './common.js';

/** 能转成 PDF 的扩展名（小写，不带点）：文字处理、电子表格、演示文稿各三种（二进制 Office 97–2003、OOXML、OpenDocument）。 */
export const OFFICE_PDF_EXTENSIONS = [
  'doc',
  'docx',
  'odt',
  'xls',
  'xlsx',
  'ods',
  'ppt',
  'pptx',
  'odp',
] as const;

/**
 * 预览引擎的状态：`unsupported` 是这个平台没有引擎；`missing` 没下载；`installing` 下载中（看 `progress`）；`ready` 可用；
 * `failed` 上次下载失败（看 `error`），可以再装。
 */
export const OfficeEngineStateSchema = z.enum([
  'unsupported',
  'missing',
  'installing',
  'ready',
  'failed',
]);
export type OfficeEngineState = z.infer<typeof OfficeEngineStateSchema>;

export const OfficeEngineStatusSchema = z.object({
  state: OfficeEngineStateSchema,
  /** 引擎的名称（产品名，界面原样显示），如 `LibreOffice`。 */
  engineName: z.string().min(1),
  /** 钉住的引擎版本。 */
  version: z.string().min(1),
  /** 引擎在这个平台用 `native`（原生程序）还是 `wasm`（WebAssembly）；`unsupported` 时省略。 */
  backend: z.enum(['native', 'wasm']).optional(),
  /** 要下载的字节数（压缩包，约数）。 */
  downloadBytes: z.int().min(0),
  /** 装好后占的磁盘字节数；`ready` 时有。 */
  installedBytes: z.int().min(0).optional(),
  /** `installing` 时有。 */
  progress: z
    .object({
      completedBytes: z.int().min(0),
      totalBytes: z.int().min(0).optional(),
    })
    .optional(),
  /** `failed` 时有：失败原因（给人看）。 */
  error: z.string().optional(),
});
export type OfficeEngineStatus = z.infer<typeof OfficeEngineStatusSchema>;

/** `office.status` / `office.install` / `office.cancelInstall` / `office.uninstall` 的结果。 */
export const OfficeStatusResultSchema = z.object({ status: OfficeEngineStatusSchema });

/** `office.changed`：引擎的状态变了（装、卸、进度）。发给调用过 `office.*` 的连接。 */
export const OfficeChangedParamsSchema = z.object({ status: OfficeEngineStatusSchema });

/**
 * `workspace.officePdf`：把目录里的一个办公文档转成 PDF，返回 PDF 的只读流式地址（同 `workspace.fileUrl` 的令牌规则，地址指向
 * Host 的转换缓存）。同一份文件（路径、大小与修改时间不变）只转一次；转换可能要几秒，大文件更久。
 */
export const WorkspaceOfficePdfParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  sessionId: SessionIdSchema.optional(),
  /** 相对路径，`/` 分隔。 */
  path: z.string().min(1).max(1024),
});

/**
 * 转不出来时只有 `unavailable`（开放字符串）：`not_found` 文件不在；`unsupported` 不是能转的格式；`engine_missing` 引擎没装好；
 * `too_large` 文件或 PDF 超过上限；`invalid_document` 文件坏了或不是它的扩展名说的格式；`timeout` 转换超时；`failed` 别的失败
 * （看 `message`）。
 */
export const WorkspaceOfficePdfResultSchema = z.object({
  path: z.string().min(1),
  /** PDF 的地址。 */
  url: z.string().min(1).optional(),
  /** PDF 的页数。 */
  pageCount: z.int().min(0).optional(),
  /** 文档里声明了、本机没装的字体（由替代字体显示，排版可能与原件不同）。 */
  missingFonts: z.array(z.string().min(1)).max(64).optional(),
  /** 地址作废的时间（毫秒）。 */
  expiresAt: z.number().min(0).optional(),
  unavailable: z.string().min(1).optional(),
  /** 失败时给人看的说明。 */
  message: z.string().optional(),
});
export type WorkspaceOfficePdfResult = z.infer<typeof WorkspaceOfficePdfResultSchema>;
