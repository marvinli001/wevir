// 审批规则（0.80.0，Host 功能 `approval_rules`，domain-model §3.35）。
//
// 用户在审批卡片上选“总是允许”，或从历史建议里加：以后同一前缀的命令（`git status …`）引擎再要审批时，Host 按规则替用户选“允许”，
// 照样记下审批与结果（`reason: 'rule'`），不问人。规则只回答引擎已经发出的审批，不放宽引擎的权限模式、沙箱或角色；命令要拆得出、
// 每一段都以某条规则的前缀开头才算匹配（展开、重定向、子 shell 等一律不匹配，照常问）。全局的对所有项目有效，项目的只对这个项目。

import { z } from 'zod';
import {
  ApprovalIdSchema,
  ApprovalRuleIdSchema,
  IsoTimeSchema,
  SessionIdSchema,
  WorkspaceIdSchema,
} from './common.js';

/** 前缀最多几个词。 */
export const APPROVAL_RULE_PREFIX_MAX_TOKENS = 32;
/** 一个词最长（字符）。 */
export const APPROVAL_RULE_TOKEN_MAX = 1000;
/** 一次审批最多提议几个前缀（命令里每一段没被允许的各一个）。 */
export const APPROVAL_RULE_PROPOSALS_MAX = 8;
/** `approvalRule.suggest` 最多给几条。 */
export const APPROVAL_RULE_SUGGESTIONS_MAX = 20;

/** 命令前缀：按词，`["git", "status"]`。 */
export const CommandPrefixSchema = z
  .array(z.string().min(1).max(APPROVAL_RULE_TOKEN_MAX))
  .min(1)
  .max(APPROVAL_RULE_PREFIX_MAX_TOKENS);
export type CommandPrefix = z.infer<typeof CommandPrefixSchema>;

/** `project` 只对审批所在会话的项目有效，`global` 对所有项目。 */
export const ApprovalRuleScopeSchema = z.enum(['project', 'global']);
export type ApprovalRuleScope = z.infer<typeof ApprovalRuleScopeSchema>;

/** 规则从哪来：审批卡片上的“总是允许”，或从历史建议里加的。开放字符串。 */
export const ApprovalRuleSourceSchema = z.string().min(1);
export type ApprovalRuleSource = 'approval' | 'suggestion';

export const ApprovalRuleSchema = z.object({
  id: ApprovalRuleIdSchema,
  /** 省略是全局规则。 */
  workspaceId: WorkspaceIdSchema.optional(),
  /** 现在只有 `command_prefix`。开放字符串，认不出的种类不匹配任何东西。 */
  kind: z.string().min(1),
  prefix: CommandPrefixSchema,
  source: ApprovalRuleSourceSchema,
  /** 从审批来的：在哪个会话、哪次审批上选的。 */
  sourceSessionId: SessionIdSchema.optional(),
  sourceApprovalId: ApprovalIdSchema.optional(),
  createdAt: IsoTimeSchema,
  /** Host 按这条规则自动允许的次数。 */
  useCount: z.int().min(0),
  lastUsedAt: IsoTimeSchema.optional(),
});
export type ApprovalRule = z.infer<typeof ApprovalRuleSchema>;

/**
 * 审批上 Host 提议的规则：命令里每一段还没被规则允许的各一个前缀。命令拆不出、或有一段不宜提议（解释器、`sudo`、`rm` 等）时
 * 没有这一项，卡片不给“总是允许”。
 */
export const ProposedApprovalRuleSchema = z.object({
  prefixes: z.array(CommandPrefixSchema).min(1).max(APPROVAL_RULE_PROPOSALS_MAX),
});
export type ProposedApprovalRule = z.infer<typeof ProposedApprovalRuleSchema>;

// ── approvalRule.* ──────────────────────────────────────────────────────

export const ApprovalRuleListParamsSchema = z.object({
  /** 给了只列对这个项目有效的（全局的与这个项目的）；省略列全部。 */
  workspaceId: WorkspaceIdSchema.optional(),
});

/** 按创建先后。 */
export const ApprovalRuleListResultSchema = z.object({
  rules: z.array(ApprovalRuleSchema),
});

export const ApprovalRuleAddParamsSchema = z.object({
  prefix: CommandPrefixSchema,
  /** 省略加全局规则。 */
  workspaceId: WorkspaceIdSchema.optional(),
});

/** 同一范围里已有同样的前缀时返回已有的那条。前缀不宜作规则（解释器、`sudo` 等）时 `INVALID_PARAMS`。 */
export const ApprovalRuleResultSchema = z.object({
  rule: ApprovalRuleSchema,
});

export const ApprovalRuleDeleteParamsSchema = z.object({
  ruleId: ApprovalRuleIdSchema,
});

/** 已经不在时 `deleted` 为 false。删除立即生效：之后的审批不再按它允许。 */
export const ApprovalRuleDeleteResultSchema = z.object({
  deleted: z.boolean(),
});

export const ApprovalRuleSuggestParamsSchema = z.object({
  /** 给了只看这个项目的审批；省略看全部。 */
  workspaceId: WorkspaceIdSchema.optional(),
});

/**
 * 从历史建议的规则：用户多次手动允许过、按提议的前缀归在一起的命令。已被规则允许的不再建议。按次数从多到少，最多
 * `APPROVAL_RULE_SUGGESTIONS_MAX` 条。
 */
export const ApprovalRuleSuggestionSchema = z.object({
  prefix: CommandPrefixSchema,
  /** 这些审批所在的项目；同一前缀在几个项目里都允许过时各一条。 */
  workspaceId: WorkspaceIdSchema,
  /** 手动允许过几次。 */
  count: z.int().min(1),
  lastApprovedAt: IsoTimeSchema,
  /** 最近一次的命令原文（显示用）。 */
  example: z.string(),
});
export type ApprovalRuleSuggestion = z.infer<typeof ApprovalRuleSuggestionSchema>;

export const ApprovalRuleSuggestResultSchema = z.object({
  suggestions: z.array(ApprovalRuleSuggestionSchema),
});
