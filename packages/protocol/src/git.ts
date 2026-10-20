// 工作区的 Git：diff 的范围与对象 ID（0.20.0 起在 methods.ts，0.67.0 移到这里，形状不变）；0.67.0 起另有按文件暂存与提交
// （`git.*`，Host 功能 `git_commit`，ADR-0009）。
//
// 暂存与提交只由用户在“变更”窗格发起，不是 Agent 的工具。每次写操作带上读状态时的 HEAD 与索引（`expected`），Host 先核对，
// 不同就回 GIT_STATE_CHANGED，不按过时的画面操作。Host 不 `git add .`，只暂存用户点的文件；不是经 Wevir 暂存的内容（之前就在
// 索引里、或别的进程加的）标为 `external`，用户明确勾选才一起提交。提交用用户平常的 Git 配置（钩子、签名照常），失败时什么都不
// 回滚，结果说明是哪一步失败、附上输出。

import { z } from 'zod';
import {
  CheckIdSchema,
  IsoTimeSchema,
  SessionIdSchema,
  TurnIdSchema,
  VerificationRunIdSchema,
  WorkspaceIdSchema,
} from './common.js';
import { CodeStateSchema, VerificationStatusSchema } from './verification.js';

/**
 * 读哪一段改动：`uncommitted` 是工作树加暂存区对 HEAD（含未跟踪文件），`branch` 是工作树对默认分支的 merge-base，`turn` 是
 * 会话一个回合前后的快照（host-api.md §3.1）；`staged`（0.67.0，Host 功能 `git_commit`）是暂存区对 HEAD（还没有提交时对空树），
 * 新的一侧是索引，没有 `workspace.diffFile` 的全文，也不能写批注。
 */
export const DiffSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('uncommitted') }),
  z.object({ kind: z.literal('branch') }),
  z.object({ kind: z.literal('turn'), turnId: TurnIdSchema }),
  z.object({ kind: z.literal('staged') }),
]);
export type DiffSource = z.infer<typeof DiffSourceSchema>;

/** 提交或树对象的完整 SHA（SHA-1 40 位、SHA-256 64 位，小写）。 */
export const GitObjectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

// ── git.status / git.stage / git.unstage / git.commit（0.67.0） ──────────────

/** `git.status` 的文件列表最多这么多项，多了 `truncated`。 */
export const GIT_STATUS_MAX_FILES = 2000;
/** `git.stage` / `git.unstage` 一次最多几个路径。 */
export const GIT_PATHS_MAX = 1000;
/** 提交说明的上限（字符）。 */
export const GIT_COMMIT_MESSAGE_MAX_LENGTH = 64 * 1024;
/** 提交失败时 `output` 留的尾部（字符）。 */
export const GIT_COMMIT_OUTPUT_MAX_LENGTH = 16 * 1024;

/** 索引的指纹：`git ls-files --stage -z` 的 SHA-256（小写 64 位）。 */
export const GitIndexTokenSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** 读状态时的 HEAD 与索引，写操作原样带回给 Host 核对。`head` 为 `null` 是还没有提交。 */
export const GitExpectedStateSchema = z.object({
  head: GitObjectIdSchema.nullable(),
  index: GitIndexTokenSchema,
});
export type GitExpectedState = z.infer<typeof GitExpectedStateSchema>;

/** 文件一侧的改动：`status` 已见 `added` / `modified` / `deleted` / `type_changed` / `untracked`，开放字符串；二进制没有增删行数。 */
export const GitFileSideSchema = z.object({
  status: z.string().min(1),
  added: z.int().min(0).optional(),
  removed: z.int().min(0).optional(),
});
export type GitFileSide = z.infer<typeof GitFileSideSchema>;

/**
 * 谁暂存的：`wevir` 是经 `git.stage` 暂存、之后没再变过的内容；`external` 是别的（之前就在索引里、终端或别的进程加的）。Host 只在
 * 内存里记，Host 重启后之前暂存的都算 `external`。
 */
export const GitStagedBySchema = z.enum(['wevir', 'external']);
export type GitStagedBy = z.infer<typeof GitStagedBySchema>;

export const GitStatusFileSchema = z.object({
  /** 相对会话或工作区目录，`/` 分隔；`outside` 时相对仓库根目录。 */
  path: z.string().min(1),
  /** 暂存区对 HEAD（不跟踪重命名，重命名是一删一加）。 */
  staged: GitFileSideSchema.extend({ by: GitStagedBySchema }).optional(),
  /** 工作树对暂存区；未跟踪文件是 `untracked`。 */
  unstaged: GitFileSideSchema.optional(),
  /** 有合并冲突。 */
  conflicted: z.literal(true).optional(),
  /** 在目录之外（目录是仓库的子目录时），只会是暂存的内容，提交时一起带上；不能在这里暂存或取消。 */
  outside: z.literal(true).optional(),
});
export type GitStatusFile = z.infer<typeof GitStatusFileSchema>;

/**
 * 同一代码状态的验证记录（只显示，不阻止提交）：每项检查最近的一条，代码状态与现在相同时是它的状态，不同时是 `stale`，没有记录是
 * `not_run`。
 */
export const GitVerificationCheckSchema = z.object({
  checkId: CheckIdSchema,
  name: z.string().min(1),
  status: VerificationStatusSchema,
  runId: VerificationRunIdSchema.optional(),
  finishedAt: IsoTimeSchema.optional(),
});
export type GitVerificationCheck = z.infer<typeof GitVerificationCheckSchema>;

export const GitVerificationSummarySchema = z.object({
  checks: z.array(GitVerificationCheckSchema),
  /**
   * 暂存的树与工作树（验证记录的代码状态）相同：检查跑的正是要提交的内容。不同时（还有没暂存的改动、未跟踪文件）记录验证的是
   * 工作树，不是这次提交。
   */
  stagedMatchesWorkingTree: z.boolean(),
});
export type GitVerificationSummary = z.infer<typeof GitVerificationSummarySchema>;

export const GitStatusParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  /** 读这个会话的目录（环境会话的 worktree），验证记录也取这个会话的；省略时读工作区目录、没有验证记录。 */
  sessionId: SessionIdSchema.optional(),
});

/** `repo: false`（不是仓库、没有 git、出错或超时）时其余字段都省略。 */
export const GitStatusResultSchema = z.object({
  repo: z.boolean(),
  /** HEAD 的提交；还没有提交时 `null`。 */
  head: GitObjectIdSchema.nullable().optional(),
  /** 当前分支；分离头指针时省略。 */
  branch: z.string().min(1).optional(),
  index: GitIndexTokenSchema.optional(),
  files: z.array(GitStatusFileSchema).max(GIT_STATUS_MAX_FILES).optional(),
  fileCount: z.int().min(0).optional(),
  truncated: z.literal(true).optional(),
  /** 暂存区写成的树（提交后的树应当是它）；有冲突时省略。 */
  stagedTree: GitObjectIdSchema.optional(),
  /** 目录此刻的代码状态（同验证记录）。 */
  codeState: CodeStateSchema.optional(),
  /** 进行中的操作：`merge` / `rebase` / `cherry_pick` / `revert`；开放字符串。有它时不能在这里提交。 */
  operation: z.string().min(1).optional(),
  verification: GitVerificationSummarySchema.optional(),
});
export type GitStatusResult = z.infer<typeof GitStatusResultSchema>;

/** `git.stage` / `git.unstage`：路径相对目录，只动这几个文件。 */
export const GitPathsParamsSchema = GitStatusParamsSchema.extend({
  paths: z.array(z.string().min(1)).min(1).max(GIT_PATHS_MAX),
  expected: GitExpectedStateSchema,
});

export const GitPathsResultSchema = z.object({ status: GitStatusResultSchema });

export const GitCommitParamsSchema = GitStatusParamsSchema.extend({
  message: z.string().min(1).max(GIT_COMMIT_MESSAGE_MAX_LENGTH),
  expected: GitExpectedStateSchema,
  /** 一起提交 `external` 的暂存内容；省略时有这样的内容就不提交（`external_staged`）。 */
  includeExternal: z.boolean().optional(),
});

/**
 * 提交的结果。`committed`：`tree` 与 `stagedTree` 不同（`treeChanged`）是钩子改了暂存区、或提交期间别的进程改了索引；`hooks` 是
 * 跑过的钩子。`failed`：什么都没回滚，`reason` 已见 `hook_failed`（`hook` 是钩子名）、`signing_failed`、`identity_missing`、
 * `index_locked`、`empty_message`、`unmerged`、`nothing_staged`、`external_staged`、`operation_in_progress`、`timed_out`、
 * `git_failed`，开放字符串；`output` 是 git 与钩子输出的尾部。
 */
export const GitCommitOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('committed'),
    commit: GitObjectIdSchema,
    parent: GitObjectIdSchema.nullable(),
    tree: GitObjectIdSchema,
    stagedTree: GitObjectIdSchema,
    treeChanged: z.literal(true).optional(),
    hooks: z.array(z.string().min(1)).optional(),
  }),
  z.object({
    kind: z.literal('failed'),
    reason: z.string().min(1),
    hook: z.string().min(1).optional(),
    exitCode: z.int().nullable().optional(),
    output: z.string().max(GIT_COMMIT_OUTPUT_MAX_LENGTH).optional(),
  }),
]);
export type GitCommitOutcome = z.infer<typeof GitCommitOutcomeSchema>;

export const GitCommitResultSchema = z.object({
  outcome: GitCommitOutcomeSchema,
  /** 操作之后的状态。 */
  status: GitStatusResultSchema,
});
export type GitCommitResult = z.infer<typeof GitCommitResultSchema>;
