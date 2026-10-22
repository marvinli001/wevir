// 调优的建议（0.87.0，Host 功能 `tuning_proposals`，domain-model §3.41，ADR-0016）。
//
// 用户在某个会话上点“生成建议”时，Host 用这个会话当前的模型调一次（不带工具），按回顾、消息记录、回合后验证、护栏命中与当前档案
// 提出至多三条配置改动：项目的 `AGENTS.md`、项目技能、项目记忆或护栏规则。模型只提出，写入要用户逐条采纳；采纳之后下一个会话开的
// 档案版本记下这些建议（`ProfileVersionSummary.cause`）。建议记下生成时目标的基准散列，采纳时目标已经变了就是“已过时”，只能拒绝或
// 重新生成。拒绝的建议进入以后生成的输入，避免重复提出。
//
// 0.108.0（Host 功能 `tuning_auto`，domain-model §3.50，ADR-0018）：不再逐条采纳。后台生成（设置 `autoTuning`）、用户点的生成与 agent
// 的 `wevir_tuning_propose` 提出的改动都当场写入目标、进入试用（`trial`）；一个项目同时一个试用，凑够 `TUNING_TRIAL_SESSIONS` 个会话后
// 按回合后验证的通过率与失败回合的占比整组保留（`accepted`）或回退（`reverted`），结论记在 `outcome`。用户只能撤销
// （`tuning.proposal.revert`）。`pending` 与 `stale` 只留给旧记录。

import { z } from 'zod';
import {
  IsoTimeSchema,
  SessionIdSchema,
  TuningProposalIdSchema,
  WorkspaceIdSchema,
} from './common.js';
import { MEMORY_DESCRIPTION_MAX, MemoryNameSchema, MemoryTypeSchema } from './entities.js';
import { GUARDRAIL_NAME_MAX_LENGTH, GuardrailRuleSchema } from './guardrails.js';
import { RetroRefSchema } from './retro.js';
import { ProfileVersionRefSchema } from './tuning.js';

/** 一次生成最多几条建议。 */
export const TUNING_PROPOSALS_MAX = 3;
/** 标题的长度上限（字符）。 */
export const TUNING_PROPOSAL_TITLE_MAX_LENGTH = 120;
/** 一条建议最多几条证据。 */
export const TUNING_PROPOSAL_EVIDENCE_MAX = 8;
/** 证据文字的长度上限（字符）。 */
export const TUNING_PROPOSAL_EVIDENCE_TEXT_MAX_LENGTH = 200;
/** 改动前后文本的长度上限（字符）。 */
export const TUNING_PROPOSAL_TEXT_MAX_LENGTH = 200_000;
/** `tuning.proposal.list` 最多返回几条（新的在前）。 */
export const TUNING_PROPOSALS_LIST_MAX = 200;
/** 试用凑够几个会话就做决定（0.108.0）。 */
export const TUNING_TRIAL_SESSIONS = 5;
/** 试用最多等几天，到期还凑不够会话就按 `insufficient` 保留（0.108.0）。 */
export const TUNING_TRIAL_MAX_DAYS = 14;
/** `tuning.overview` 的 `series` 最多几个版本（0.108.0）。 */
export const TUNING_SERIES_MAX = 12;

/** 四种建议：项目的 `AGENTS.md`、项目技能、项目记忆、护栏规则。 */
export const TuningProposalKindSchema = z.enum(['rule', 'skill', 'memory', 'guardrail']);
export type TuningProposalKind = z.infer<typeof TuningProposalKindSchema>;

/**
 * `pending` 待审；`stale` 目标在建议之后被改过（只能拒绝或重新生成）；`accepted` 已采纳（0.108.0 起也是试用后保留）；`rejected` 已拒绝；
 * `trial` 已写入、在试用（0.108.0）；`reverted` 试用后回退或被撤销，目标已恢复（0.108.0）。
 */
export const TuningProposalStatusSchema = z.enum([
  'pending',
  'stale',
  'accepted',
  'rejected',
  'trial',
  'reverted',
]);
export type TuningProposalStatus = z.infer<typeof TuningProposalStatusSchema>;

const ProposalTextSchema = z.string().max(TUNING_PROPOSAL_TEXT_MAX_LENGTH);
/** 技能的目录名：小写字母、数字、连字符。 */
const SkillDirNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

/**
 * 改动：文本类的给出生成时目标的全文 `before`（不存在时是空串）与改后的全文 `after`，客户端自己算 diff。`rule` 的 `after` 由 Host 把
 * 模型给的 unified diff 打到 `before` 上得到。路径是绝对路径。
 */
export const TuningProposalChangeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('rule'),
    /** 项目根的 `AGENTS.md`。 */
    path: z.string().min(1),
    before: ProposalTextSchema,
    after: ProposalTextSchema,
  }),
  z.object({
    kind: z.literal('skill'),
    /** 技能目录名（`<项目>/.agents/skills/<name>/`）。 */
    name: SkillDirNameSchema,
    /** 那个目录里的 `SKILL.md`。 */
    path: z.string().min(1),
    before: ProposalTextSchema,
    after: ProposalTextSchema,
  }),
  z.object({
    kind: z.literal('memory'),
    /** 项目记忆里的名字；已有同名笔记时是改它。 */
    name: MemoryNameSchema,
    type: MemoryTypeSchema,
    description: z.string().min(1).max(MEMORY_DESCRIPTION_MAX),
    before: ProposalTextSchema,
    after: ProposalTextSchema,
  }),
  z.object({
    kind: z.literal('guardrail'),
    name: z.string().max(GUARDRAIL_NAME_MAX_LENGTH).optional(),
    /** 加到这个项目的护栏里。 */
    rule: GuardrailRuleSchema,
  }),
]);
export type TuningProposalChange = z.infer<typeof TuningProposalChangeSchema>;

/** 证据：模型引用的回顾里的一行（`id` 同 `RetroSummaryPoint.refs`），客户端按 `ref` 跳到会话里对应的位置。 */
export const TuningProposalEvidenceSchema = z.object({
  id: z.string().min(1),
  /** 那一行的文字（截短）。 */
  text: z.string().max(TUNING_PROPOSAL_EVIDENCE_TEXT_MAX_LENGTH),
  /** 是回合时，它在会话里是第几个回合（从 1 起）。 */
  turn: z.int().min(1).optional(),
  ref: RetroRefSchema.optional(),
});
export type TuningProposalEvidence = z.infer<typeof TuningProposalEvidenceSchema>;

/** 一次模型调用的 token 用量。 */
export const TuningUsageSchema = z.object({
  inputTokens: z.int().min(0),
  outputTokens: z.int().min(0),
});
export type TuningUsage = z.infer<typeof TuningUsageSchema>;

/** 采纳之后：用产生的版本建了几个会话，这些会话里回合后验证（有结果的运行）通过了几次。 */
export const TuningProposalStatsSchema = z.object({
  sessions: z.int().min(0),
  checks: z.object({ passed: z.int().min(0), total: z.int().min(0) }).optional(),
});
export type TuningProposalStats = z.infer<typeof TuningProposalStatsSchema>;

/** 改动从哪来（0.108.0）：`user` 用户点的生成，`auto` 后台生成，`agent` agent 用 `wevir_tuning_propose` 提交。 */
export const TuningProposalOriginSchema = z.enum(['user', 'auto', 'agent']);
export type TuningProposalOrigin = z.infer<typeof TuningProposalOriginSchema>;

/**
 * 一组会话的指标（0.108.0）：完成的回合、其中失败的（不含用户中断）、回合后验证有结果的运行与通过的次数（没有运行时省略）、护栏命中、
 * token 合计（用量服务没有数时省略）。
 */
export const TuningMetricsSchema = z.object({
  sessions: z.int().min(0),
  turns: z.int().min(0),
  failedTurns: z.int().min(0),
  checks: z.object({ passed: z.int().min(0), total: z.int().min(0) }).optional(),
  guardrailHits: z.int().min(0),
  tokens: z.int().min(0).optional(),
});
export type TuningMetrics = z.infer<typeof TuningMetricsSchema>;

/**
 * 试用的结论（0.108.0）。`reason`：`better` 通过率明显变高、`no_worse` 没有变差、`worse` 变差（回退）、`insufficient` 数据不够比较、
 * `manual` 用户或 agent 提前决定、`conflict` 目标在采纳后被改过、没有回退。开放字符串，客户端认不出的按 `no_worse` 显示。`baseline` 与
 * `trial` 是做决定时两边的指标（手动决定时可能省略）。
 */
export const TuningTrialOutcomeSchema = z.object({
  decidedBy: z.enum(['auto', 'user', 'agent']),
  result: z.enum(['kept', 'reverted']),
  reason: z.string().min(1),
  baseline: TuningMetricsSchema.optional(),
  trial: TuningMetricsSchema.optional(),
  decidedAt: IsoTimeSchema,
});
export type TuningTrialOutcome = z.infer<typeof TuningTrialOutcomeSchema>;

export const TuningProposalSchema = z.object({
  id: TuningProposalIdSchema,
  workspaceId: WorkspaceIdSchema,
  /** 提出建议的会话；会话删了之后还在。 */
  sessionId: SessionIdSchema,
  /** 会话现在的标题（现读）；会话删了或没有标题时省略。 */
  sessionTitle: z.string().optional(),
  kind: TuningProposalKindSchema,
  title: z.string().min(1).max(TUNING_PROPOSAL_TITLE_MAX_LENGTH),
  /** 给人看的目标：`AGENTS.md`、`.agents/skills/<name>/SKILL.md`、记忆名或护栏的种类。 */
  target: z.string().min(1),
  change: TuningProposalChangeSchema,
  evidence: z.array(TuningProposalEvidenceSchema).max(TUNING_PROPOSAL_EVIDENCE_MAX),
  status: TuningProposalStatusSchema,
  /** 用户在采纳前改过改动。 */
  edited: z.literal(true).optional(),
  /** 生成它的那次操作的用量（含同一次操作里先生成的回顾摘要）；同一次生成的几条相同。引擎没报告时省略。 */
  usage: TuningUsageSchema.optional(),
  providerId: z.string().optional(),
  modelId: z.string().optional(),
  createdAt: IsoTimeSchema,
  decidedAt: IsoTimeSchema.optional(),
  /** 采纳之后下一个会话开的档案版本。 */
  version: ProfileVersionRefSchema.optional(),
  /** 有 `version` 时。 */
  stats: TuningProposalStatsSchema.optional(),
  /** 来源（0.108.0）；旧 Host 省略，按 `user`。 */
  origin: TuningProposalOriginSchema.optional(),
  /** 试用的结论（0.108.0）：状态是 `accepted` 或 `reverted` 且经过试用时。 */
  outcome: TuningTrialOutcomeSchema.optional(),
});
export type TuningProposal = z.infer<typeof TuningProposalSchema>;

// ── tuning.proposal.* ───────────────────────────────────────────────────

/**
 * `tuning.proposal.generate`：用会话当前的模型提出建议（一次请求；这个会话还没有回顾摘要时先生成摘要，算在同一次操作里）。只有项目里
 * 的会话可以。`replaces` 是要重新生成的那条已过时的建议，生成成功后删掉它。
 */
export const TuningProposalGenerateParamsSchema = z.object({
  sessionId: SessionIdSchema,
  replaces: TuningProposalIdSchema.optional(),
});

/**
 * 没生成时 `reason`（开放字符串，同 `retro.summarize`：`unsupported` 引擎不能生成、`running` 回合进行中、`unavailable` 引擎会话恢复
 * 不了、`failed` 请求失败或超时、`unparsable` 输出解析不了、`empty` 会话还没有回合、`sub_session` 子会话；另有 `no_project` 会话不在
 * 项目里）。模型认为没有值得改的时 `proposals` 为空、没有 `reason`。`usage` 是这次操作的合计。
 */
export const TuningProposalGenerateResultSchema = z.object({
  proposals: z.array(TuningProposalSchema).max(TUNING_PROPOSALS_MAX),
  usage: TuningUsageSchema.optional(),
  /** 先生成了回顾摘要。 */
  summarized: z.literal(true).optional(),
  reason: z.string().min(1).optional(),
});

export const TuningProposalListParamsSchema = z.object({
  /** 省略是全部项目。 */
  workspaceId: WorkspaceIdSchema.optional(),
  /** `open` 待审与已过时，`decided` 已采纳与已拒绝；省略是全部。 */
  status: z.enum(['open', 'decided']).optional(),
});

/** 新的在前（已处理的按处理时刻），至多 `TUNING_PROPOSALS_LIST_MAX` 条。列表时顺便核对待审的目标，变了的标成已过时。 */
export const TuningProposalListResultSchema = z.object({
  proposals: z.array(TuningProposalSchema),
});

/**
 * `tuning.proposal.update`：采纳前改。文本类的给 `after`（记忆还可以给 `description`），护栏的给 `rule` 与可选的 `name`（`null` 去掉）。
 * 只能改待审的；已过时 `PROPOSAL_STALE`，已处理或字段与种类不符 `INVALID_PARAMS`。
 */
export const TuningProposalUpdateParamsSchema = z.object({
  proposalId: TuningProposalIdSchema,
  after: ProposalTextSchema.optional(),
  description: z.string().trim().min(1).max(MEMORY_DESCRIPTION_MAX).optional(),
  rule: GuardrailRuleSchema.optional(),
  name: z.string().trim().max(GUARDRAIL_NAME_MAX_LENGTH).nullable().optional(),
});

export const TuningProposalResultSchema = z.object({
  proposal: TuningProposalSchema,
});

/**
 * `tuning.proposal.decide`：采纳写入目标（`AGENTS.md`、技能文件并启用、项目记忆、护栏），拒绝只改状态。采纳时目标与生成时不同就标成
 * 已过时并回 `PROPOSAL_STALE`；已处理的再做同样的决定原样返回，不同的决定 `INVALID_PARAMS`。0.108.0：对 `trial` 的建议，`accept` 是提前
 * 保留（`outcome.reason` 为 `manual`），`reject` 等同 `tuning.proposal.revert`。
 */
export const TuningProposalDecideParamsSchema = z.object({
  proposalId: TuningProposalIdSchema,
  decision: z.enum(['accept', 'reject']),
});

/**
 * `tuning.proposal.revert`（0.108.0）：撤销一条试用中或已保留的改动，把目标恢复成采纳前的内容（原来没有的删掉）。目标在采纳之后被改过
 * 回 `PROPOSAL_STALE`，不动目标；已回退的原样返回；其余状态 `INVALID_PARAMS`。
 */
export const TuningProposalRevertParamsSchema = z.object({
  proposalId: TuningProposalIdSchema,
});

// ── tuning.overview（0.108.0） ───────────────────────────────────────────

export const TuningOverviewParamsSchema = z.object({
  /** 省略是全局：只有 `auto`、`budget` 与 `series`。 */
  workspaceId: WorkspaceIdSchema.optional(),
});

/** 本月的消耗（全局，所有项目合计）。`usedTokens` 含手动生成，`autoTokens` 只算后台生成，`exhausted` 是后台生成到了上限。 */
export const TuningBudgetSchema = z.object({
  /** `YYYY-MM`，Host 本地时区。 */
  month: z.string().regex(/^\d{4}-\d{2}$/),
  limitTokens: z.int().min(0),
  usedTokens: z.int().min(0),
  autoTokens: z.int().min(0),
  exhausted: z.boolean(),
});
export type TuningBudget = z.infer<typeof TuningBudgetSchema>;

/** 进行中的试用。`startVersion` 是第一个记下这些改动的档案版本，还没有会话开出来时省略（这时 `sessions` 是 0）。 */
export const TuningTrialSchema = z.object({
  proposalIds: z.array(TuningProposalIdSchema).min(1),
  startVersion: ProfileVersionRefSchema.optional(),
  sessions: z.int().min(0),
  needed: z.int().min(1),
  startedAt: IsoTimeSchema,
  /** 到这一刻还凑不够会话就按 `insufficient` 保留。 */
  deadline: IsoTimeSchema,
});
export type TuningTrial = z.infer<typeof TuningTrialSchema>;

/** 一个版本上的指标；`trial` 是进行中的试用里的版本。 */
export const TuningSeriesPointSchema = z.object({
  version: ProfileVersionRefSchema,
  createdAt: IsoTimeSchema,
  metrics: TuningMetricsSchema,
  trial: z.literal(true).optional(),
});
export type TuningSeriesPoint = z.infer<typeof TuningSeriesPointSchema>;

/** 最近一次生成（自动或手动）。`reason` 同 `tuning.proposal.generate` 的。 */
export const TuningRunSummarySchema = z.object({
  at: IsoTimeSchema,
  origin: z.enum(['user', 'auto']),
  proposals: z.int().min(0),
  reason: z.string().min(1).optional(),
  usage: TuningUsageSchema.optional(),
});
export type TuningRunSummary = z.infer<typeof TuningRunSummarySchema>;

/**
 * `auto.enabled` 是后台生成开着，`auto.decided` 是用户在引导里选过（设置里有 `autoTuning`）。`series` 是这个范围最近
 * `TUNING_SERIES_MAX` 个版本，从旧到新。`totals` 统计这个项目里经过试用的改动：`adopted` 进入过试用的、`kept` 保留的、`reverted` 回退的。
 */
export const TuningOverviewResultSchema = z.object({
  auto: z.object({ enabled: z.boolean(), decided: z.boolean() }),
  budget: TuningBudgetSchema,
  trial: TuningTrialSchema.optional(),
  series: z.array(TuningSeriesPointSchema).max(TUNING_SERIES_MAX),
  totals: z
    .object({ adopted: z.int().min(0), kept: z.int().min(0), reverted: z.int().min(0) })
    .optional(),
  lastRun: TuningRunSummarySchema.optional(),
});
export type TuningOverview = z.infer<typeof TuningOverviewResultSchema>;

/** 发给调用过 `tuning.*` 的连接：建议生成、改动、采纳、拒绝、过时或删除了。 */
export const TuningProposalChangedParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema.optional(),
});
