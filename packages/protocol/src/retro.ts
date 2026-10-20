// 任务回顾（0.73.0，Host 功能 `session_retro`，ADR-0012）。
//
// 用户隔几天回到一个会话，不用重读整段聊天就知道：目标、做完了什么、还剩什么、为什么这么决定、改了哪些文件、哪些验证真的通过了、
// 下一步做什么。回顾是从会话事件库生成的投影（版本 = 会话 ID + `throughSeq` + `schemaVersion`），Host 在用户打开时按需生成或增量
// 更新；骨架是确定性的，不调模型，每一行带出处（`ref`）。不在事件里的东西（此刻的代码状态、回合快照还在不在、Git 的提交、批注、
// 引用的会话与笔记还在不在）每次现读，带 `checkedAt`。可选的模型摘要由用户触发，单独标注，不覆盖骨架。

import { z } from 'zod';
import {
  CheckIdSchema,
  IsoTimeSchema,
  ProviderIdSchema,
  ReviewCommentIdSchema,
  SeqSchema,
  SessionIdSchema,
  TurnIdSchema,
  VerificationRunIdSchema,
} from './common.js';
import { GoalStatusSchema, TurnOutcomeSchema } from './entities.js';
import { DiffSourceSchema, GitObjectIdSchema } from './git.js';
import {
  AcceptanceStatusSchema,
  CheckKindSchema,
  CodeStateSchema,
  VerificationStatusSchema,
  VerificationTestsSchema,
} from './verification.js';

/** 投影（归约规则）的版本；改了归约规则就加一，旧投影随之重建。 */
export const RETRO_SCHEMA_VERSION = 1;
/** 摘要最多几点、每点多少字（按码点）。 */
export const RETRO_SUMMARY_MAX_POINTS = 6;
export const RETRO_SUMMARY_POINT_MAX_CHARS = 200;
/** 一行文本的上限（按码点）：用户消息、命令、其余。 */
export const RETRO_USER_TEXT_MAX_CHARS = 600;
export const RETRO_COMMAND_MAX_CHARS = 300;
export const RETRO_TEXT_MAX_CHARS = 200;

/**
 * 一行的出处：`event` 会话里的一条事件；`turn_diff` 一个回合的文件改动（回合快照，可带路径）；`verification` 一条验证记录（`seq`
 * 是它最后一次更新的事件）；`review` 一条批注（按它的 diff 范围打开）；`commit` 一个提交；`session` 另一个会话；`memory` 一条记忆
 * 笔记。
 */
export const RetroRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('event'), seq: SeqSchema, turnId: TurnIdSchema.optional() }),
  z.object({
    kind: z.literal('turn_diff'),
    turnId: TurnIdSchema,
    path: z.string().min(1).optional(),
  }),
  z.object({ kind: z.literal('verification'), runId: VerificationRunIdSchema, seq: SeqSchema }),
  z.object({
    kind: z.literal('review'),
    commentId: ReviewCommentIdSchema,
    path: z.string().min(1),
    source: DiffSourceSchema,
  }),
  z.object({ kind: z.literal('commit'), sha: GitObjectIdSchema }),
  z.object({ kind: z.literal('session'), sessionId: SessionIdSchema }),
  z.object({
    kind: z.literal('memory'),
    scope: z.enum(['global', 'project']),
    name: z.string().min(1),
  }),
]);
export type RetroRef = z.infer<typeof RetroRefSchema>;

/**
 * 出处现在还在不在（现读）：`available` 在；`deleted` 来源已删除（会话删了、笔记删了、回合快照没了）；`unknown` 读不出。只在指向
 * 事件之外的东西时有。
 */
export const RetroSourceStateSchema = z.enum(['available', 'deleted', 'unknown']);
export type RetroSourceState = z.infer<typeof RetroSourceStateSchema>;

/** 回顾的一行。`id` 稳定（`e<seq>`、`v:<runId>`、`b:<清单项>`、`c:<sha>`、`r:<批注>`、`f:<路径>`、`t:<回合>`），模型摘要用它引用出处。 */
export const RetroItemSchema = z.object({
  id: z.string().min(1),
  text: z.string(),
  ref: RetroRefSchema.optional(),
  source: RetroSourceStateSchema.optional(),
  /** 分支前（0.38.0 分支时从被分的会话抄来的历史）。 */
  inherited: z.literal(true).optional(),
  at: IsoTimeSchema.optional(),
});
export type RetroItem = z.infer<typeof RetroItemSchema>;

/** 目标：`/goal` 的记录（带状态）与起始请求（第一条看得见的用户消息）。都没有时 `recorded: false`。 */
export const RetroGoalSchema = z.object({
  recorded: z.boolean(),
  goal: RetroItemSchema.extend({ status: GoalStatusSchema }).optional(),
  request: RetroItemSchema.optional(),
});
export type RetroGoal = z.infer<typeof RetroGoalSchema>;

/**
 * 完成或未完成的一项：`todo` Agent 的清单、`board` 共享任务清单、`turn` 最后一个回合的结局、`approval` / `question` 等用户决定。
 * `status` 是登记的状态原样（清单的 `completed` 只是登记，不是验收）。
 */
export const RetroWorkItemSchema = RetroItemSchema.extend({
  origin: z.enum(['todo', 'board', 'turn', 'approval', 'question']),
  status: z.string().min(1),
  owner: SessionIdSchema.optional(),
});
export type RetroWorkItem = z.infer<typeof RetroWorkItemSchema>;

/** 回合快照的情况（现读）：`available` 前后快照都在；`live` 只有回合前的（回合还在进行）；`deleted`；`none` 没打快照；`not_git`。 */
export const RetroDiffStateSchema = z.enum(['available', 'live', 'deleted', 'none', 'not_git']);
export type RetroDiffState = z.infer<typeof RetroDiffStateSchema>;

/** 一个看得见的回合。 */
export const RetroTurnSchema = z.object({
  id: z.string().min(1),
  turnId: TurnIdSchema,
  /** 回合开始的事件。 */
  seq: SeqSchema,
  endSeq: SeqSchema.optional(),
  outcome: TurnOutcomeSchema.optional(),
  /** 回合的第一条用户消息（截短）；命令回合、目标回合与子会话的回合没有。 */
  text: z.string().optional(),
  /** `user` 用户发的；`repair` 自动修复；`report` 别的会话转来的；`command` `/compact` 等命令；`goal` 引擎为目标开的；`engine` 子会话。 */
  kind: z.enum(['user', 'repair', 'report', 'command', 'goal', 'engine']),
  /** 回合里 `edit` / `write` 工具给的路径。 */
  files: z.array(z.string()),
  commands: z.int().min(0),
  diff: RetroDiffStateSchema,
  fileCount: z.int().min(0).optional(),
  added: z.int().min(0).optional(),
  removed: z.int().min(0).optional(),
  inherited: z.literal(true).optional(),
  at: IsoTimeSchema,
});
export type RetroTurn = z.infer<typeof RetroTurnSchema>;

/** 改动的一个文件：哪几个回合改过（最后一个在后）。 */
export const RetroFileSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  turnIds: z.array(TurnIdSchema).min(1),
  /** 最后一个改它的回合的 diff 还在不在。 */
  diff: RetroDiffStateSchema,
});
export type RetroFile = z.infer<typeof RetroFileSchema>;

export const RetroCommitSchema = z.object({
  id: z.string().min(1),
  sha: GitObjectIdSchema,
  subject: z.string(),
  at: IsoTimeSchema,
});
export type RetroCommit = z.infer<typeof RetroCommitSchema>;

/** 改动：文件、会话期间的提交（不确定是谁做的）、未提交的文件数。`repo: false` 时提交与未提交是未知。 */
export const RetroChangesSchema = z.object({
  recorded: z.boolean(),
  repo: z.boolean().optional(),
  files: z.array(RetroFileSchema),
  omittedFiles: z.int().min(0).optional(),
  commits: z.array(RetroCommitSchema),
  /** 工作树里未提交的文件数（含未跟踪的）。 */
  uncommitted: z.int().min(0).optional(),
  branch: z.string().min(1).optional(),
  head: GitObjectIdSchema.nullable().optional(),
});
export type RetroChanges = z.infer<typeof RetroChangesSchema>;

/**
 * 通过的记录与此刻的代码对得上没有：`current` 是当前版本；`outdated` 结果对应旧版本；`unbound` 记录没有绑代码版本、也看不出之后改过；
 * 不是 `passed` 的记录没有这一项。比的是工作树的树散列（含未跟踪的文件）：只是提交了、内容没变时仍是 `current`。
 */
export const RetroEvidenceSchema = z.enum(['current', 'outdated', 'unbound']);
export type RetroEvidence = z.infer<typeof RetroEvidenceSchema>;

/** 一个检查之前的几条记录（旧的在前），看得出“失败 → 修复 → 通过”。 */
export const RETRO_CHECK_EARLIER_MAX = 5;

/** 一个检查最近的一条验证记录；`earlier` 是同一个检查之前的几条。 */
export const RetroCheckSchema = z.object({
  id: z.string().min(1),
  checkId: CheckIdSchema,
  runId: VerificationRunIdSchema,
  name: z.string().min(1),
  command: z.string().min(1),
  kind: CheckKindSchema,
  status: VerificationStatusSchema,
  reason: z.string().min(1).optional(),
  evidence: RetroEvidenceSchema.optional(),
  codeState: CodeStateSchema.optional(),
  tests: VerificationTestsSchema.optional(),
  exitCode: z.int().nullable().optional(),
  turnId: TurnIdSchema.optional(),
  /** 记录最后一次更新的事件。 */
  seq: SeqSchema,
  finishedAt: IsoTimeSchema.optional(),
  earlier: z
    .array(
      z.object({
        runId: VerificationRunIdSchema,
        status: VerificationStatusSchema,
        reason: z.string().min(1).optional(),
        seq: SeqSchema,
        turnId: TurnIdSchema.optional(),
      }),
    )
    .max(RETRO_CHECK_EARLIER_MAX)
    .optional(),
});
export type RetroCheck = z.infer<typeof RetroCheckSchema>;

/** Agent 自己跑的 shell 命令：原始材料，不计入验证。 */
export const RetroCommandSchema = RetroItemSchema.extend({
  /** `tool.finished` 的状态；还没结束时省略。 */
  status: z.string().min(1).optional(),
});
export type RetroCommand = z.infer<typeof RetroCommandSchema>;

/** 验证：每个检查最近的记录、会话的验收状态、Agent 跑的命令。没有任何验证记录时 `recorded: false`（未验证）。 */
export const RetroVerificationSchema = z.object({
  recorded: z.boolean(),
  checks: z.array(RetroCheckSchema),
  acceptance: AcceptanceStatusSchema.optional(),
  commands: z.array(RetroCommandSchema),
  omittedCommands: z.int().min(0).optional(),
  /** 此刻的代码状态（现读）；读不出时省略。 */
  codeState: CodeStateSchema.optional(),
});
export type RetroVerification = z.infer<typeof RetroVerificationSchema>;

export const RetroReviewCommentSchema = RetroItemSchema.extend({
  path: z.string().min(1),
  line: z.int().min(1),
  status: z.enum(['pending', 'sent']),
  /** 批注此刻的位置是否过期。 */
  outdated: z.literal(true).optional(),
});
export type RetroReviewComment = z.infer<typeof RetroReviewCommentSchema>;

/** 审阅：写在这个会话里的批注（现读）。读不出时 `recorded: false`。 */
export const RetroReviewSchema = z.object({
  recorded: z.boolean(),
  comments: z.array(RetroReviewCommentSchema),
});
export type RetroReview = z.infer<typeof RetroReviewSchema>;

/**
 * 关键决定的种类：`instruction` 后续的用户消息；`steer` 插话；`answer` 回答提问；`declined` 拒绝审批；`cancelled` 用户停止回合；
 * `undone` / `redone` / `rewound` 撤销、重做、撤回回合；`handoff` 换来源。开放字符串。
 */
export const RetroDecisionSchema = RetroItemSchema.extend({ kind: z.string().min(1) });
export type RetroDecision = z.infer<typeof RetroDecisionSchema>;

/**
 * 下一步的种类：`decide` 等用户审批或回答；`fix_check` 检查失败；`rerun_check` 通过的结果对应旧版本；`run_checks` 改了代码却没有
 * 验证记录；`environment` 环境不可用；`send_review` 待发送的批注；`open_item` 未完成的清单项；`retry_turn` 最后一个回合没完成；
 * `commit` 有未提交的改动；`push` 有未推送的提交。开放字符串。
 */
export const RetroNextSchema = RetroItemSchema.extend({ kind: z.string().min(1) });
export type RetroNext = z.infer<typeof RetroNextSchema>;

/**
 * 交付状态，各项分开、可以同时存在：本地检查、提交、推送、CI（第一版恒为 `unknown`）、部署（恒为 `unknown`）。都是开放字符串。
 */
export const RetroDeliverySchema = z.object({
  /** `passed` / `outdated` / `failed` / `running` / `environment_unavailable` / `unverified`。 */
  checks: z.string().min(1),
  /** `uncommitted` / `committed` / `clean` / `unknown`。 */
  commit: z.string().min(1),
  /** `not_pushed` / `pushed` / `no_upstream` / `unknown`。 */
  push: z.string().min(1),
  ci: z.string().min(1),
  deploy: z.string().min(1),
  /** 已提交但未推送的提交数。 */
  ahead: z.int().min(0).optional(),
});
export type RetroDelivery = z.infer<typeof RetroDeliverySchema>;

/** 关联的会话：被分的会话、子 agent、开出的会话。 */
export const RetroRelatedSessionSchema = RetroItemSchema.extend({
  sessionId: SessionIdSchema,
  relation: z.enum(['forked_from', 'subagent', 'opened']),
});
export type RetroRelatedSession = z.infer<typeof RetroRelatedSessionSchema>;

/** 这个会话写过或删过的记忆笔记。 */
export const RetroMemorySchema = RetroItemSchema.extend({
  scope: z.enum(['global', 'project']),
  name: z.string().min(1),
  operation: z.enum(['save', 'delete']),
});
export type RetroMemory = z.infer<typeof RetroMemorySchema>;

/** 模型摘要的一点：`refs` 是骨架里的行 ID；没有有效出处时 `inferred`（推断）。 */
export const RetroSummaryPointSchema = z.object({
  text: z
    .string()
    .min(1)
    .max(RETRO_SUMMARY_POINT_MAX_CHARS * 2),
  refs: z.array(z.string().min(1)),
  inferred: z.literal(true).optional(),
});
export type RetroSummaryPoint = z.infer<typeof RetroSummaryPointSchema>;

/**
 * 可选的模型摘要：由用户触发，会话当前的来源与模型写的，不覆盖骨架。`usage` 是适配器报的 token，不报时省略（界面写“用量未报告”）；
 * `outdated`：之后会话又有了新事件。
 */
export const RetroSummarySchema = z.object({
  points: z.array(RetroSummaryPointSchema).min(1).max(RETRO_SUMMARY_MAX_POINTS),
  providerId: ProviderIdSchema,
  modelId: z.string().min(1),
  throughSeq: SeqSchema,
  generatedAt: IsoTimeSchema,
  inputBytes: z.int().min(0),
  outputBytes: z.int().min(0),
  usage: z.object({ inputTokens: z.int().min(0), outputTokens: z.int().min(0) }).optional(),
  outdated: z.literal(true).optional(),
});
export type RetroSummary = z.infer<typeof RetroSummarySchema>;

/** 一个会话的回顾。 */
export const SessionRetroSchema = z.object({
  sessionId: SessionIdSchema,
  /** 会话标题（现读）；放进回顾里是为了和其余文本一起脱敏、一起导出。 */
  title: z.string().optional(),
  schemaVersion: z.int().min(1),
  throughSeq: SeqSchema,
  /** 投影最后一次更新的时刻。 */
  builtAt: IsoTimeSchema,
  /** 现读部分的时刻。 */
  checkedAt: IsoTimeSchema,
  /** 这次怎么得到投影的：`full` 从头重放、`incremental` 只读新事件、`cached` 没有新事件。 */
  build: z.enum(['full', 'incremental', 'cached']),
  /** 回合还在进行。 */
  running: z.boolean(),
  goal: RetroGoalSchema,
  done: z.array(RetroWorkItemSchema),
  open: z.array(RetroWorkItemSchema),
  /** 任务清单只属于会话树的根；别的会话里 `false`。 */
  boardRecorded: z.boolean(),
  turns: z.array(RetroTurnSchema),
  /** 撤销且没重做的回合数（它们不出现在回顾里）。 */
  hiddenTurns: z.int().min(0),
  changes: RetroChangesSchema,
  verification: RetroVerificationSchema,
  review: RetroReviewSchema,
  decisions: z.array(RetroDecisionSchema),
  omittedDecisions: z.int().min(0).optional(),
  delivery: RetroDeliverySchema,
  next: z.array(RetroNextSchema),
  sessions: z.array(RetroRelatedSessionSchema),
  memories: z.array(RetroMemorySchema),
  summary: RetroSummarySchema.optional(),
});
export type SessionRetro = z.infer<typeof SessionRetroSchema>;

// ── 方法 ───────────────────────────────────────────────────────

/** `retro.get`：生成或增量更新回顾。`redact` 时所有文本里像密钥的片段换成 `[REDACTED]`（正则检查，可能有遗漏）。 */
export const RetroGetParamsSchema = z.object({
  sessionId: SessionIdSchema,
  redact: z.boolean().optional(),
});
export const RetroGetResultSchema = z.object({
  retro: SessionRetroSchema,
  /** `redact` 时替换掉的片段数。 */
  redactions: z.int().min(0).optional(),
});

/**
 * `retro.summarize`：用会话当前的模型写一份摘要。没写成时 `reason`（开放字符串：`unsupported` 引擎不能生成、`running` 回合进行中、
 * `unavailable` 引擎会话恢复不了、`failed` 请求失败或超时、`unparsable` 输出解析不了、`empty` 会话还没有回合）。
 */
export const RetroSummarizeParamsSchema = z.object({ sessionId: SessionIdSchema });
export const RetroSummarizeResultSchema = z.object({
  summary: RetroSummarySchema.optional(),
  reason: z.string().min(1).optional(),
});
