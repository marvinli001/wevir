// 开发服务器预览（0.84.0，Host 功能 `dev_preview`，ADR-0013）：项目的运行配置（命令、端口、地址）存在 Host，按工作区一份，不写回
// 仓库。启动等于在会话里起一个后台进程（`HostProcess.source.kind` 是 `preview`），停止与读输出走 `process.*`；就绪后客户端在浏览器
// 窗格里打开 `HostProcess.preview.url`。候选从 `package.json` 的脚本与 `.claude/launch.json` 读出来，不执行，保存了才是配置。

import { z } from 'zod';
import { IsoTimeSchema, SessionIdSchema, WorkspaceIdSchema } from './common.js';
import {
  HostProcessSchema,
  PREVIEW_NAME_MAX_LENGTH,
  PREVIEW_URL_MAX_LENGTH,
  PROCESS_COMMAND_MAX_LENGTH,
} from './processes.js';
import { ReadinessStatusSchema } from './readiness.js';

/** 一个工作区最多几项运行配置、一项最多几个环境变量。 */
export const PREVIEWS_MAX_PER_WORKSPACE = 20;
export const PREVIEW_ENV_MAX = 50;
export const PREVIEW_PATH_MAX_LENGTH = 500;

/** 配置的内容：`cwd` 相对会话目录（空字符串是会话目录本身），`url` 是 http(s) 地址。 */
export const PreviewFieldsSchema = z.object({
  name: z.string().trim().min(1).max(PREVIEW_NAME_MAX_LENGTH),
  command: z.string().trim().min(1).max(PROCESS_COMMAND_MAX_LENGTH),
  cwd: z.string().max(PREVIEW_PATH_MAX_LENGTH),
  port: z.int().min(1).max(65535).optional(),
  url: z
    .string()
    .max(PREVIEW_URL_MAX_LENGTH)
    .regex(/^https?:\/\/\S+$/i)
    .optional(),
  env: z
    .record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(8000))
    .refine((env) => Object.keys(env).length <= PREVIEW_ENV_MAX)
    .optional(),
});

/** 保存了的运行配置。`addedBy`：用户在界面里保存的，或 Agent 用 `wevir_preview_start` 带命令保存的。 */
export const PreviewConfigSchema = PreviewFieldsSchema.extend({
  addedBy: z.enum(['user', 'agent']),
  createdAt: IsoTimeSchema,
  updatedAt: IsoTimeSchema,
});
export type PreviewConfig = z.infer<typeof PreviewConfigSchema>;

export const PreviewInputSchema = PreviewFieldsSchema.partial({ cwd: true });
export type PreviewInput = z.infer<typeof PreviewInputSchema>;

/** 仓库里读出来的候选：`package_script` 是 `package.json` 的脚本，`claude_launch` 是 `.claude/launch.json` 的一项。 */
export const PreviewCandidateSchema = PreviewFieldsSchema.extend({
  origin: z.enum(['package_script', 'claude_launch']),
  /** 读的文件，相对会话目录。 */
  file: z.string().min(1).max(PREVIEW_PATH_MAX_LENGTH),
});
export type PreviewCandidate = z.infer<typeof PreviewCandidateSchema>;

/** `preview.list`：会话目录（`root`）下的配置与候选；在跑的预览看 `process.list`（`preview.root` 等于 `root` 的）。 */
export const PreviewListParamsSchema = z.object({ sessionId: SessionIdSchema });
export const PreviewListResultSchema = z.object({
  root: z.string(),
  configs: z.array(PreviewConfigSchema),
  /** 去掉了与已保存的配置同命令、同目录的。 */
  candidates: z.array(PreviewCandidateSchema),
});

/** `preview.save`：按 `name` 新建或替换；带 `previous` 时是改名（原名那项换成这一项）。 */
export const PreviewSaveParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  config: PreviewInputSchema,
  previous: z.string().min(1).max(PREVIEW_NAME_MAX_LENGTH).optional(),
});
export const PreviewSaveResultSchema = z.object({ configs: z.array(PreviewConfigSchema) });

export const PreviewRemoveParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  name: z.string().min(1).max(PREVIEW_NAME_MAX_LENGTH),
});
export const PreviewRemoveResultSchema = z.object({ configs: z.array(PreviewConfigSchema) });

/** 挡住启动的环境项（ADR-0011 的阻塞项，同 `VerificationRun.readiness`）。 */
export const PreviewBlockingItemSchema = z.object({
  kind: z.string().min(1).max(40),
  name: z.string().min(1).max(100),
  path: z.string().max(500),
  status: ReadinessStatusSchema,
  reason: z.string().min(1).max(80).optional(),
});

/**
 * `preview.start`：在这个会话里按名字启动。
 * - `started`：起了新的进程（就绪看 `process.changed`）；`reused`：同一根目录、同名的已在跑，返回它。
 * - `blocked`：环境没就绪（命令相关的阻塞项），没有启动。
 * - `port_in_use`：配置的端口已被别的进程占用，没有启动；`url` 是这项配置的地址。
 */
export const PreviewStartParamsSchema = z.object({
  sessionId: SessionIdSchema,
  name: z.string().min(1).max(PREVIEW_NAME_MAX_LENGTH),
});
export const PreviewStartResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('started'), process: HostProcessSchema }),
  z.object({ status: z.literal('reused'), process: HostProcessSchema }),
  z.object({
    status: z.literal('blocked'),
    readiness: z.array(PreviewBlockingItemSchema).min(1).max(8),
  }),
  z.object({
    status: z.literal('port_in_use'),
    port: z.int().min(1).max(65535),
    url: z.string().max(PREVIEW_URL_MAX_LENGTH),
  }),
]);
export type PreviewStartResult = z.infer<typeof PreviewStartResultSchema>;

/** `preview.changed`：工作区的配置变了（别的客户端或 Agent 保存、删除）。发给调过 `preview.*` 的连接。 */
export const PreviewChangedParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  configs: z.array(PreviewConfigSchema),
});
