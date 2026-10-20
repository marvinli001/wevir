import { z } from 'zod';
import { WorkspaceIdSchema } from './common.js';
import { MemoryNameSchema, MemoryScopeSchema, MemoryTypeSchema } from './entities.js';
import { ConnectorNameSchema, ImportAppSchema, McpServerViewSchema } from './plugins.js';

// ── 从其他应用导入（0.74.0，Host 功能 `external_import`） ─────────────────────
//
// Host 读本机用户自己的 Claude Code、Codex、Grok Build、Antigravity 目录，列出能导入的记忆、MCP 服务器与 skills（`import.scan`），
// 用户勾选后再由 Host 重新读源文件写入（`import.apply`）。只增不改：不覆盖 Wevir 里已有的同名条目；MCP 的环境变量与请求头只带键名，
// 值一律留空，OAuth 令牌不读。客户端只传候选的 `key`，内容总由 Host 从源文件读，客户端不能借导入写入任意内容。

/** 候选的种类。 */
export const ImportKindSchema = z.enum(['memory', 'connector', 'skill']);
export type ImportKind = z.infer<typeof ImportKindSchema>;

/**
 * 与建议的导入目标比较（扫描时算）：`new` 目标里没有同名的；`exists` 有同名但内容不同，导入要换名字；`same` 已有内容相同的，
 * 不用再导。目标换了（另选项目）以 `import.apply` 的结果为准。
 */
export const ImportCandidateStatusSchema = z.enum(['new', 'exists', 'same']);
export type ImportCandidateStatus = z.infer<typeof ImportCandidateStatusSchema>;

const candidate = {
  /** Host 给的不透明标识，同一份源文件、同一条目每次扫描都一样。 */
  key: z.string().min(1).max(256),
  /** 源文件的绝对路径。 */
  path: z.string().min(1),
  status: ImportCandidateStatusSchema,
  /**
   * 不能导入的原因，开放字符串：`too_large`（超过记忆正文上限）、`looks_secret`（像是密钥）、`invalid`（读不懂或字段不合规）、
   * `unsupported_transport`（Wevir 不支持的 MCP 传输方式）。有它时 `import.apply` 一定失败。
   */
  problem: z.string().min(1).optional(),
  /** 建议默认勾选。 */
  recommended: z.boolean(),
  /** 源文件属于哪个项目（源应用里的项目路径，展示用）；全局的没有。 */
  project: z.string().min(1).optional(),
};

export const ImportMemoryCandidateSchema = z.object({
  ...candidate,
  name: MemoryNameSchema,
  type: MemoryTypeSchema,
  description: z.string(),
  content: z.string(),
  /** 建议的范围：源项目对得上 Wevir 的项目时是 `project` 并带 `workspaceId`，否则 `global`。 */
  scope: MemoryScopeSchema,
  workspaceId: WorkspaceIdSchema.optional(),
});
export type ImportMemoryCandidate = z.infer<typeof ImportMemoryCandidateSchema>;

export const ImportConnectorCandidateSchema = z.object({
  ...candidate,
  name: ConnectorNameSchema,
  /** 环境变量与请求头只有键名（值导入后为空，要用户填）；读不懂时省略并带 `problem`。 */
  config: McpServerViewSchema.optional(),
  /** 建议只给这个项目；省略是全局的。 */
  workspaceId: WorkspaceIdSchema.optional(),
});
export type ImportConnectorCandidate = z.infer<typeof ImportConnectorCandidateSchema>;

export const ImportSkillCandidateSchema = z.object({
  ...candidate,
  name: z.string().min(1),
  description: z.string(),
});
export type ImportSkillCandidate = z.infer<typeof ImportSkillCandidateSchema>;

export const ImportScanParamsSchema = z.object({ app: ImportAppSchema });

export const ImportScanResultSchema = z.object({
  app: ImportAppSchema,
  /** 找到了这个应用的用户目录。 */
  found: z.boolean(),
  /** 读的用户目录（绝对路径）。 */
  home: z.string().min(1),
  memories: z.array(ImportMemoryCandidateSchema),
  connectors: z.array(ImportConnectorCandidateSchema),
  skills: z.array(ImportSkillCandidateSchema),
  /** 这个 Host 读不了的种类（格式还没支持），客户端照此显示而不是显示“没有”。 */
  unsupported: z.array(ImportKindSchema),
});
export type ImportScanResult = z.infer<typeof ImportScanResultSchema>;

/** 一次最多导入几条。 */
export const IMPORT_APPLY_MAX_ITEMS = 500;

export const ImportApplyItemSchema = z.object({
  key: z.string().min(1).max(256),
  /** 记忆的范围；省略用扫描时建议的。`project` 要带 `workspaceId`。 */
  scope: MemoryScopeSchema.optional(),
  /** 记忆或连接器的项目；连接器省略且 `scope` 是 `global` 时为全局。 */
  workspaceId: WorkspaceIdSchema.optional(),
  /** 换个名字导入（目标里已有同名的时）；按种类的命名规则校验，skills 不能改名。 */
  name: z.string().min(1).max(128).optional(),
});
export type ImportApplyItem = z.infer<typeof ImportApplyItemSchema>;

export const ImportApplyParamsSchema = z.object({
  app: ImportAppSchema,
  items: z.array(ImportApplyItemSchema).min(1).max(IMPORT_APPLY_MAX_ITEMS),
});

/**
 * 每条的结果：`imported` 已写入；`skipped` 目标里已有相同内容；`failed` 没写，`reason` 是开放字符串：`not_found`（源文件里
 * 已没有这一条）、`exists`（目标里有同名的）、`invalid_name`、`limit`（范围里笔记已满）、`no_workspace`，以及候选的 `problem`。
 */
export const ImportApplyResultItemSchema = z.object({
  key: z.string().min(1),
  outcome: z.enum(['imported', 'skipped', 'failed']),
  kind: ImportKindSchema.optional(),
  /** 写入后的名字。 */
  name: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
});
export type ImportApplyResultItem = z.infer<typeof ImportApplyResultItemSchema>;

export const ImportApplyResultSchema = z.object({ results: z.array(ImportApplyResultItemSchema) });
export type ImportApplyResult = z.infer<typeof ImportApplyResultSchema>;

export const ImportMethodSchemas = {
  'import.scan': {
    params: ImportScanParamsSchema,
    result: ImportScanResultSchema,
    permission: 'host.manage',
  },
  'import.apply': {
    params: ImportApplyParamsSchema,
    result: ImportApplyResultSchema,
    permission: 'host.manage',
  },
} as const;
