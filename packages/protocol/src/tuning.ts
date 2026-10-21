// 调优的档案（0.85.0，Host 功能 `tuning`，domain-model §3.39，ADR-0014）。
//
// 档案是某个项目在某一时刻 Wevir 交给引擎的“运行时周围的配置”，分八层：系统提示、规则文件、说明与风格、记忆、技能、角色、护栏、
// 连接器与插件。每层是一组条目（名称、范围、内容散列），层散列是规范化条目的 sha256，档案指纹是八个层散列按层名排好后的 sha256。
// 版本只在建会话时惰性生成：指纹与这个项目最新的版本不同才新开一个（项目内序号 1、2…），相同就沿用；会话记下用的是哪一版，
// `session.rules` 带上它。文本内容按散列另存，供两版之间看文本 diff；连接器只记名称、命令或地址与环境变量和请求头的键名，不记值，
// 也不存文本。
//
// “全局”（不带 `workspaceId`）是不在项目里的对话用的档案：只有全局的那部分。

import { z } from 'zod';
import {
  IsoTimeSchema,
  ProfileVersionIdSchema,
  SessionIdSchema,
  WorkspaceIdSchema,
} from './common.js';

/** 八层，按界面上的先后。 */
export const PROFILE_LAYERS = [
  'system',
  'rules',
  'instructions',
  'memory',
  'skills',
  'roles',
  'guardrails',
  'connectors',
] as const;
export type ProfileLayerKey = (typeof PROFILE_LAYERS)[number];

/** `tuning.version` 最多列几个用这一版的会话。 */
export const PROFILE_VERSION_SESSIONS_MAX = 200;
/** `tuning.versions` 一页最多几个版本。 */
export const PROFILE_VERSIONS_PAGE_MAX = 100;

/** sha256 的十六进制。 */
export const ProfileHashSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** 条目的范围：`global` 对所有项目（含系统提示与内置角色），`project` 只对这个项目。开放字符串。 */
export const ProfileScopeSchema = z.string().min(1);
export type ProfileScope = 'global' | 'project';

/** 一层里的一个条目。 */
export const ProfileItemSchema = z.object({
  /** 在这一层里唯一、跨版本稳定（文件路径、`<范围>/<名字>` 等），按它比两版。 */
  id: z.string().min(1),
  /** 显示的名字。 */
  label: z.string().min(1),
  scope: ProfileScopeSchema,
  /** 规范化内容的 sha256。 */
  hash: ProfileHashSchema,
  /** 存了文本内容（`tuning.blob` 按 `textHash` 或 `hash` 取），可以看 diff。连接器与太大的文件没有。 */
  text: z.boolean().optional(),
  /** 文本的散列，与 `hash` 不同时才有（技能的 `hash` 是整个目录的，文本是 SKILL.md）。 */
  textHash: ProfileHashSchema.optional(),
  /** 对应的文件或目录（绝对路径），客户端可以打开。 */
  path: z.string().min(1).optional(),
  /** 简短的附加信息（输出风格名、命令前缀、连接器的命令或地址）。 */
  detail: z.string().optional(),
});
export type ProfileItem = z.infer<typeof ProfileItemSchema>;

export const ProfileLayerSchema = z.object({
  /** `PROFILE_LAYERS` 之一；开放字符串，认不出的层客户端跳过。 */
  key: z.string().min(1),
  hash: ProfileHashSchema,
  items: z.array(ProfileItemSchema),
});
export type ProfileLayer = z.infer<typeof ProfileLayerSchema>;

/** 一份档案：八层与指纹。 */
export const ProfileSchema = z.object({
  fingerprint: ProfileHashSchema,
  layers: z.array(ProfileLayerSchema),
  /** 采集时的 Wevir 版本；只记录，不进指纹。 */
  wevirVersion: z.string().min(1).optional(),
});
export type Profile = z.infer<typeof ProfileSchema>;

/** 会话与界面引用一个版本时用的三项。 */
export const ProfileVersionRefSchema = z.object({
  id: ProfileVersionIdSchema,
  /** 项目内的序号，从 1 起。 */
  seq: z.int().min(1),
  fingerprint: ProfileHashSchema,
});
export type ProfileVersionRef = z.infer<typeof ProfileVersionRefSchema>;

/** 与前一版比，一层里新增、删除、修改了几个条目。 */
export const ProfileLayerChangeSchema = z.object({
  key: z.string().min(1),
  added: z.int().min(0),
  removed: z.int().min(0),
  modified: z.int().min(0),
});
export type ProfileLayerChange = z.infer<typeof ProfileLayerChangeSchema>;

export const ProfileVersionSummarySchema = ProfileVersionRefSchema.extend({
  /** 省略是全局的。 */
  workspaceId: WorkspaceIdSchema.optional(),
  createdAt: IsoTimeSchema,
  /** 用这一版建的会话数。 */
  sessions: z.int().min(0),
  /** 与前一版比变了的层，按 `PROFILE_LAYERS` 的先后；第一版省略。 */
  changes: z.array(ProfileLayerChangeSchema).optional(),
});
export type ProfileVersionSummary = z.infer<typeof ProfileVersionSummarySchema>;

// ── tuning.* ────────────────────────────────────────────────────────────

export const TuningGetParamsSchema = z.object({
  /** 省略是全局。 */
  workspaceId: WorkspaceIdSchema.optional(),
});

/**
 * 当前的档案，与最新的版本。`pending`：有版本且当前指纹与最新的不同（下一个会话会开新版本），`pendingLayers` 是不同的层。
 * 取当前档案不建版本。
 */
export const TuningGetResultSchema = z.object({
  profile: ProfileSchema,
  latest: ProfileVersionSummarySchema.optional(),
  pending: z.boolean(),
  pendingLayers: z.array(z.string().min(1)),
});

export const TuningVersionsParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema.optional(),
  /** 上一页结果的 `nextCursor`。 */
  cursor: z.string().min(1).optional(),
  limit: z.int().min(1).max(PROFILE_VERSIONS_PAGE_MAX).optional(),
});

/** 新的在前；还有更早的时有 `nextCursor`。 */
export const TuningVersionsResultSchema = z.object({
  versions: z.array(ProfileVersionSummarySchema),
  nextCursor: z.string().min(1).optional(),
});

export const TuningVersionParamsSchema = z.object({
  versionId: ProfileVersionIdSchema,
});

/** 一个版本的全部层，与用它建的会话（新的在前，至多 `PROFILE_VERSION_SESSIONS_MAX` 个）。没有这个版本时 `PROFILE_VERSION_NOT_FOUND`。 */
export const TuningVersionResultSchema = z.object({
  version: ProfileVersionSummarySchema.extend({
    layers: z.array(ProfileLayerSchema),
    wevirVersion: z.string().min(1).optional(),
  }),
  sessionIds: z.array(SessionIdSchema),
});

/** 一个条目在两版之间的变化：`added` 只有 `after`，`removed` 只有 `before`，`modified` 两个都有。 */
export const ProfileItemChangeSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  scope: ProfileScopeSchema,
  change: z.enum(['added', 'removed', 'modified']),
  before: ProfileItemSchema.optional(),
  after: ProfileItemSchema.optional(),
});
export type ProfileItemChange = z.infer<typeof ProfileItemChangeSchema>;

export const ProfileLayerDiffSchema = z.object({
  key: z.string().min(1),
  items: z.array(ProfileItemChangeSchema),
});
export type ProfileLayerDiff = z.infer<typeof ProfileLayerDiffSchema>;

/** `to` 是 `current` 时与 `from` 所在范围的当前档案比。两版不在同一范围也可以比。 */
export const TuningDiffParamsSchema = z.object({
  from: ProfileVersionIdSchema,
  to: z.union([ProfileVersionIdSchema, z.literal('current')]),
});

/** 变了的层（按 `PROFILE_LAYERS` 的先后），每层只列变了的条目；两边一样时 `layers` 为空。 */
export const TuningDiffResultSchema = z.object({
  from: ProfileVersionRefSchema,
  /** `to` 是 `current` 时只有指纹。 */
  to: z.union([ProfileVersionRefSchema, z.object({ fingerprint: ProfileHashSchema })]),
  layers: z.array(ProfileLayerDiffSchema),
});

export const TuningBlobParamsSchema = z.object({
  hash: ProfileHashSchema,
});

/** 没存这段文本（连接器、太大的文件，或已清理）时 `text` 省略。 */
export const TuningBlobResultSchema = z.object({
  text: z.string().optional(),
});

/** 发给调用过 `tuning.*` 的连接：这个范围开了新版本，或档案的某些来源变了（记忆、设置、审批规则、插件）。 */
export const TuningChangedParamsSchema = z.object({
  /** 省略是全局，或不只一个项目。 */
  workspaceId: WorkspaceIdSchema.optional(),
});
