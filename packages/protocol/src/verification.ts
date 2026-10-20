// 回合后验证与有限自动修复（0.65.0，Host 功能 `verification`，ADR-0008）。
//
// 引擎结束回合不等于任务已验收。用户给工作区配置检查（测试、构建、类型检查等命令）；Host 在用户手动运行时、或回合结束后按适用条件
// 起进程跑这些检查，结果写成独立的验证记录（会话事件流里的 `verification.updated`），并按最近一轮算出会话的验收状态
// （`acceptance.changed`），与引擎的回合状态分开。用户启用自动修复时，检查失败后 Host 开有次数与预算上限、带来源的修复回合
// （`repair.updated`）。检查配置存在 Host 的数据目录，不写回仓库；仓库里声明的命令只是候选，用户保存了才会执行。

import { z } from 'zod';
import {
  CheckIdSchema,
  IsoTimeSchema,
  RepairIdSchema,
  SessionIdSchema,
  TurnIdSchema,
  VerificationRoundIdSchema,
  VerificationRunIdSchema,
  WorkspaceIdSchema,
} from './common.js';
import { ReadinessStatusSchema } from './readiness.js';

/** 每个工作区最多的检查数。 */
export const CHECKS_MAX_PER_WORKSPACE = 20;
export const CHECK_NAME_MAX_LENGTH = 60;
export const CHECK_COMMAND_MAX_LENGTH = 2000;
/** `paths`（适用条件）最多几项、每项多长。 */
export const CHECK_PATHS_MAX = 20;
export const CHECK_PATH_MAX_LENGTH = 200;
export const CHECK_EXPECT_OUTPUT_MAX_LENGTH = 200;
/** 一次检查的超时：缺省 10 分钟，最短 1 秒，最长 60 分钟。 */
export const CHECK_TIMEOUT_DEFAULT_MS = 10 * 60_000;
export const CHECK_TIMEOUT_MIN_MS = 1000;
export const CHECK_TIMEOUT_MAX_MS = 60 * 60_000;
/** 验证记录里输出尾部（`summary`）的上限。 */
export const VERIFICATION_SUMMARY_MAX_LENGTH = 4000;
/** 快照与投影里留的验证记录条数（按最近一次变化的先后）。 */
export const VERIFICATION_RUNS_KEPT = 30;
/** `verification.output` 一次最多读的字节。 */
export const VERIFICATION_OUTPUT_PAGE_MAX_BYTES = 256 * 1024;
/** 自动修复次数的上限（用户可设 1 到这个数）。 */
export const REPAIR_MAX_ATTEMPTS_LIMIT = 5;
export const REPAIR_MAX_DURATION_LIMIT_MS = 2 * 60 * 60_000;

/** 检查的种类：`test` 要求输出里识别得出至少一个跑过的测试，其余只看退出码与 `expectOutput`。 */
export const CheckKindSchema = z.enum(['test', 'build', 'typecheck', 'lint', 'other']);
export type CheckKind = z.infer<typeof CheckKindSchema>;

/** 什么时候跑：`manual` 只在用户运行检查时；`after_turn` 另在改了文件的回合结束后按 `paths` 自动跑。 */
export const CheckTriggerSchema = z.enum(['manual', 'after_turn']);
export type CheckTrigger = z.infer<typeof CheckTriggerSchema>;

/**
 * 检查从哪儿来：`user` 用户自己写的；`package_script` 从 `package.json` 的 scripts 选的（`scriptHash` 是用户保存时脚本正文的散列，
 * 正文后来变了就要重新认可）；`instructions` 从 AGENTS.md / CLAUDE.md 里的命令选的。
 */
export const CheckSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }),
  z.object({
    kind: z.literal('package_script'),
    /** 相对会话目录的 `package.json`。 */
    file: z.string().min(1).max(CHECK_PATH_MAX_LENGTH),
    script: z.string().min(1).max(200),
    scriptHash: z.string().min(1).max(128),
  }),
  z.object({
    kind: z.literal('instructions'),
    file: z.string().min(1).max(CHECK_PATH_MAX_LENGTH),
  }),
]);
export type CheckSource = z.infer<typeof CheckSourceSchema>;

const CheckFieldsSchema = z.object({
  name: z.string().trim().min(1).max(CHECK_NAME_MAX_LENGTH),
  /** 一条 shell 命令行，由用户的 shell 执行（同后台进程）。 */
  command: z.string().trim().min(1).max(CHECK_COMMAND_MAX_LENGTH),
  /** 相对会话目录；空字符串是会话目录本身。不能是绝对路径，也不能出界。 */
  cwd: z.string().max(CHECK_PATH_MAX_LENGTH),
  timeoutMs: z.int().min(CHECK_TIMEOUT_MIN_MS).max(CHECK_TIMEOUT_MAX_MS),
  kind: CheckKindSchema,
  trigger: CheckTriggerSchema,
  /**
   * 适用条件（只对回合后自动运行起作用）：这个回合改到的文件（相对会话目录）命中其中一项才跑。没有 glob 字符的一项按目录前缀或文件
   * 匹配（`src/`、`src`、`package.json`），带 `*` / `?` 的按 glob（`**` 跨目录）。省略或空表示回合改了文件就跑。
   */
  paths: z.array(z.string().min(1).max(CHECK_PATH_MAX_LENGTH)).max(CHECK_PATHS_MAX).optional(),
  /** 输出里必须出现的内容（正则，JavaScript 语法，不分大小写）；没有时不检查。 */
  expectOutput: z.string().min(1).max(CHECK_EXPECT_OUTPUT_MAX_LENGTH).optional(),
});

export const CheckDefinitionSchema = CheckFieldsSchema.extend({
  id: CheckIdSchema,
  source: CheckSourceSchema,
  /** 每次保存加一；验证记录记下它（检查版本）。 */
  revision: z.int().min(1),
  /** 用户最近一次保存（即认可这条命令）的时刻。 */
  approvedAt: IsoTimeSchema,
  createdAt: IsoTimeSchema,
  updatedAt: IsoTimeSchema,
});
export type CheckDefinition = z.infer<typeof CheckDefinitionSchema>;

/** `checks.save` 的检查：带 `id` 时改那一项，否则新建。来源是脚本时 Host 读正文算散列。 */
export const CheckInputSchema = CheckFieldsSchema.partial({ cwd: true, timeoutMs: true }).extend({
  id: CheckIdSchema.optional(),
  source: z
    .discriminatedUnion('kind', [
      z.object({ kind: z.literal('user') }),
      z.object({
        kind: z.literal('package_script'),
        file: z.string().min(1).max(CHECK_PATH_MAX_LENGTH),
        script: z.string().min(1).max(200),
      }),
      z.object({
        kind: z.literal('instructions'),
        file: z.string().min(1).max(CHECK_PATH_MAX_LENGTH),
      }),
    ])
    .optional(),
});
export type CheckInput = z.infer<typeof CheckInputSchema>;

/** 仓库里声明的命令（`checks.candidates`）：只是读出来的候选，不会执行；用户保存后才是检查。 */
export const CheckCandidateSchema = z.object({
  name: z.string().min(1).max(CHECK_NAME_MAX_LENGTH),
  command: z.string().min(1).max(CHECK_COMMAND_MAX_LENGTH),
  cwd: z.string().max(CHECK_PATH_MAX_LENGTH),
  kind: CheckKindSchema,
  source: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('package_script'),
      file: z.string().min(1),
      script: z.string().min(1),
      /** 脚本正文（展示给用户看要认可的是什么）。 */
      body: z.string().max(CHECK_COMMAND_MAX_LENGTH),
    }),
    z.object({ kind: z.literal('instructions'), file: z.string().min(1), line: z.int().min(1) }),
  ]),
});
export type CheckCandidate = z.infer<typeof CheckCandidateSchema>;

/** 自动修复的设置（每个工作区一份）：默认关闭。 */
export const RepairSettingsSchema = z.object({
  enabled: z.boolean(),
  maxAttempts: z.int().min(1).max(REPAIR_MAX_ATTEMPTS_LIMIT),
  /** 整条修复链（修复回合加复验）的总时长上限。 */
  maxDurationMs: z.int().min(60_000).max(REPAIR_MAX_DURATION_LIMIT_MS),
  /** 修复回合用掉的 token 上限（会话累计 token 的增量）；引擎不报 token 时只按时长。 */
  maxTokens: z.int().min(10_000).max(100_000_000),
});
export type RepairSettings = z.infer<typeof RepairSettingsSchema>;

export const DEFAULT_REPAIR_SETTINGS: RepairSettings = {
  enabled: false,
  maxAttempts: 2,
  maxDurationMs: 20 * 60_000,
  maxTokens: 1_000_000,
};

/**
 * 检查跑的是哪个代码状态：`git` 是 HEAD（还没有提交时 `null`）加上工作树（含未跟踪、未忽略的文件）的树散列；`none` 绑不上
 * （`not_git` 不在 git 仓库里、`too_large` 未跟踪的文件太多太大、`sparse_checkout`、`unavailable` git 出错或超时）。
 */
export const CodeStateSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('git'), head: z.string().nullable(), tree: z.string().min(1) }),
  z.object({ kind: z.literal('none'), reason: z.string().min(1) }),
]);
export type CodeState = z.infer<typeof CodeStateSchema>;

/**
 * 一次检查运行的状态：`not_run` 没有运行（`reason`：`approval_required` 脚本正文变了待重新认可、`not_applicable`、
 * `changes_unknown` 不知道回合改了什么）、`running`、`passed`、`failed`（`exit_code` / `no_tests` / `tests_unconfirmed` /
 * `expect_unmatched`）、`timed_out`、`cancelled`（`user` / `turn_started` / `host_restarted` / `session_closed`）、
 * `environment_unavailable`（`cwd_missing` / `dependencies_missing` / `command_not_found` / `spawn_failed`；0.70.0 起还有预检的原因，
 * 例如 `dependencies_outdated`、`lockfile_mismatch`、`version_mismatch`、`not_found`）、`stale`（检查期间代码变了，
 * `code_changed`）。`reason` 是开放字符串。
 */
export const VerificationStatusSchema = z.enum([
  'not_run',
  'running',
  'passed',
  'failed',
  'timed_out',
  'cancelled',
  'environment_unavailable',
  'stale',
]);
export type VerificationStatus = z.infer<typeof VerificationStatusSchema>;

/** 检查为什么跑：用户运行、回合后自动、修复后复验。 */
export const VerificationTriggerSchema = z.enum(['manual', 'after_turn', 'repair']);
export type VerificationTrigger = z.infer<typeof VerificationTriggerSchema>;

/** 从输出里识别出的测试计数。 */
export const VerificationTestsSchema = z.object({
  passed: z.int().min(0),
  failed: z.int().min(0),
  skipped: z.int().min(0),
});
export type VerificationTests = z.infer<typeof VerificationTestsSchema>;

/** 一条验证记录：一次检查运行。与回合分开，`turnId` 只说明它验证的是哪个回合之后的代码。 */
export const VerificationRunSchema = z.object({
  id: VerificationRunIdSchema,
  roundId: VerificationRoundIdSchema,
  checkId: CheckIdSchema,
  /** 运行时检查的版本与内容。 */
  checkRevision: z.int().min(1),
  name: z.string().min(1),
  command: z.string().min(1),
  /** 相对会话目录。 */
  cwd: z.string(),
  kind: CheckKindSchema,
  trigger: VerificationTriggerSchema,
  turnId: TurnIdSchema.optional(),
  repairId: RepairIdSchema.optional(),
  /** 修复后复验时是第几次修复之后。 */
  attempt: z.int().min(1).optional(),
  status: VerificationStatusSchema,
  reason: z.string().min(1).optional(),
  /** 开始运行时的代码状态；排队中、或还没算出来时省略。 */
  codeState: CodeStateSchema.optional(),
  queuedAt: IsoTimeSchema,
  startedAt: IsoTimeSchema.optional(),
  finishedAt: IsoTimeSchema.optional(),
  durationMs: z.int().min(0).optional(),
  exitCode: z.int().nullable().optional(),
  signal: z.string().optional(),
  tests: VerificationTestsSchema.optional(),
  /** 输出的尾部（去掉了 ANSI 控制序列）。 */
  summary: z.string().max(VERIFICATION_SUMMARY_MAX_LENGTH).optional(),
  /** 完整输出：用 `verification.output` 读；`truncated` 时开头部分已因上限丢弃。 */
  output: z.object({ bytes: z.int().min(0), truncated: z.boolean() }).optional(),
  /** 失败的错误指纹（同一错误反复出现时相同）。 */
  fingerprint: z.string().optional(),
  /**
   * 检查失败、而项目环境的预检有不就绪的阻塞项时（0.70.0，Host 功能 `workspace_readiness`），记成 `environment_unavailable`
   * （`reason` 是第一项的原因），这里列出那几项。
   */
  readiness: z
    .array(
      z.object({
        kind: z.string().min(1).max(40),
        name: z.string().min(1).max(100),
        path: z.string().max(500),
        status: ReadinessStatusSchema,
        reason: z.string().min(1).max(80).optional(),
      }),
    )
    .max(8)
    .optional(),
});
export type VerificationRun = z.infer<typeof VerificationRunSchema>;

/**
 * 会话的验收状态，与引擎的回合状态分开：`unverified` 未验收（没跑过、之后又改了代码、取消、过期）、`verifying` 验证中、`accepted`
 * 最近一轮全部通过且代码没变、`failed` 验证失败、`environment_unavailable` 环境不可用。
 */
export const AcceptanceStatusSchema = z.enum([
  'unverified',
  'verifying',
  'accepted',
  'failed',
  'environment_unavailable',
]);
export type AcceptanceStatus = z.infer<typeof AcceptanceStatusSchema>;

export const SessionAcceptanceSchema = z.object({
  status: AcceptanceStatusSchema,
  /** 依据的那一轮。 */
  roundId: VerificationRoundIdSchema.optional(),
  turnId: TurnIdSchema.optional(),
  codeState: CodeStateSchema.optional(),
  /** `unverified` 的原因（`code_changed`、`cancelled`、`stale`…），开放字符串。 */
  reason: z.string().min(1).optional(),
  updatedAt: IsoTimeSchema,
});
export type SessionAcceptance = z.infer<typeof SessionAcceptanceSchema>;

/** 修复链：`running` 进行中；`passed` 修好了（复验通过）；`stopped` 停下（`stopReason`）。 */
export const RepairStatusSchema = z.enum(['running', 'passed', 'stopped']);
export type RepairStatus = z.infer<typeof RepairStatusSchema>;

/**
 * 修复链停下的原因（开放字符串）：`limit` 达到次数、`repeated_failure` 同一错误又出现、`budget` 超出时长或 token、
 * `environment_unavailable`、`permission_denied` 修复回合里有审批被拒、`user_cancelled` 用户停止、`user_message` 用户发了新消息、
 * `turn_failed` 修复回合失败或中断、`not_repairable` 失败不是代码问题（超时、无法确认测试）、`disabled` 用户关了自动修复、
 * `host_restarted`。
 */
export const RepairChainSchema = z.object({
  id: RepairIdSchema,
  /** 开这条链的那一轮（回合后自动运行的）。 */
  roundId: VerificationRoundIdSchema,
  /** 原任务的回合。 */
  originTurnId: TurnIdSchema,
  status: RepairStatusSchema,
  /** 已经开始的修复次数。 */
  attempt: z.int().min(0),
  maxAttempts: z.int().min(1),
  /** 修复回合，按先后。 */
  turnIds: z.array(TurnIdSchema),
  /** 最近一轮复验。 */
  lastRoundId: VerificationRoundIdSchema.optional(),
  stopReason: z.string().min(1).optional(),
  startedAt: IsoTimeSchema,
  updatedAt: IsoTimeSchema,
});
export type RepairChain = z.infer<typeof RepairChainSchema>;

/** `user.message` 的 `from.repair`：这条消息是 Host 为修复链交给 Agent 的材料。 */
export const RepairFromSchema = z.object({
  repairId: RepairIdSchema,
  attempt: z.int().min(1),
  maxAttempts: z.int().min(1),
  roundId: VerificationRoundIdSchema,
  originTurnId: TurnIdSchema,
});
export type RepairFrom = z.infer<typeof RepairFromSchema>;

/** 快照里的验证部分：验收状态、最近一轮与每个检查最近的一条记录、最近的修复链。 */
export const SessionVerificationSchema = z.object({
  acceptance: SessionAcceptanceSchema,
  runs: z.array(VerificationRunSchema),
  repair: RepairChainSchema.optional(),
});
export type SessionVerification = z.infer<typeof SessionVerificationSchema>;

// ── 方法 ───────────────────────────────────────────────────────

export const ChecksListParamsSchema = z.object({ workspaceId: WorkspaceIdSchema });
export const ChecksListResultSchema = z.object({
  checks: z.array(CheckDefinitionSchema),
  repair: RepairSettingsSchema,
});

export const ChecksCandidatesParamsSchema = z.object({ workspaceId: WorkspaceIdSchema });
export const ChecksCandidatesResultSchema = z.object({
  candidates: z.array(CheckCandidateSchema),
});

export const ChecksSaveParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  check: CheckInputSchema,
});
export const ChecksSaveResultSchema = z.object({ check: CheckDefinitionSchema });

export const ChecksRemoveParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  checkId: CheckIdSchema,
});
export const ChecksRemoveResultSchema = z.object({ removed: z.boolean() });

export const ChecksSetRepairParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  repair: RepairSettingsSchema.partial(),
});
export const ChecksSetRepairResultSchema = z.object({ repair: RepairSettingsSchema });

/** `verification.run`：会话空闲时运行检查（省略 `checkIds` 是全部）。 */
export const VerificationRunParamsSchema = z.object({
  sessionId: SessionIdSchema,
  checkIds: z.array(CheckIdSchema).min(1).max(CHECKS_MAX_PER_WORKSPACE).optional(),
});
export const VerificationRunResultSchema = z.object({
  roundId: VerificationRoundIdSchema,
  runs: z.array(VerificationRunSchema),
});

/** `verification.cancel`：取消会话里还在跑或排着的检查，并停下进行中的修复链。 */
export const VerificationCancelParamsSchema = z.object({ sessionId: SessionIdSchema });
export const VerificationCancelResultSchema = z.object({ cancelled: z.int().min(0) });

/** `verification.status`：重算此刻的代码状态，与验收的那一轮不同时验收回到 `unverified`。 */
export const VerificationStatusParamsSchema = z.object({ sessionId: SessionIdSchema });
export const VerificationStatusResultSchema = z.object({
  verification: SessionVerificationSchema,
  codeState: CodeStateSchema,
});

/** `verification.output`：一条记录的完整输出，从 `offset` 字节起最多 `VERIFICATION_OUTPUT_PAGE_MAX_BYTES`。 */
export const VerificationOutputParamsSchema = z.object({
  sessionId: SessionIdSchema,
  runId: VerificationRunIdSchema,
  offset: z.int().min(0).optional(),
});
export const VerificationOutputResultSchema = z.object({
  text: z.string(),
  /** 这一段从哪个字节开始（开头已被丢弃时大于请求的 `offset`）。 */
  from: z.int().min(0),
  next: z.int().min(0),
  more: z.boolean(),
  bytes: z.int().min(0),
});
