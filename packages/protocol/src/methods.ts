import { z } from 'zod';
import {
  AutomationChangedParamsSchema,
  AutomationCreateParamsSchema,
  AutomationDeleteParamsSchema,
  AutomationDeleteResultSchema,
  AutomationGetParamsSchema,
  AutomationGetResultSchema,
  AutomationListParamsSchema,
  AutomationListResultSchema,
  AutomationResultSchema,
  AutomationRunParamsSchema,
  AutomationRunResultSchema,
  AutomationUpdateParamsSchema,
} from './automations.js';
import { BrowserRequestSchema, BrowserResponseSchema } from './browser.js';
import {
  ClientCapabilitiesSchema,
  HostFeaturesSchema,
  type Permission,
  PermissionsSchema,
} from './capabilities.js';
import {
  ApprovalIdSchema,
  ClientKindSchema,
  ClientTokenSchema,
  EnvironmentIdSchema,
  HostIdSchema,
  ImageIdSchema,
  PendingMessageIdSchema,
  ProviderIdSchema,
  QuestionIdSchema,
  SeqCursorSchema,
  SeqSchema,
  SessionIdSchema,
  SubscriptionIdSchema,
  TurnIdSchema,
  WorkspaceIdSchema,
} from './common.js';
import {
  AccountKindSchema,
  AccountLabelSchema,
  AccountLoginMethodSchema,
  AccountStateSchema,
  AccountUpstreamSchema,
  ApprovalResolutionSchema,
  CollaborationModeSchema,
  EngineErrorInfoSchema,
  EngineFeaturesSchema,
  EnvironmentFolderSchema,
  EnvironmentSchema,
  FilesRestoreSchema,
  GOAL_OBJECTIVE_MAX_CHARS,
  HandoffBindingSchema,
  HandoffConfigureSchema,
  HandoffMaterialRequestSchema,
  HandoffPreviewSchema,
  HostSettingsSchema,
  HttpUrlSchema,
  MemoryNameSchema,
  MemoryNoteSchema,
  MemoryScopeSchema,
  MemorySummarySchema,
  MemoryTypeSchema,
  PendingDeliverySchema,
  PendingMessageSchema,
  PermissionModeSchema,
  ProviderApiSchema,
  ProviderCompatSchema,
  ProviderModelSchema,
  ProviderProfileSchema,
  QuestionAnswerSchema,
  QuestionResolutionSchema,
  ResolvedApprovalStatusSchema,
  ReviewTargetSchema,
  SessionGoalSchema,
  SessionOriginSchema,
  SessionRecapSchema,
  SessionSchema,
  SessionSnapshotSchema,
  ToolGroupInfoSchema,
  ToolPresetInfoSchema,
  ToolPresetSchema,
  UserContentPartSchema,
  UserImageMimeTypeSchema,
  UserImagePartSchema,
  VertexConfigSchema,
  WebSearchServiceIdSchema,
  WebSettingsSchema,
  WORKSPACE_EXTRA_FOLDERS_MAX,
  WorkspaceSchema,
  WorktreeModeSchema,
} from './entities.js';
import { WevirEventSchema } from './events.js';
import { PluginMethodSchemas } from './plugins.js';
import {
  UsageChangedParamsSchema,
  UsagePricingParamsSchema,
  UsagePricingResultSchema,
  UsageRecordsParamsSchema,
  UsageRecordsResultSchema,
  UsageSummaryParamsSchema,
  UsageSummaryResultSchema,
} from './usage.js';
import {
  ChecksCandidatesParamsSchema,
  ChecksCandidatesResultSchema,
  ChecksListParamsSchema,
  ChecksListResultSchema,
  ChecksRemoveParamsSchema,
  ChecksRemoveResultSchema,
  ChecksSaveParamsSchema,
  ChecksSaveResultSchema,
  ChecksSetRepairParamsSchema,
  ChecksSetRepairResultSchema,
  VerificationCancelParamsSchema,
  VerificationCancelResultSchema,
  VerificationOutputParamsSchema,
  VerificationOutputResultSchema,
  VerificationRunParamsSchema,
  VerificationRunResultSchema,
  VerificationStatusParamsSchema,
  VerificationStatusResultSchema,
} from './verification.js';
import { ProtocolVersionSchema } from './version.js';

// Host API v0 的方法与通知。语义、错误与示例报文见 docs/architecture/host-api.md。

const EmptySchema = z.object({});

// ── host.* ────────────────────────────────────────────────────────────

export const HostHelloParamsSchema = z.object({
  /** `run/host.json` 里的令牌。 */
  token: z.string().min(1),
  protocolVersion: ProtocolVersionSchema,
  clientKind: ClientKindSchema,
  /** 设备级标识。 */
  deviceId: ClientTokenSchema,
  /** 每个安装持久；同一台设备上的桌面与 CLI 不同。 */
  clientId: ClientTokenSchema,
  capabilities: ClientCapabilitiesSchema,
});

export const HostHelloResultSchema = z.object({
  hostId: HostIdSchema,
  hostVersion: z.string().min(1),
  /** 协商后的版本：客户端与 Host 中较低的一个。 */
  protocolVersion: ProtocolVersionSchema,
  minProtocolVersion: ProtocolVersionSchema,
  features: HostFeaturesSchema,
  /**
   * 每种 Provider 的会话由哪个引擎跑、能做什么（0.25.0），键是 Provider 种类。会话接力之后按当前的 `providerId` 查。旧 Host 没有。
   */
  engineFeatures: z.record(z.string(), EngineFeaturesSchema).optional(),
  /** 本连接拿到的权限；骨架阶段恒为 `PERMISSIONS` 全部。 */
  permissions: PermissionsSchema,
});

// ── settings.*（0.8.0） ────────────────────────────────────────────

export const SettingsResultSchema = z.object({
  settings: HostSettingsSchema,
});

export const SettingsUpdateParamsSchema = z.object({
  /** 只改给出的字段。 */
  settings: HostSettingsSchema.partial(),
});

/** `settings.updated` 通知：设置变了，带全部设置。发给调用过 `settings.*` 的连接。 */
export const SettingsUpdatedParamsSchema = SettingsResultSchema;

// ── workspace.* ───────────────────────────────────────────────────────

export const WorkspaceListResultSchema = z.object({
  workspaces: z.array(WorkspaceSchema),
});

export const WorkspaceAddParamsSchema = z.object({
  /** 绝对路径；Host 取 realpath 后去重。 */
  rootPath: z.string().min(1),
  /** 省略时取目录名。 */
  displayName: z.string().min(1).optional(),
  /**
   * 其他源文件夹（0.64.0，Host 功能 `workspace_folders`）：绝对路径，Host 取 realpath，检查同 `rootPath`，不能与主文件夹或彼此
   * 重复。只在新建时用；`rootPath` 已有工作区（`created: false`）时不改它的文件夹。
   */
  extraFolders: z.array(z.string().min(1)).max(WORKSPACE_EXTRA_FOLDERS_MAX).optional(),
});

export const WorkspaceAddResultSchema = z.object({
  workspace: WorkspaceSchema,
  /** false：同一 realpath 已有工作区（含曾被移除的），返回原 `id`。 */
  created: z.boolean(),
});

export const WorkspaceRemoveParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema,
});

/** 项目显示名的最大长度（`workspace.update`，0.49.0）。 */
export const WORKSPACE_NAME_MAX_LENGTH = 200;

/**
 * `workspace.update`（0.49.0，Host 功能 `workspace_update`）：改项目的显示名。`rootPath` 不可改。`displayName` 去掉首尾空白后不能是
 * 空的；“对话”工作区不能改。0.64.0（Host 功能 `workspace_folders`）起也能整组换掉其他源文件夹（`[]` 清空），两项都可省略，省略
 * 的不改；已经开着的会话不受影响，之后新建的会话才用新的文件夹。
 */
export const WorkspaceUpdateParamsSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    displayName: z.string().min(1).max(WORKSPACE_NAME_MAX_LENGTH).optional(),
    extraFolders: z.array(z.string().min(1)).max(WORKSPACE_EXTRA_FOLDERS_MAX).optional(),
  })
  .refine((params) => params.displayName !== undefined || params.extraFolders !== undefined, {
    message: 'displayName or extraFolders is required',
    path: ['displayName'],
  });

export const WorkspaceUpdateResultSchema = z.object({
  workspace: WorkspaceSchema,
});

// ── environment.*（0.15.0，U22.1） ────────────────────────────────────

export const EnvironmentListResultSchema = z.object({
  /** 按创建时间。 */
  environments: z.array(EnvironmentSchema),
});

export const EnvironmentCreateParamsSchema = z.object({
  name: z.string().min(1).max(60),
  folders: z.array(EnvironmentFolderSchema).min(1).max(8),
});

export const EnvironmentUpdateParamsSchema = z.object({
  environmentId: EnvironmentIdSchema,
  /** 省略：不改。 */
  name: z.string().min(1).max(60).optional(),
  /** 省略：不改。 */
  folders: z.array(EnvironmentFolderSchema).min(1).max(8).optional(),
});

export const EnvironmentResultSchema = z.object({
  environment: EnvironmentSchema,
});

export const EnvironmentIdParamsSchema = z.object({
  environmentId: EnvironmentIdSchema,
});

// ── workspace.git（0.13.0，U18） ──────────────────────────────────────

export const WorkspaceGitParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  /** 0.15.0：读这个会话的目录（环境会话的 worktree）；会话要属于这个工作区。省略时读工作区目录。 */
  sessionId: SessionIdSchema.optional(),
});

/** `workspace.git` 结果里的一个改动的文件。 */
export const GitFileChangeSchema = z.object({
  /** 相对工作区目录，`/` 分隔。 */
  path: z.string().min(1),
  /** 已见 `modified` / `added` / `deleted` / `untracked`；开放字符串，以后可能多出取值。 */
  status: z.string().min(1),
  /** 增删行数；二进制文件与未跟踪文件没有。 */
  added: z.int().min(0).optional(),
  removed: z.int().min(0).optional(),
});
export type GitFileChange = z.infer<typeof GitFileChangeSchema>;

/** 文件列表最多这么多项，多了 `truncated`。 */
export const WORKSPACE_GIT_MAX_FILES = 200;

/**
 * 工作区目录的 git 状态（host-api.md §3.1）：每次调用现读，不缓存。`repo: false`（不是仓库、没有 git、出错或超时）时
 * 其余字段都省略。
 */
export const WorkspaceGitResultSchema = z.object({
  repo: z.boolean(),
  /** 当前分支（含还没有提交的新分支）；分离头指针时没有。 */
  branch: z.string().min(1).optional(),
  /** 分离头指针时 HEAD 的短 SHA。 */
  detachedAt: z.string().min(1).optional(),
  /** 已跟踪文件相对 HEAD 的增删行数之和（工作树 + 暂存区，只算工作区目录里的）。 */
  added: z.int().min(0).optional(),
  removed: z.int().min(0).optional(),
  /** 改动的文件数，含未跟踪文件；`files` 被截断时仍是总数。 */
  fileCount: z.int().min(0).optional(),
  files: z.array(GitFileChangeSchema).max(WORKSPACE_GIT_MAX_FILES).optional(),
  /** `files` 只列了前 `WORKSPACE_GIT_MAX_FILES` 项。 */
  truncated: z.boolean().optional(),
});
export type WorkspaceGitResult = z.infer<typeof WorkspaceGitResultSchema>;

// ── workspace.diff / workspace.diffFile / session.checkpoints（0.20.0） ─────────

/**
 * 读哪一段改动：`uncommitted` 是工作树加暂存区对 HEAD（含未跟踪文件），`branch` 是工作树对默认分支的 merge-base，`turn` 是
 * 会话一个回合前后的快照（host-api.md §3.1）。
 */
export const DiffSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('uncommitted') }),
  z.object({ kind: z.literal('branch') }),
  z.object({ kind: z.literal('turn'), turnId: TurnIdSchema }),
]);
export type DiffSource = z.infer<typeof DiffSourceSchema>;

export const WorkspaceDiffParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  /** 读这个会话的目录（环境会话的 worktree）；`turn` 必须给。会话要属于这个工作区。 */
  sessionId: SessionIdSchema.optional(),
  source: DiffSourceSchema,
});

/** `workspace.diff` 结果里的一个改动的文件。 */
export const DiffFileSchema = z.object({
  /** 相对会话或工作区目录，`/` 分隔；删除的文件是原来的路径。 */
  path: z.string().min(1),
  /** 重命名、复制前的路径。 */
  previousPath: z.string().min(1).optional(),
  /** 已见 `added` / `deleted` / `modified` / `renamed` / `copied` / `type_changed` / `untracked`；开放字符串。 */
  status: z.string().min(1),
  /** 增删行数；二进制文件与没算出 diff 的未跟踪文件没有。 */
  added: z.int().min(0).optional(),
  removed: z.int().min(0).optional(),
  binary: z.literal(true).optional(),
  /**
   * 这个文件的 diff 不在 `patch` 里：`too_large`（单个文件超过上限）、`over_limit`（整体超过上限，或未跟踪文件太多没算）；
   * 开放字符串。
   */
  omitted: z.string().min(1).optional(),
});
export type DiffFile = z.infer<typeof DiffFileSchema>;

/** `files` 最多这么多项，多了 `truncated`；`fileCount` 仍是总数。 */
export const WORKSPACE_DIFF_MAX_FILES = 2000;

/** 提交或树对象的完整 SHA（SHA-1 40 位、SHA-256 64 位，小写）。 */
export const GitObjectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

/**
 * 一段改动（host-api.md §3.1）。`repo: false`（不是仓库、没有 git、出错或超时）或 `unavailable` 时其余字段都省略。
 */
export const WorkspaceDiffResultSchema = z.object({
  repo: z.boolean(),
  /** `turn`：这个回合没有快照（`no_checkpoint`，回合早于这个功能、目录不是仓库、快照失败或会话关闭时已清理）；开放字符串。 */
  unavailable: z.string().min(1).optional(),
  /** 旧的一侧：HEAD、merge-base 或回合前快照的提交，还没有提交时是空树。给 `workspace.diffFile` 的 `oldRev`。 */
  base: GitObjectIdSchema.optional(),
  /** `branch`：比较的默认分支，例如 `origin/main`；找不到时省略，结果同 `uncommitted`。 */
  baseRef: z.string().min(1).optional(),
  /** 当前分支；分离头指针时省略。 */
  branch: z.string().min(1).optional(),
  /** 新的一侧是回合后快照的提交；省略时是磁盘上的工作树。 */
  head: GitObjectIdSchema.optional(),
  /** `turn`：回合还没有结束后的快照（进行中，或快照失败），新的一侧是现在的工作树。 */
  live: z.literal(true).optional(),
  /** `git diff` 的统一格式（`a/`、`b/` 前缀），只含 `files` 里没有 `omitted` 的文件。 */
  patch: z.string().optional(),
  files: z.array(DiffFileSchema).max(WORKSPACE_DIFF_MAX_FILES).optional(),
  fileCount: z.int().min(0).optional(),
  /** 全部文件的增删行数之和（含 `omitted` 的）。 */
  added: z.int().min(0).optional(),
  removed: z.int().min(0).optional(),
  /** 有文件的 diff 没给（`omitted`），或 `files` 只列了前 `WORKSPACE_DIFF_MAX_FILES` 项。 */
  truncated: z.literal(true).optional(),
});
export type WorkspaceDiffResult = z.infer<typeof WorkspaceDiffResultSchema>;

/**
 * 读一个文件两侧的全文，给“展开未修改的行”。旧的一侧是 `oldRev` 里的 `oldPath`；新的一侧是 `newRev` 里的 `newPath`，没有
 * `newRev` 时读磁盘。只给要读的那一侧的路径。
 */
export const WorkspaceDiffFileParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  sessionId: SessionIdSchema.optional(),
  oldRev: GitObjectIdSchema.optional(),
  oldPath: z.string().min(1).optional(),
  newRev: GitObjectIdSchema.optional(),
  newPath: z.string().min(1).optional(),
});

export const WorkspaceDiffFileResultSchema = z.object({
  oldContents: z.string().optional(),
  newContents: z.string().optional(),
  /** 读不了时：`too_large`（超过 1 MiB）、`binary`、`not_found`；开放字符串，两侧内容都省略。 */
  unavailable: z.string().min(1).optional(),
});
export type WorkspaceDiffFileResult = z.infer<typeof WorkspaceDiffFileResultSchema>;

export const SessionCheckpointsParamsSchema = z.object({
  sessionId: SessionIdSchema,
});

/** 一个有快照的回合；回合后的快照还没有时（进行中）没有统计。 */
export const TurnCheckpointSchema = z.object({
  turnId: TurnIdSchema,
  fileCount: z.int().min(0).optional(),
  added: z.int().min(0).optional(),
  removed: z.int().min(0).optional(),
});
export type TurnCheckpoint = z.infer<typeof TurnCheckpointSchema>;

export const SessionCheckpointsResultSchema = z.object({
  /** 会话目录不是 git 仓库时 false，`turns` 为空。 */
  repo: z.boolean(),
  /** 从早到晚。 */
  turns: z.array(TurnCheckpointSchema),
});
export type SessionCheckpointsResult = z.infer<typeof SessionCheckpointsResultSchema>;

// ── workspace.files / workspace.listDir / workspace.readFile（0.22.0） ─────────

/** `workspace.files` 一次最多返回的条数。 */
export const WORKSPACE_FILES_MAX_LIMIT = 200;
/** `workspace.listDir` 一个目录最多列出的条数。 */
export const WORKSPACE_LIST_DIR_MAX_ENTRIES = 5000;
/** `workspace.readFile` 读文本的上限（字节）。 */
export const WORKSPACE_READ_TEXT_MAX_BYTES = 1024 * 1024;
/** `workspace.readFile` 读图片的上限（字节）；base64 之后仍在连接的发送缓冲之内。 */
export const WORKSPACE_READ_IMAGE_MAX_BYTES = 4 * 1024 * 1024;

export const WorkspaceEntryKindSchema = z.enum(['file', 'directory']);
export type WorkspaceEntryKind = z.infer<typeof WorkspaceEntryKindSchema>;

/** 目录里的一项：相对会话目录（或工作区根目录）的路径，`/` 分隔。 */
export const WorkspaceEntrySchema = z.object({
  path: z.string().min(1),
  kind: WorkspaceEntryKindSchema,
  /** 被 `.gitignore` 忽略（只有 `workspace.listDir` 标）。 */
  ignored: z.literal(true).optional(),
});
export type WorkspaceEntry = z.infer<typeof WorkspaceEntrySchema>;

/**
 * 按名字找文件与文件夹（输入框的 @ 提及、文件窗格的搜索）。`query` 为空时按目录层级给出前 `limit` 项。git 仓库里只列
 * 跟踪的与没被忽略的文件，不是 git 仓库时跳过常见的依赖与构建目录；最多索引 25 000 项。
 */
export const WorkspaceFilesParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  /** 找这个会话的目录（环境会话的 worktree）；会话要属于这个工作区。 */
  sessionId: SessionIdSchema.optional(),
  query: z.string().max(256),
  /** 默认 50。 */
  limit: z.int().min(1).max(WORKSPACE_FILES_MAX_LIMIT).optional(),
  /** 只要文件或只要文件夹。 */
  kind: WorkspaceEntryKindSchema.optional(),
});

export const WorkspaceFilesResultSchema = z.object({
  /** 按匹配程度从好到差。 */
  entries: z.array(WorkspaceEntrySchema).max(WORKSPACE_FILES_MAX_LIMIT),
  /** 匹配的不止这些，或索引到上限没有列全。 */
  truncated: z.literal(true).optional(),
});
export type WorkspaceFilesResult = z.infer<typeof WorkspaceFilesResultSchema>;

/** 列一个目录的直接子项（文件窗格的目录树）：文件夹在前，再按名字；不含 `.git`。 */
export const WorkspaceListDirParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  sessionId: SessionIdSchema.optional(),
  /** 相对路径，`/` 分隔；空字符串是根目录。 */
  path: z.string().max(1024),
});

export const WorkspaceListDirResultSchema = z.object({
  entries: z.array(WorkspaceEntrySchema).max(WORKSPACE_LIST_DIR_MAX_ENTRIES),
  truncated: z.literal(true).optional(),
});
export type WorkspaceListDirResult = z.infer<typeof WorkspaceListDirResultSchema>;

export const WorkspaceReadFileParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  sessionId: SessionIdSchema.optional(),
  /** 相对路径，`/` 分隔。 */
  path: z.string().min(1).max(1024),
});

/** 能预览的图片格式。 */
export const PreviewImageMimeTypeSchema = z.enum([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'image/bmp',
  'image/x-icon',
]);
export type PreviewImageMimeType = z.infer<typeof PreviewImageMimeTypeSchema>;

/**
 * 一个文件的内容：文本给 `text`（UTF-8），按扩展名认出的图片给 `image`（base64）；读不了时只有 `unavailable`：
 * `too_large`（文本超过 1 MiB、图片超过 4 MiB）、`binary`（含 NUL 字节）、`not_found`（不存在、不是普通文件、在目录外）。
 * 开放字符串。
 */
export const WorkspaceReadFileResultSchema = z.object({
  path: z.string().min(1),
  /** 文件的字节数；`not_found` 时省略。 */
  size: z.int().min(0).optional(),
  /**
   * 读到的这一版的修改时间（毫秒，0.32.0）：`not_found` 时省略。编辑后写回时作 `workspace.writeFile` 的 `expectedMtimeMs`。
   */
  mtimeMs: z.number().min(0).optional(),
  text: z.string().optional(),
  image: z.object({ mimeType: PreviewImageMimeTypeSchema, data: z.string() }).optional(),
  unavailable: z.string().min(1).optional(),
});
export type WorkspaceReadFileResult = z.infer<typeof WorkspaceReadFileResultSchema>;

// ── workspace.fileUrl / workspace.writeFile（0.32.0） ──────────────────────

/** `workspace.writeFile` 写文本的上限（字节，UTF-8）。 */
export const WORKSPACE_WRITE_TEXT_MAX_BYTES = 1024 * 1024;

/**
 * 给一个文件发只读的流式地址（文件预览：PDF、HTML、音视频、Office 文件与大图片不走 base64）。地址在 Host 的 RPC 端口上
 * （`http://127.0.0.1:<端口>/files/<令牌>/<路径>`），令牌只在 Host 内存里、一小时后作废；同一个令牌还能读同一目录里其他
 * 文件中网页会引用的那几类（图片、样式、脚本、字体、音视频、PDF、网页，路径里没有以 `.` 开头的段），HTML 页面的相对引用与
 * Markdown 里的图片照常加载。HTML 的响应带 CSP：沙箱、不能联网。
 */
export const WorkspaceFileUrlParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  sessionId: SessionIdSchema.optional(),
  /** 相对路径，`/` 分隔。 */
  path: z.string().min(1).max(1024),
});

/** 文件不存在、不是普通文件或在目录外时只有 `unavailable: 'not_found'`（开放字符串）。 */
export const WorkspaceFileUrlResultSchema = z.object({
  path: z.string().min(1),
  /** 这个文件的地址；目录里的其他文件按相对路径从它解析。 */
  url: z.string().min(1).optional(),
  size: z.int().min(0).optional(),
  mtimeMs: z.number().min(0).optional(),
  /** 地址作废的时间（毫秒）。 */
  expiresAt: z.number().min(0).optional(),
  unavailable: z.string().min(1).optional(),
});
export type WorkspaceFileUrlResult = z.infer<typeof WorkspaceFileUrlResultSchema>;

/**
 * 把文本写回一个已有的文件（文件窗格的编辑）。带 `expectedMtimeMs` 时，文件在那之后被改过（或已删除）就不写，结果带
 * `conflict`，以及磁盘上现在的 `size` / `mtimeMs`。只写已有的普通文件，不新建；路径 realpath 之后仍要在目录里。
 */
export const WorkspaceWriteFileParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  sessionId: SessionIdSchema.optional(),
  path: z.string().min(1).max(1024),
  /** 新的全文（UTF-8）。 */
  text: z.string(),
  /** 编辑基于的那一版（`workspace.readFile` 或上一次写回的 `mtimeMs`）。 */
  expectedMtimeMs: z.number().min(0).optional(),
});

export const WorkspaceWriteFileResultSchema = z.object({
  path: z.string().min(1),
  /** 写完（或冲突时磁盘上）的字节数；冲突且文件已删除时省略。 */
  size: z.int().min(0).optional(),
  mtimeMs: z.number().min(0).optional(),
  /** 没写：文件在 `expectedMtimeMs` 之后变了。 */
  conflict: z.literal(true).optional(),
});
export type WorkspaceWriteFileResult = z.infer<typeof WorkspaceWriteFileResultSchema>;

// ── provider.* ────────────────────────────────────────────────────────

export const ProviderListResultSchema = z.object({
  providers: z.array(ProviderProfileSchema),
});

const providerUpsertCommon = {
  displayName: z.string().min(1),
  defaultModelId: z.string().min(1),
  /**
   * 省略：保留已存的 Key；字符串：设置或替换；null：删除。
   * Key 只进 SecretStore，Host 不得把它写进日志或任何响应。
   */
  apiKey: z.string().min(1).nullable().optional(),
};

/** 整体替换非密钥字段（不是合并）；`id` 不存在时新建。`kind` 创建后不可改。 */
export const ProviderUpsertParamsSchema = z.discriminatedUnion('kind', [
  z.object({
    ...providerUpsertCommon,
    /** dsh 的路由名固定，所以这类 Profile 最多一个。 */
    id: z.literal('deepseek-official'),
    kind: z.literal('deepseek-official'),
    baseURL: HttpUrlSchema.optional(),
    models: z.array(ProviderModelSchema),
  }),
  z.object({
    ...providerUpsertCommon,
    id: ProviderIdSchema,
    kind: z.literal('openai-compatible'),
    api: ProviderApiSchema,
    baseURL: HttpUrlSchema,
    compat: ProviderCompatSchema.optional(),
    models: z.array(ProviderModelSchema).min(1),
  }),
  z.object({
    id: ProviderIdSchema,
    kind: z.literal('google-vertex'),
    displayName: z.string().min(1),
    defaultModelId: z.string().min(1),
    api: ProviderApiSchema,
    vertex: VertexConfigSchema.optional(),
    compat: ProviderCompatSchema.optional(),
    models: z.array(ProviderModelSchema).min(1),
    /** 整份服务账号 JSON 只进 SecretStore；省略保留、null 删除。 */
    serviceAccountJson: z
      .string()
      .min(1)
      .max(64 * 1024)
      .nullable()
      .optional(),
  }),
  /**
   * ChatGPT 订阅（0.7.0）：没有 Key、地址与 compat；`models` 由 Host 从引擎取（ChatGPT 登录成功时 Host 会自己建这个
   * Provider，客户端用 upsert 改显示名与默认模型）。`defaultModelId` 要在引擎给的模型列表里。只在 Host 声明了
   * `chatgpt_account` 功能时可用，否则 `INVALID_PARAMS`。0.63.0 起 `id` 可以是添加的 ChatGPT 账号（`account.add`）的 ID，
   * 不是 ChatGPT 账号时 `INVALID_PARAMS`。
   */
  z.object({
    id: ProviderIdSchema,
    kind: z.literal('chatgpt'),
    displayName: z.string().min(1),
    defaultModelId: z.string().min(1),
  }),
]);

export const ProviderUpsertResultSchema = z.object({
  provider: ProviderProfileSchema,
  created: z.boolean(),
});

export const ProviderIdParamsSchema = z.object({
  providerId: ProviderIdSchema,
});

export const ProviderTestParamsSchema = z.object({
  providerId: ProviderIdSchema,
  /** 省略时用 `defaultModelId`。 */
  modelId: z.string().min(1).optional(),
});

/**
 * `provider.test` 失败的原因（0.2.0），供界面给出对应的修复提示；原文在 `error.message`。
 * missing_key：没有存 Key，没有发请求；network：连不上（DNS、拒绝连接、TLS）；timeout：时限内没有响应；
 * auth：401 / 403；model_not_found：服务端说没有这个模型；protocol：地址能连上但不按所选协议应答
 * （404 / 405、返回的不是该协议的流）；rate_limited：429（含额度用完）；server：5xx；unknown：其他。
 */
export const ProviderTestFailureSchema = z.enum([
  'missing_key',
  'network',
  'timeout',
  'auth',
  'model_not_found',
  'protocol',
  'rate_limited',
  'server',
  'unknown',
]);
export type ProviderTestFailure = z.infer<typeof ProviderTestFailureSchema>;

export const ProviderTestResultSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.int().min(0).optional(),
  /** `ok` 为 false 时必有。 */
  error: EngineErrorInfoSchema.extend({
    /** Stable diagnostic code for localized provider-specific guidance (0.31.0). */
    code: z.union([z.string(), z.int()]).optional(),
  }).optional(),
  /** `ok` 为 false 时有（0.2.0）。 */
  reason: ProviderTestFailureSchema.optional(),
  /** 服务端返回的 HTTP 状态码（0.2.0）；没有收到响应时省略。 */
  httpStatus: z.int().min(100).max(599).optional(),
});

/** Ollama discovery (0.31.0). Exactly one of providerId / baseURL is required by Host. */
export const ProviderDiscoverModelsParamsSchema = z.object({
  providerId: ProviderIdSchema.optional(),
  baseURL: HttpUrlSchema.optional(),
  /** Unsaved form only; never persisted or returned. Stored providers use SecretStore. */
  apiKey: z.string().min(1).max(8192).optional(),
  /** Omit to list models; sessions request only their current model. */
  modelId: z.string().min(1).max(512).optional(),
});

export const DiscoveredProviderModelSchema = z.object({
  model: ProviderModelSchema,
  capabilities: z.array(z.string()).optional(),
  sizeBytes: z.int().min(0).optional(),
  parameterSize: z.string().optional(),
  quantization: z.string().optional(),
  remoteHost: z.string().optional(),
  /** Model limit, distinct from the allocated context in model.contextWindow. */
  maxContextWindow: z.int().min(1).optional(),
  /** running / configured / cloud; omitted when the actual context is unknown. */
  contextSource: z.string().optional(),
  detailsAvailable: z.boolean().optional(),
});
export type DiscoveredProviderModel = z.infer<typeof DiscoveredProviderModelSchema>;

export const ProviderDiscoverModelsResultSchema = z.object({
  ok: z.boolean(),
  models: z.array(DiscoveredProviderModelSchema),
  reason: ProviderTestFailureSchema.optional(),
  /** True when the server has more models than the bounded discovery list. */
  truncated: z.boolean().optional(),
});

// ── account.*（0.7.0，R6） ─────────────────────────────────────────────

export const AccountKindParamsSchema = z.object({
  kind: AccountKindSchema,
});

/**
 * 0.63.0：`account.get` / `login` / `cancelLogin` / `logout` 可带账号 ID（`AccountState.id`），省略时是这种的首个账号；ID 与
 * `kind` 对不上时 `INVALID_PARAMS`。
 */
const AccountIdField = { id: ProviderIdSchema.optional() };

/** `account.get`（0.19.0 起可带 `refresh`）。 */
export const AccountGetParamsSchema = AccountKindParamsSchema.extend({
  ...AccountIdField,
  /** 重新检测（重新找可执行文件、重读登录状态），用户在终端里登录之后用；省略时引擎可以用最近一次的结果。 */
  refresh: z.boolean().optional(),
});

/** `account.list`（0.19.0，Host 功能 `subscription_sources`）：Host 的引擎支持的全部账号种类，各自的状态。 */
export const AccountListResultSchema = z.object({
  accounts: z.array(AccountStateSchema),
});

/** `account.setPath`（0.19.0）：用这个可执行文件运行这类订阅的引擎；`null` 清掉，回到自动查找。 */
export const AccountSetPathParamsSchema = z.object({
  kind: AccountKindSchema,
  path: z.string().min(1).nullable(),
});

/** `account.login` 的 `apiKey` 最长多少字符（同 Provider 的 Key）。 */
export const ACCOUNT_API_KEY_MAX_LENGTH = 8192;

/**
 * `account.login`。0.56.0（Host 功能 `subscription_upstreams`）起订阅来源后面接着好几家上游的（OpenCode），用 `upstream`
 * 选接哪一家、`option` 选哪种方式（`account.upstreams` 给的，上游只有一种方式时可省略）：给了 `upstream` 时 `method` 被忽略
 * （引擎按方式决定是浏览器授权还是设备码，看返回的 `login`），`apiKey` 只在方式是 `api_key` 时给。**Key 只交给引擎，不进
 * 日志、事件与任何响应**。没有 `upstream` 时，`option` 是 `AccountState.loginOptions` 里的一项（WorkBuddy 的国内 / 国际站），
 * 省略取第一项。
 */
export const AccountLoginParamsSchema = z.object({
  kind: AccountKindSchema,
  ...AccountIdField,
  method: AccountLoginMethodSchema,
  upstream: z.string().min(1).optional(),
  option: z.string().min(1).max(64).optional(),
  apiKey: z.string().min(1).max(ACCOUNT_API_KEY_MAX_LENGTH).optional(),
});

/** `account.logout`；0.56.0 起可带 `upstream`，只断开这一家（省略时同以前：整个账号）。 */
export const AccountLogoutParamsSchema = AccountKindParamsSchema.extend({
  ...AccountIdField,
  upstream: z.string().min(1).optional(),
});

/**
 * `account.upstreams`（0.56.0，Host 功能 `subscription_upstreams`）：订阅来源后面能在应用内接的上游，常用的在前。引擎要起进程
 * 读，没装时报 `ENGINE_ERROR`。
 */
export const AccountUpstreamsResultSchema = z.object({
  upstreams: z.array(AccountUpstreamSchema),
});

export const AccountCancelLoginParamsSchema = z.object({
  kind: AccountKindSchema,
  ...AccountIdField,
  /** 省略时取消当前的登录；与当前的不符时什么都不做。 */
  loginId: z.string().min(1).optional(),
});

export const AccountResultSchema = z.object({
  account: AccountStateSchema,
});

/**
 * `account.add`（0.63.0，Host 功能 `subscription_accounts`）：给这种来源添加一个账号，未登录，凭据与会话在 Wevir 数据目录里
 * 单独的目录（与别的账号互不相通）。种类不能添加账号（状态没有 `multiAccount`）时 `INVALID_PARAMS`。
 */
export const AccountAddParamsSchema = z.object({
  kind: AccountKindSchema,
  label: AccountLabelSchema.optional(),
});

/**
 * `account.remove`（0.63.0）：删掉添加的账号：登出、关掉用它的会话，删它的 Provider、用量记录与它在数据目录里的整个目录。
 * 首个账号不能删（用 `account.logout` 或 `provider.setEnabled`），`INVALID_PARAMS`。
 */
export const AccountRemoveParamsSchema = z.object({
  id: ProviderIdSchema,
});

/** `account.setLabel`（0.63.0）：设或清掉（`null`）账号的标签；首个账号也能设。 */
export const AccountSetLabelParamsSchema = z.object({
  id: ProviderIdSchema,
  label: AccountLabelSchema.nullable(),
});

/** `account.updated` 通知：账号状态变了（登录开始、完成、失败、取消，登出，套餐或用量变化），带完整的状态。 */
export const AccountUpdatedParamsSchema = z.object({
  account: AccountStateSchema,
});

// ── provider.setEnabled（0.19.0） ──────────────────────────────────────

export const ProviderSetEnabledParamsSchema = z.object({
  providerId: ProviderIdSchema,
  enabled: z.boolean(),
});

export const ProviderResultSchema = z.object({
  provider: ProviderProfileSchema,
});

// ── session.* ─────────────────────────────────────────────────────────

/**
 * `session.fork`：从会话分出一个新会话。`side: true`（0.17.0，Host 功能 `side_sessions`）分出支线；不带 `side`（0.38.0，Host 功能
 * `session_branches`）是分支到新会话：普通的顶层会话，带着被分会话到 `turnId` 那个完成的回合为止的历史。`turnId` 省略时到最近一个
 * 完成的回合；支线不能带 `turnId`（`INVALID_PARAMS`）。
 */
export const SessionForkParamsSchema = z.object({
  sessionId: SessionIdSchema,
  side: z.literal(true).optional(),
  turnId: TurnIdSchema.optional(),
});

/**
 * `session.rewind`（0.38.0，Host 功能 `session_rewind`）：撤掉会话最后一个完成的回合（`turnId` 必须是它），引擎的上下文与消息记录
 * 一起回到这个回合之前；用来编辑重发最后一条用户消息。不改会话目录里的文件。写一条 `turn.rewound`。
 */
export const SessionRewindParamsSchema = z.object({
  sessionId: SessionIdSchema,
  turnId: TurnIdSchema,
});

export const SessionRewindResultSchema = z.object({
  seq: SeqSchema,
});

/**
 * `session.undo`（0.51.0，Host 功能 `session_undo`，domain-model §3.22）：撤销会话最后一个看得见的回合——会话目录里的文件还原到这个
 * 回合开始前（靠回合快照，§3.13），消息记录隐藏这个回合，引擎的上下文里补一条说明（引擎自己的历史不动）。`turnId` 给了就必须是那个
 * 回合。写一条 `turn.undone`。可以连着撤销更早的回合。
 */
export const SessionUndoParamsSchema = z.object({
  sessionId: SessionIdSchema,
  turnId: TurnIdSchema.optional(),
});

export const SessionUndoResultSchema = z.object({
  seq: SeqSchema,
  turnId: TurnIdSchema,
  files: FilesRestoreSchema,
});

/**
 * `session.redo`（0.51.0，Host 功能 `session_undo`）：重做最近撤销的回合——文件回到撤销之前的样子，回合回到消息记录里，引擎的上下文里
 * 补一条说明。要在撤销之后、会话没开始新回合时才行（否则 `INVALID_STATE`）。`turnId` 给了就必须是那个回合。写一条 `turn.redone`。
 */
export const SessionRedoParamsSchema = SessionUndoParamsSchema;
export const SessionRedoResultSchema = SessionUndoResultSchema;

/** 离开后摘要（0.54.0）的最短离开时间：客户端离开不足这么久不请求，Host 也不生成。 */
export const SESSION_RECAP_MIN_AWAY_MS = 3 * 60_000;

/**
 * `session.recap`（0.54.0，Host 功能 `session_recap`，domain-model §3.24）：用户回到一个离开过的会话时，客户端报告离开的情况，
 * Host 判断要不要生成一段摘要（用会话的模型，一次不带工具的请求）。`seenSeq` 是离开时客户端看到的最后一个事件，`awayMs` 是离开
 * 了多久。不写事件、不改会话：摘要只缓存在 Host 内存里，同一个位置只生成一次，并发的请求共用同一次生成。失败不抛错，回
 * `reason: 'failed'`。
 */
export const SessionRecapParamsSchema = z.object({
  sessionId: SessionIdSchema,
  seenSeq: SeqCursorSchema,
  awayMs: z.int().min(0),
});

/**
 * 有 `recap` 就是有摘要（刚生成的或缓存的）；没有时 `reason` 说为什么（开放字符串，已见：`disabled` 设置里关了、`too_short`
 * 离开得不够久、`no_activity` 离开期间没有新的助手输出、`running` 回合还在跑、`waiting` 有待审批或待回答的提问、`sub_session`
 * 子智能体或支线会话、`few_turns` 完整的回合不到 2 个、`detached` 引擎会话没挂着、`unsupported` 引擎不能生成、`failed` 生成失败或超时）。
 */
export const SessionRecapResultSchema = z.object({
  recap: SessionRecapSchema.optional(),
  reason: z.string().min(1).optional(),
});

/** 会话标题的最大长度（`session.rename`，0.23.0）。 */
export const SESSION_TITLE_MAX_LENGTH = 200;

/** 用户给会话改名（0.23.0）：去掉首尾空白后不能是空的。 */
export const SessionRenameParamsSchema = z.object({
  sessionId: SessionIdSchema,
  title: z.string().min(1).max(SESSION_TITLE_MAX_LENGTH),
});

/** 归档或取消归档（0.23.0）：归档前先关闭会话；取消归档不恢复，下次发送时照常恢复。 */
export const SessionArchiveParamsSchema = z.object({
  sessionId: SessionIdSchema,
  archived: z.boolean(),
});

/**
 * 永久删除一个已归档的会话（0.43.0，domain-model §3.20）：连同它的子会话与支线、文件、Host 开的 worktree 与引擎的数据。worktree
 * 有没提交的改动时不带 `force` 回 `RESOURCE_IN_USE`。
 */
export const SessionDeleteParamsSchema = z.object({
  sessionId: SessionIdSchema,
  force: z.boolean().optional(),
});

export const SessionDeleteResultSchema = z.object({
  /** 删掉的全部会话，这个会话在前，之后是它的子会话与支线。 */
  sessionIds: z.array(SessionIdSchema),
  /** 没合并、留下的 worktree 分支名。 */
  keptBranches: z.array(z.string().min(1)).optional(),
  /** 有引擎会话的数据没删掉（引擎不支持、Provider 已删或引擎报错）。 */
  engineDataKept: z.literal(true).optional(),
});

/** Host 为会话开的一个 worktree 占了多少（0.43.0）。 */
export const SessionWorktreeUsageSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  branch: z.string().min(1),
  /** worktree 的根目录。 */
  path: z.string().min(1),
  bytes: z.int().min(0),
  /** 有没提交的改动（跟踪文件的修改或没被忽略的未跟踪文件）。 */
  dirty: z.boolean(),
  /** 目录已经不在。 */
  missing: z.literal(true).optional(),
});
export type SessionWorktreeUsage = z.infer<typeof SessionWorktreeUsageSchema>;

/** 一个会话（含它的子会话与支线）占了多少（0.43.0）。 */
export const SessionUsageSchema = z.object({
  sessionId: SessionIdSchema,
  /** 事件 payload 的字节数。 */
  eventBytes: z.int().min(0),
  /** 历史文件、对话文件夹与只有这些会话引用的图片。 */
  fileBytes: z.int().min(0),
  worktrees: z.array(SessionWorktreeUsageSchema),
});
export type SessionUsage = z.infer<typeof SessionUsageSchema>;

/** 范围同 `session.list` 的顶层会话：默认不含已归档的，`archived: true` 只列它们。 */
export const SessionUsageParamsSchema = z.object({
  archived: z.boolean().optional(),
});

export const SessionUsageResultSchema = z.object({
  sessions: z.array(SessionUsageSchema),
});

/**
 * 代码审查（0.24.0，Host 功能 `session_review`）：开始一个由命令开始的回合（`turn.started` 的 `command`），审查结果是这个回合的
 * 回答。
 */
export const SessionReviewParamsSchema = z.object({
  sessionId: SessionIdSchema,
  target: ReviewTargetSchema,
});

/**
 * 设会话目标（0.35.0，Host 功能 `session_goals`）：替换原有的目标，以目标为用户消息开始第一个回合（`turn.started` 的 `trigger` 为
 * `goal`），之后引擎在会话空闲时自己开回合接着做，直到目标达成、暂停或受阻。结果同 `session.send`：回合与它的 `user.message` 的
 * `seq`。
 */
export const SessionSetGoalParamsSchema = z.object({
  sessionId: SessionIdSchema,
  /** 目标；Host 去掉首尾空白，之后不能是空的，最多 `GOAL_OBJECTIVE_MAX_CHARS` 字。 */
  objective: z
    .string()
    .refine((value) => value.trim() !== '', { message: 'objective is empty' })
    .refine((value) => [...value.trim()].length <= GOAL_OBJECTIVE_MAX_CHARS, {
      message: `at most ${GOAL_OBJECTIVE_MAX_CHARS} characters`,
    }),
  /** token 预算；省略表示不限。 */
  tokenBudget: z.int().positive().optional(),
});

/** 暂停或继续会话目标（0.35.0）：`active` 时会话空闲则引擎随即开回合接着做。 */
export const SessionUpdateGoalParamsSchema = z.object({
  sessionId: SessionIdSchema,
  status: z.enum(['active', 'paused']),
});

export const SessionGoalResultSchema = z.object({ goal: SessionGoalSchema });

/** `session.clearGoal`（0.35.0）的结果：`cleared` 为 `false` 表示本来就没有目标。 */
export const SessionClearGoalResultSchema = z.object({ cleared: z.boolean() });

/** `session.compact`（0.24.0）与 `session.review` 的结果：开始的回合与它的 `turn.started` 的 `seq`。 */
export const SessionCommandResultSchema = z.object({
  turnId: TurnIdSchema,
  seq: SeqSchema,
});

export const SessionCreateParamsSchema = z.object({
  /**
   * 省略（0.39.0，Host 功能 `chat_sessions`）：不在项目里的会话，建在 Host 的“对话”工作区（`kind: 'chats'`），工作目录是给它
   * 新建的空文件夹，不能带 `environmentId` 或 `worktree: 'new'`。给的是“对话”工作区时也一样。
   */
  workspaceId: WorkspaceIdSchema.optional(),
  providerId: ProviderIdSchema,
  /** 省略时用 Provider 的 `defaultModelId`。 */
  modelId: z.string().min(1).optional(),
  reasoningEffort: z.string().min(1).optional(),
  /** 权限模式（0.11.0，Host 功能 `permission_modes`）；省略时是 `on_request`。 */
  permissionMode: PermissionModeSchema.optional(),
  /** 用这个环境建（0.15.0，Host 功能 `environments`）：`workspaceId` 必须是它的主文件夹。 */
  environmentId: EnvironmentIdSchema.optional(),
  /**
   * `new`：在工作区的仓库里给这个会话新开一个 git worktree（0.18.0，Host 功能 `session_worktree`，domain-model §3.10）；
   * 省略或 `none`：用工作区目录本身。不能与 `environmentId` 同时给（环境按文件夹定）。
   */
  worktree: WorktreeModeSchema.optional(),
  /** 从一项建议开出来（0.16.0，Host 功能 `suggested_tasks`）。 */
  origin: SessionOriginSchema.optional(),
  /**
   * 工具预设（0.61.0，Host 功能 `tool_presets`）：这个会话给模型看哪些 Wevir 应用级工具，建好后不能改。省略时不选（等同 `full`）。
   * 旧 Host 不认这个字段（会忽略），客户端要先看功能位。
   */
  toolPreset: ToolPresetSchema.optional(),
});

export const SessionResultSchema = z.object({
  session: SessionSchema,
});

/**
 * 换会话的模型、推理档位（0.9.0，Host 功能 `session_configure`）或权限模式（0.11.0，Host 功能 `permission_modes`）：从下一个
 * 回合起生效，进行中的回合不受影响。只能在会话所用 Provider 的模型里换（Provider 列了模型时）；不换 Provider。
 */
export const SessionConfigureParamsSchema = z.object({
  sessionId: SessionIdSchema,
  /**
   * 换到别的 Provider（0.25.0，Host 功能 `session_handoff`）：接力，`modelId` 省略时用它的默认模型（domain-model §3.14）。省略或
   * 与会话当前的相同：不换。
   */
  providerId: ProviderIdSchema.optional(),
  /** 省略：不改。 */
  modelId: z.string().min(1).optional(),
  /** 省略：不改；null：清掉，用模型的默认档位。换了模型而没给它时也清掉。 */
  reasoningEffort: z.string().min(1).nullable().optional(),
  /** 省略：不改。 */
  permissionMode: PermissionModeSchema.optional(),
  /**
   * 接力时额外交给新来源的材料（0.59.0，Host 功能 `handoff_material`）：必须携带的约束与选入的笔记。只在换到别的 Provider 时起作用；
   * 旧 Host 不认这个字段（会忽略），客户端要先看功能位。0.60.0（Host 功能 `handoff_preview`）起可带预览的 `binding`：Host 重算的
   * 材料与它不符（之后有了新事件、笔记改了或停用、目标或方式变了），或要接着用的引擎会话恢复不了时回 `HANDOFF_STALE`，不切换。
   */
  handoff: HandoffConfigureSchema.optional(),
});

/**
 * 接力预览（0.60.0，Host 功能 `handoff_preview`）：会话换到 `providerId` 时会交出的材料，只读。前提与 `session.configure` 的接力
 * 相同（同一个 Provider、回合进行中、支线、子会话、额外目录与笔记的限制照样报错）。
 */
export const SessionHandoffPreviewParamsSchema = z.object({
  sessionId: SessionIdSchema,
  providerId: ProviderIdSchema,
  handoff: HandoffMaterialRequestSchema.optional(),
});

export const SessionHandoffPreviewResultSchema = z.object({
  preview: HandoffPreviewSchema,
  /** 正式切换时放进 `handoff.binding`；超出预算时没有。 */
  binding: HandoffBindingSchema.optional(),
});

export const SessionListParamsSchema = z.object({
  /** 省略时列出所有未移除工作区的会话。 */
  workspaceId: WorkspaceIdSchema.optional(),
  /**
   * 给了就只列出这个会话的子会话（0.6.0）；不给时不含子会话（domain-model §3.3.1）。
   */
  parentSessionId: SessionIdSchema.optional(),
  /** 归档（0.23.0）：`true` 只列已归档的会话；省略或 `false` 时不含已归档的。 */
  archived: z.boolean().optional(),
});

export const SessionListResultSchema = z.object({
  /** 按 `updatedAt` 从新到旧。 */
  sessions: z.array(SessionSchema),
});

export const SessionIdParamsSchema = z.object({
  sessionId: SessionIdSchema,
});

export const SessionSendParamsSchema = z.object({
  sessionId: SessionIdSchema,
  content: z.array(UserContentPartSchema).min(1),
  /** 幂等键：同一会话里同一 ID 重发返回原结果，不再发给引擎；请求体不同则 `CLIENT_MESSAGE_CONFLICT`。 */
  clientMessageId: ClientTokenSchema.optional(),
  /**
   * 回合进行中怎样送达（0.8.0，domain-model §4.6）：`steer` 插话、`queue` 排队，成为待发消息。省略时
   * 回合进行中回 `SESSION_BUSY`（旧客户端的行为）。会话空闲时不起作用。
   */
  delivery: PendingDeliverySchema.optional(),
  /**
   * 协作模式（0.36.0，Host 功能 `plan_mode`）：`plan` 让这个回合在计划模式里跑；省略或 `default` 照常。排队的消息带着它，插话时
   * 不起作用。会话当前的引擎没有计划模式（`engineFeatures` 的 `planMode`）时 `INVALID_PARAMS`。
   */
  collaborationMode: CollaborationModeSchema.optional(),
});

export const SessionSendResultSchema = z.object({
  /** 开始的回合；成为待发消息时没有（0.8.0）。 */
  turnId: TurnIdSchema.optional(),
  /** 成为待发消息时有（0.8.0）。 */
  pendingId: PendingMessageIdSchema.optional(),
  /** 本次 `user.message`（成为待发消息时是 `pending.added`）事件的 `seq`。 */
  seq: SeqSchema,
});

// ── pending.*（0.8.0） ─────────────────────────────────────────────

export const PendingUpdateParamsSchema = z.object({
  sessionId: SessionIdSchema,
  pendingId: PendingMessageIdSchema,
  /** 新的内容；只有排队的与暂停的能改。 */
  content: z.array(UserContentPartSchema).min(1).optional(),
  /** 新的方式（domain-model §4.6）。 */
  delivery: PendingDeliverySchema.optional(),
});

export const PendingIdParamsSchema = z.object({
  sessionId: SessionIdSchema,
  pendingId: PendingMessageIdSchema,
});

export const PendingResultSchema = z.object({
  pending: PendingMessageSchema,
});

export const PendingListResultSchema = z.object({
  /** 未到终态的待发消息，按加入的先后。 */
  pendingMessages: z.array(PendingMessageSchema),
});

// ── web.*（0.34.0） ─────────────────────────────────────────────────

export const WebResultSchema = z.object({
  web: WebSettingsSchema,
});

/** Key 的上限（字符）。 */
export const WEB_API_KEY_MAX_LENGTH = 512;

export const WebUpdateParamsSchema = z.object({
  enabled: z.boolean().optional(),
  /** 要是 `services` 里的一个，否则 `INVALID_PARAMS`。 */
  searchService: WebSearchServiceIdSchema.optional(),
  /** 存一个服务的 Key；`apiKey: null` 删掉。Key 去掉首尾空白后不能为空。 */
  key: z
    .object({
      service: WebSearchServiceIdSchema,
      apiKey: z.string().min(1).max(WEB_API_KEY_MAX_LENGTH).nullable(),
    })
    .optional(),
});

export const WebTestParamsSchema = z.object({
  /** 省略时测当前选中的服务。 */
  service: WebSearchServiceIdSchema.optional(),
  /** 省略时用存着的 Key；给了就用它测（还没保存的 Key），不存。 */
  apiKey: z.string().min(1).max(WEB_API_KEY_MAX_LENGTH).optional(),
});

/**
 * `web.test` 失败的原因：missing_key 没有 Key、没发请求；auth Key 不对（401 / 403 里的鉴权失败）；quota 余额或额度用完；
 * rate_limited 请求太频繁；network 连不上；timeout 时限内没有响应；server 服务端出错（5xx）；invalid_response 回的不是这家
 * 服务的格式；unknown 其他。
 */
export const WebTestFailureSchema = z.enum([
  'missing_key',
  'auth',
  'quota',
  'rate_limited',
  'network',
  'timeout',
  'server',
  'invalid_response',
  'unknown',
]);
export type WebTestFailure = z.infer<typeof WebTestFailureSchema>;

/** 用一次真实的搜索测试服务与 Key。 */
export const WebTestResultSchema = z.object({
  ok: z.boolean(),
  service: WebSearchServiceIdSchema,
  latencyMs: z.int().min(0).optional(),
  /** 成功时这次搜索返回了几条。 */
  results: z.int().min(0).optional(),
  /** `ok` 为 false 时有。 */
  reason: WebTestFailureSchema.optional(),
  /** 服务端返回的 HTTP 状态码；没有收到响应时省略。 */
  httpStatus: z.int().min(100).max(599).optional(),
  /** 服务端的原文（不含 Key），只作诊断。 */
  message: z.string().optional(),
});
export type WebTestResult = z.infer<typeof WebTestResultSchema>;

// ── memory.*（0.57.0） ──────────────────────────────────────────────

/**
 * 用户管理跨会话记忆（Host 功能 `memory`，domain-model §3.21）：全局的与某个项目（工作区）的笔记。笔记按名字认，范围是
 * `project` 时要给 `workspaceId`（工作区要在、没被移除，“对话”工作区也算），`global` 时不看它。不暴露文件路径。
 */
const MemoryTarget = {
  scope: MemoryScopeSchema,
  workspaceId: WorkspaceIdSchema.optional(),
  name: MemoryNameSchema,
};

export const MemoryListParamsSchema = z.object({
  /** 省略时只列全局的。 */
  workspaceId: WorkspaceIdSchema.optional(),
});

/** 不分页：每个范围最多 `MEMORY_MAX_PER_SCOPE` 条，一次给全，启用的与停用的都在。最近更新的在前。 */
export const MemoryListResultSchema = z.object({
  notes: z.array(MemorySummarySchema),
  /** 读不出来的笔记文件（格式坏了）：Agent 用不到它们，用户可以按名字删掉。 */
  unreadable: z.array(z.object({ scope: MemoryScopeSchema, name: MemoryNameSchema })),
});

/** 读一条（含停用的）。0.58.0 起结果里带 Agent 来源的 `origin` / `lastEdit` 有 `status`：来源会话还在没有、那个回合撤回了没有。 */
export const MemoryReadParamsSchema = z.object(MemoryTarget);

export const MemoryNoteResultSchema = z.object({
  note: MemoryNoteSchema,
});

/**
 * 用户改一条笔记：只改给出的字段，`updatedAt` 换成现在，`lastEdit` 记成 `by: 'user'`（0.58.0）。`revision` 是编辑基于的那一版；笔记在那之后被改过（Agent 存了、
 * 另一个窗口改了）就不写，结果带 `conflict` 与现在的版本，客户端留着草稿让用户决定。字段的规则同 Agent 保存：说明一行、
 * 不超过 `MEMORY_DESCRIPTION_MAX` 字，正文不空、不超过 `MEMORY_CONTENT_MAX_BYTES` 字节，像密钥的内容拒绝（`INVALID_PARAMS`）。
 */
export const MemoryUpdateParamsSchema = z.object({
  ...MemoryTarget,
  revision: z.string().min(1),
  type: MemoryTypeSchema.optional(),
  description: z.string().optional(),
  content: z.string().optional(),
});

export const MemoryUpdateResultSchema = z.object({
  /** 写好的这一版；冲突时是现在的版本（没写）。 */
  note: MemoryNoteSchema,
  conflict: z.literal(true).optional(),
});

/** 启用或停用：不改正文与 `updatedAt`。停用后新会话的清单与 Agent 的工具都看不到它。 */
export const MemorySetEnabledParamsSchema = z.object({
  ...MemoryTarget,
  enabled: z.boolean(),
});

/**
 * 删掉一条笔记。带 `revision` 时笔记在那之后被改过就不删，结果带 `conflict` 与现在的版本；读不出来的文件没有版本，不带
 * `revision` 删。
 */
export const MemoryDeleteParamsSchema = z.object({
  ...MemoryTarget,
  revision: z.string().min(1).optional(),
});

export const MemoryDeleteResultSchema = z.object({
  conflict: z.literal(true).optional(),
  note: MemoryNoteSchema.optional(),
});

/**
 * `tools.presets`（0.61.0，Host 功能 `tool_presets`）：可选的工具预设（各自总带的组）与每个组在这个 Host 上实际有的工具，只读。客户端
 * 用它显示一个预设带来哪些组、大约几个工具；`core` 可以另加的组是 `full` 的组去掉 `core` 的。只是 Wevir 应用级工具的数目，不含
 * 引擎自带的工具与用户接入的 MCP。
 */
export const ToolsPresetsResultSchema = z.object({
  presets: z.array(ToolPresetInfoSchema),
  groups: z.array(ToolGroupInfoSchema),
});

/**
 * `memory.changed` 通知：某个范围的笔记变了（用户或 Agent 存、改、启停、删）。发给调用过 `memory.*` 的连接，客户端重读它在看的
 * 范围。手改笔记文件不会触发。
 */
export const MemoryChangedParamsSchema = z.object({
  scope: MemoryScopeSchema,
  /** 范围是 `project` 时有。 */
  workspaceId: WorkspaceIdSchema.optional(),
  name: MemoryNameSchema.optional(),
});

// ── image.*（0.28.0） ───────────────────────────────────────────────

/** 一张图片的字节上限（同 T3 Code 的 `PROVIDER_SEND_TURN_MAX_IMAGE_BYTES`）。 */
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** `image.upload` 的 `data`（base64）的长度上限。 */
export const IMAGE_UPLOAD_DATA_MAX_LENGTH = Math.ceil(IMAGE_MAX_BYTES / 3) * 4;
/** 一条消息最多带几张图片。 */
export const IMAGE_MAX_PER_MESSAGE = 10;
/** `image.read` 一次最多读的字节数；base64 之后仍在连接的发送缓冲之内，更大的图片分几次读。 */
export const IMAGE_READ_CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * 存一张图片，之后放进 `session.send` / `pending.update` 的 `content`。Host 按文件头认格式（要与 `mimeType` 一致）、读出
 * 像素；没有发出去的图片过一天删掉。
 */
export const ImageUploadParamsSchema = z.object({
  mimeType: UserImageMimeTypeSchema,
  /** base64，解码后不超过 `IMAGE_MAX_BYTES`。 */
  data: z.string().min(1).max(IMAGE_UPLOAD_DATA_MAX_LENGTH),
  name: z.string().min(1).max(255).optional(),
});

export const ImageUploadResultSchema = z.object({
  image: UserImagePartSchema,
});

export const ImageReadParamsSchema = z.object({
  imageId: ImageIdSchema,
  /** 从第几个字节读起，默认 0。 */
  offset: z.int().min(0).optional(),
});

/** 一段字节：`offset` 起最多 `IMAGE_READ_CHUNK_BYTES`；`offset + 解码后的长度 < size` 时接着读。 */
export const ImageReadResultSchema = z.object({
  imageId: ImageIdSchema,
  mimeType: UserImageMimeTypeSchema,
  size: z.int().min(1),
  offset: z.int().min(0),
  /** base64。 */
  data: z.string(),
});

// ── approval.* ────────────────────────────────────────────────────────

// ── question.*（0.10.0） ─────────────────────────────────────────────

export const QuestionRespondParamsSchema = z.object({
  questionId: QuestionIdSchema,
  /** 按问题 ID 的回答；没回答的问题可以省略（当作跳过）。 */
  answers: z.record(z.string(), QuestionAnswerSchema),
});

export const QuestionRespondResultSchema = z.object({
  questionId: QuestionIdSchema,
  status: z.enum(['answered', 'cancelled']),
  resolution: QuestionResolutionSchema,
});

export const ApprovalRespondParamsSchema = z.object({
  approvalId: ApprovalIdSchema,
  /** 必须是该审批 `options` 里的一个，否则 `INVALID_PARAMS`。 */
  optionId: z.string().min(1),
});

export const ApprovalRespondResultSchema = z.object({
  approvalId: ApprovalIdSchema,
  status: ResolvedApprovalStatusSchema,
  resolution: ApprovalResolutionSchema,
});

// ── events.* ──────────────────────────────────────────────────────────

export const EventsSubscribeParamsSchema = z.object({
  sessionId: SessionIdSchema,
  /** 补发 `seq > sinceSeq` 的事件；0 = 从头开始。 */
  sinceSeq: SeqCursorSchema,
});

export const EventsSubscribeResultSchema = z.object({
  subscriptionId: SubscriptionIdSchema,
  /** 回放结束标记：订阅建立时会话的 `lastSeq`。客户端应用到这个 `seq` 即追平，之后都是实时事件。 */
  replayedThroughSeq: SeqCursorSchema,
});

export const EventsUnsubscribeParamsSchema = z.object({
  subscriptionId: SubscriptionIdSchema,
});

/** `events.event` 通知的参数：每条通知一个事件。 */
export const EventsEventParamsSchema = z.object({
  subscriptionId: SubscriptionIdSchema,
  event: WevirEventSchema,
});

// ── browser.*（0.33.0，内置浏览器） ────────────────────────────────────

/** 登记为浏览器提供方：`commands` 是它会的命令（`BROWSER_COMMANDS`），认不出的名字 Host 忽略。 */
export const BrowserRegisterParamsSchema = z.object({
  commands: z.array(z.string().min(1).max(64)).min(1).max(64),
});

export const BrowserRespondParamsSchema = BrowserResponseSchema;

/** `accepted: false`：请求已经超时、被取消，或不是交给这条连接的，回答被丢掉。 */
export const BrowserRespondResultSchema = z.object({ accepted: z.boolean() });

/** `browser.request` 通知的参数。 */
export const BrowserRequestParamsSchema = BrowserRequestSchema;

// ── 注册表 ────────────────────────────────────────────────────────────

export interface MethodSpec {
  params: z.ZodType;
  result: z.ZodType;
  /** 调用所需权限；null = 不需要（握手与心跳）。 */
  permission: Permission | null;
}

/**
 * 客户端 → Host 的方法注册表，Host 与 client-sdk 共用。键是方法名，顺序与 host-api.md 的方法表一致。
 * 除 `host.hello` 外，所有方法都要求本连接已完成 hello。
 */
export const MethodSchemas = {
  ...PluginMethodSchemas,
  'host.hello': {
    params: HostHelloParamsSchema,
    result: HostHelloResultSchema,
    permission: null,
  },
  'host.ping': { params: EmptySchema, result: EmptySchema, permission: null },
  'host.shutdown': { params: EmptySchema, result: EmptySchema, permission: 'host.manage' },
  'settings.get': {
    params: EmptySchema,
    result: SettingsResultSchema,
    permission: 'session.read',
  },
  'settings.update': {
    params: SettingsUpdateParamsSchema,
    result: SettingsResultSchema,
    permission: 'host.manage',
  },

  'workspace.list': {
    params: EmptySchema,
    result: WorkspaceListResultSchema,
    permission: 'workspace.read',
  },
  'workspace.add': {
    params: WorkspaceAddParamsSchema,
    result: WorkspaceAddResultSchema,
    permission: 'workspace.write',
  },
  'workspace.remove': {
    params: WorkspaceRemoveParamsSchema,
    result: EmptySchema,
    permission: 'workspace.write',
  },
  'workspace.update': {
    params: WorkspaceUpdateParamsSchema,
    result: WorkspaceUpdateResultSchema,
    permission: 'workspace.write',
  },
  'environment.list': {
    params: EmptySchema,
    result: EnvironmentListResultSchema,
    permission: 'workspace.read',
  },
  'environment.create': {
    params: EnvironmentCreateParamsSchema,
    result: EnvironmentResultSchema,
    permission: 'workspace.write',
  },
  'environment.update': {
    params: EnvironmentUpdateParamsSchema,
    result: EnvironmentResultSchema,
    permission: 'workspace.write',
  },
  'environment.remove': {
    params: EnvironmentIdParamsSchema,
    result: EmptySchema,
    permission: 'workspace.write',
  },
  'workspace.git': {
    params: WorkspaceGitParamsSchema,
    result: WorkspaceGitResultSchema,
    permission: 'workspace.read',
  },
  'workspace.diff': {
    params: WorkspaceDiffParamsSchema,
    result: WorkspaceDiffResultSchema,
    permission: 'workspace.read',
  },
  'workspace.diffFile': {
    params: WorkspaceDiffFileParamsSchema,
    result: WorkspaceDiffFileResultSchema,
    permission: 'workspace.read',
  },
  'workspace.files': {
    params: WorkspaceFilesParamsSchema,
    result: WorkspaceFilesResultSchema,
    permission: 'workspace.read',
  },
  'workspace.listDir': {
    params: WorkspaceListDirParamsSchema,
    result: WorkspaceListDirResultSchema,
    permission: 'workspace.read',
  },
  'workspace.readFile': {
    params: WorkspaceReadFileParamsSchema,
    result: WorkspaceReadFileResultSchema,
    permission: 'workspace.read',
  },
  'workspace.fileUrl': {
    params: WorkspaceFileUrlParamsSchema,
    result: WorkspaceFileUrlResultSchema,
    permission: 'workspace.read',
  },
  'workspace.writeFile': {
    params: WorkspaceWriteFileParamsSchema,
    result: WorkspaceWriteFileResultSchema,
    permission: 'workspace.write',
  },

  'provider.list': {
    params: EmptySchema,
    result: ProviderListResultSchema,
    permission: 'provider.read',
  },
  'provider.upsert': {
    params: ProviderUpsertParamsSchema,
    result: ProviderUpsertResultSchema,
    permission: 'provider.write',
  },
  'provider.remove': {
    params: ProviderIdParamsSchema,
    result: EmptySchema,
    permission: 'provider.write',
  },
  'provider.test': {
    params: ProviderTestParamsSchema,
    result: ProviderTestResultSchema,
    permission: 'provider.write',
  },
  'provider.discoverModels': {
    params: ProviderDiscoverModelsParamsSchema,
    result: ProviderDiscoverModelsResultSchema,
    permission: 'provider.write',
  },

  'provider.setEnabled': {
    params: ProviderSetEnabledParamsSchema,
    result: ProviderResultSchema,
    permission: 'provider.write',
  },

  'account.list': {
    params: EmptySchema,
    result: AccountListResultSchema,
    permission: 'provider.read',
  },
  'account.get': {
    params: AccountGetParamsSchema,
    result: AccountResultSchema,
    permission: 'provider.read',
  },
  'account.login': {
    params: AccountLoginParamsSchema,
    result: AccountResultSchema,
    permission: 'provider.write',
  },
  'account.cancelLogin': {
    params: AccountCancelLoginParamsSchema,
    result: AccountResultSchema,
    permission: 'provider.write',
  },
  'account.logout': {
    params: AccountLogoutParamsSchema,
    result: AccountResultSchema,
    permission: 'provider.write',
  },
  'account.upstreams': {
    params: AccountKindParamsSchema,
    result: AccountUpstreamsResultSchema,
    permission: 'provider.read',
  },
  'account.setPath': {
    params: AccountSetPathParamsSchema,
    result: AccountResultSchema,
    permission: 'host.manage',
  },
  'account.install': {
    params: AccountKindParamsSchema,
    result: AccountResultSchema,
    permission: 'provider.write',
  },
  'account.add': {
    params: AccountAddParamsSchema,
    result: AccountResultSchema,
    permission: 'provider.write',
  },
  'account.remove': {
    params: AccountRemoveParamsSchema,
    result: EmptySchema,
    permission: 'provider.write',
  },
  'account.setLabel': {
    params: AccountSetLabelParamsSchema,
    result: AccountResultSchema,
    permission: 'provider.write',
  },

  'session.create': {
    params: SessionCreateParamsSchema,
    result: SessionResultSchema,
    permission: 'session.write',
  },
  'session.list': {
    params: SessionListParamsSchema,
    result: SessionListResultSchema,
    permission: 'session.read',
  },
  'session.get': {
    params: SessionIdParamsSchema,
    result: SessionSnapshotSchema,
    permission: 'session.read',
  },
  'session.configure': {
    params: SessionConfigureParamsSchema,
    result: SessionResultSchema,
    permission: 'session.write',
  },
  'session.handoffPreview': {
    params: SessionHandoffPreviewParamsSchema,
    result: SessionHandoffPreviewResultSchema,
    permission: 'session.read',
  },
  'session.send': {
    params: SessionSendParamsSchema,
    result: SessionSendResultSchema,
    permission: 'session.write',
  },
  'session.cancel': {
    params: SessionIdParamsSchema,
    result: EmptySchema,
    permission: 'session.write',
  },
  'session.close': {
    params: SessionIdParamsSchema,
    result: EmptySchema,
    permission: 'session.write',
  },
  'session.resume': {
    params: SessionIdParamsSchema,
    result: SessionResultSchema,
    permission: 'session.write',
  },
  'session.fork': {
    params: SessionForkParamsSchema,
    result: SessionResultSchema,
    permission: 'session.write',
  },
  'session.rewind': {
    params: SessionRewindParamsSchema,
    result: SessionRewindResultSchema,
    permission: 'session.write',
  },
  'session.undo': {
    params: SessionUndoParamsSchema,
    result: SessionUndoResultSchema,
    permission: 'session.write',
  },
  'session.redo': {
    params: SessionRedoParamsSchema,
    result: SessionRedoResultSchema,
    permission: 'session.write',
  },
  'session.recap': {
    params: SessionRecapParamsSchema,
    result: SessionRecapResultSchema,
    permission: 'session.read',
  },
  'session.compact': {
    params: SessionIdParamsSchema,
    result: SessionCommandResultSchema,
    permission: 'session.write',
  },
  'session.review': {
    params: SessionReviewParamsSchema,
    result: SessionCommandResultSchema,
    permission: 'session.write',
  },
  'session.setGoal': {
    params: SessionSetGoalParamsSchema,
    result: SessionCommandResultSchema,
    permission: 'session.write',
  },
  'session.updateGoal': {
    params: SessionUpdateGoalParamsSchema,
    result: SessionGoalResultSchema,
    permission: 'session.write',
  },
  'session.clearGoal': {
    params: SessionIdParamsSchema,
    result: SessionClearGoalResultSchema,
    permission: 'session.write',
  },
  'session.rename': {
    params: SessionRenameParamsSchema,
    result: SessionResultSchema,
    permission: 'session.write',
  },
  'session.archive': {
    params: SessionArchiveParamsSchema,
    result: SessionResultSchema,
    permission: 'session.write',
  },
  'session.delete': {
    params: SessionDeleteParamsSchema,
    result: SessionDeleteResultSchema,
    permission: 'session.write',
  },
  'session.usage': {
    params: SessionUsageParamsSchema,
    result: SessionUsageResultSchema,
    permission: 'session.read',
  },
  'session.checkpoints': {
    params: SessionCheckpointsParamsSchema,
    result: SessionCheckpointsResultSchema,
    permission: 'session.read',
  },
  'pending.update': {
    params: PendingUpdateParamsSchema,
    result: PendingResultSchema,
    permission: 'session.write',
  },
  'pending.cancel': {
    params: PendingIdParamsSchema,
    result: PendingResultSchema,
    permission: 'session.write',
  },
  'pending.resume': {
    params: SessionIdParamsSchema,
    result: PendingListResultSchema,
    permission: 'session.write',
  },

  'image.upload': {
    params: ImageUploadParamsSchema,
    result: ImageUploadResultSchema,
    permission: 'session.write',
  },
  'image.read': {
    params: ImageReadParamsSchema,
    result: ImageReadResultSchema,
    permission: 'session.read',
  },

  'web.get': {
    params: EmptySchema,
    result: WebResultSchema,
    permission: 'session.read',
  },
  'web.update': {
    params: WebUpdateParamsSchema,
    result: WebResultSchema,
    permission: 'host.manage',
  },
  'web.test': {
    params: WebTestParamsSchema,
    result: WebTestResultSchema,
    permission: 'host.manage',
  },

  'memory.list': {
    params: MemoryListParamsSchema,
    result: MemoryListResultSchema,
    permission: 'session.read',
  },
  'memory.read': {
    params: MemoryReadParamsSchema,
    result: MemoryNoteResultSchema,
    permission: 'session.read',
  },
  'memory.update': {
    params: MemoryUpdateParamsSchema,
    result: MemoryUpdateResultSchema,
    permission: 'host.manage',
  },
  'memory.setEnabled': {
    params: MemorySetEnabledParamsSchema,
    result: MemoryNoteResultSchema,
    permission: 'host.manage',
  },
  'memory.delete': {
    params: MemoryDeleteParamsSchema,
    result: MemoryDeleteResultSchema,
    permission: 'host.manage',
  },

  'tools.presets': {
    params: EmptySchema,
    result: ToolsPresetsResultSchema,
    permission: 'session.read',
  },

  'usage.summary': {
    params: UsageSummaryParamsSchema,
    result: UsageSummaryResultSchema,
    permission: 'session.read',
  },
  'usage.records': {
    params: UsageRecordsParamsSchema,
    result: UsageRecordsResultSchema,
    permission: 'session.read',
  },
  'usage.pricing': {
    params: UsagePricingParamsSchema,
    result: UsagePricingResultSchema,
    permission: 'session.read',
  },

  'checks.list': {
    params: ChecksListParamsSchema,
    result: ChecksListResultSchema,
    permission: 'workspace.read',
  },
  'checks.candidates': {
    params: ChecksCandidatesParamsSchema,
    result: ChecksCandidatesResultSchema,
    permission: 'workspace.read',
  },
  'checks.save': {
    params: ChecksSaveParamsSchema,
    result: ChecksSaveResultSchema,
    permission: 'workspace.write',
  },
  'checks.remove': {
    params: ChecksRemoveParamsSchema,
    result: ChecksRemoveResultSchema,
    permission: 'workspace.write',
  },
  'checks.setRepair': {
    params: ChecksSetRepairParamsSchema,
    result: ChecksSetRepairResultSchema,
    permission: 'workspace.write',
  },
  'verification.run': {
    params: VerificationRunParamsSchema,
    result: VerificationRunResultSchema,
    permission: 'session.write',
  },
  'verification.cancel': {
    params: VerificationCancelParamsSchema,
    result: VerificationCancelResultSchema,
    permission: 'session.write',
  },
  'verification.status': {
    params: VerificationStatusParamsSchema,
    result: VerificationStatusResultSchema,
    permission: 'session.read',
  },
  'verification.output': {
    params: VerificationOutputParamsSchema,
    result: VerificationOutputResultSchema,
    permission: 'session.read',
  },
  'automation.list': {
    params: AutomationListParamsSchema,
    result: AutomationListResultSchema,
    permission: 'session.read',
  },
  'automation.get': {
    params: AutomationGetParamsSchema,
    result: AutomationGetResultSchema,
    permission: 'session.read',
  },
  'automation.create': {
    params: AutomationCreateParamsSchema,
    result: AutomationResultSchema,
    permission: 'session.write',
  },
  'automation.update': {
    params: AutomationUpdateParamsSchema,
    result: AutomationResultSchema,
    permission: 'session.write',
  },
  'automation.delete': {
    params: AutomationDeleteParamsSchema,
    result: AutomationDeleteResultSchema,
    permission: 'session.write',
  },
  'automation.run': {
    params: AutomationRunParamsSchema,
    result: AutomationRunResultSchema,
    permission: 'session.write',
  },

  'question.respond': {
    params: QuestionRespondParamsSchema,
    result: QuestionRespondResultSchema,
    permission: 'session.write',
  },
  'approval.respond': {
    params: ApprovalRespondParamsSchema,
    result: ApprovalRespondResultSchema,
    permission: 'session.write',
  },

  'browser.register': {
    params: BrowserRegisterParamsSchema,
    result: EmptySchema,
    permission: 'host.manage',
  },
  'browser.unregister': {
    params: EmptySchema,
    result: EmptySchema,
    permission: 'host.manage',
  },
  'browser.respond': {
    params: BrowserRespondParamsSchema,
    result: BrowserRespondResultSchema,
    permission: 'host.manage',
  },

  'events.subscribe': {
    params: EventsSubscribeParamsSchema,
    result: EventsSubscribeResultSchema,
    permission: 'session.read',
  },
  'events.unsubscribe': {
    params: EventsUnsubscribeParamsSchema,
    result: EmptySchema,
    permission: 'session.read',
  },
} as const satisfies Record<string, MethodSpec>;

export type MethodName = keyof typeof MethodSchemas;
export type MethodParams<M extends MethodName> = z.infer<(typeof MethodSchemas)[M]['params']>;
export type MethodResult<M extends MethodName> = z.infer<(typeof MethodSchemas)[M]['result']>;

export const METHOD_NAMES = Object.keys(MethodSchemas) as MethodName[];

export function isMethodName(method: string): method is MethodName {
  return Object.hasOwn(MethodSchemas, method);
}

/** Host → 客户端的通知注册表。 */
export const NotificationSchemas = {
  'plugins.changed': { params: z.object({}) },
  'events.event': { params: EventsEventParamsSchema },
  /** 发给调用过 `account.*` 方法的连接（0.7.0）。 */
  'account.updated': { params: AccountUpdatedParamsSchema },
  /** 发给调用过 `settings.*` 的连接（0.8.0）。 */
  'settings.updated': { params: SettingsUpdatedParamsSchema },
  /** 发给调用过 `memory.*` 的连接（0.57.0）。 */
  'memory.changed': { params: MemoryChangedParamsSchema },
  /** 发给调用过 `usage.*` 的连接（0.62.0）。 */
  'usage.changed': { params: UsageChangedParamsSchema },
  /** 发给调用过 `automation.*` 的连接（0.66.0）。 */
  'automation.changed': { params: AutomationChangedParamsSchema },
  /** 发给用 `browser.register` 登记过的连接（0.33.0）：请它执行一个浏览器命令，用 `browser.respond` 回答。 */
  'browser.request': { params: BrowserRequestParamsSchema },
} as const satisfies Record<string, { params: z.ZodType }>;

export type NotificationName = keyof typeof NotificationSchemas;
export type NotificationParams<N extends NotificationName> = z.infer<
  (typeof NotificationSchemas)[N]['params']
>;

export const NOTIFICATION_NAMES = Object.keys(NotificationSchemas) as NotificationName[];
