// 护栏（0.86.0，Host 功能 `tuning_guardrails`，domain-model §3.40）。
//
// 模型绕不过去的硬约束：用户写声明式规则，Host 把随包分发的检查程序作为引擎的 hook 挂到会话上（只有 Codex），引擎在执行命令、改文件
// 与结束回合之前问它。规则存在 Host 的数据目录（`<数据目录>/guardrails/<工作区 ID|global>.json`），不写回仓库；全局的对所有项目有效，
// 项目的只对这个项目。规则的增删改与开关在检查程序下一次被调用时就生效；某种规则第一次出现时（原来没挂对应的 hook），从下一个建立或
// 恢复的引擎会话起生效。
//
// 仓库自带的 hooks（`.codex/hooks.json`、`.codex/config.toml` 的 `[hooks]`）默认不执行；`repoHook.list` 列出检测到的，用户逐个启用，
// 启用记的是当时的内容散列，仓库里改了就要重新启用。

import { z } from 'zod';
import { GuardrailIdSchema, IsoTimeSchema, TurnIdSchema, WorkspaceIdSchema } from './common.js';

/** 一个范围（全局或一个项目）里最多几条规则。 */
export const GUARDRAILS_MAX_PER_SCOPE = 50;
/** 命令模式、glob、检查命令的长度上限（字符）。 */
export const GUARDRAIL_PATTERN_MAX_LENGTH = 1000;
export const GUARDRAIL_COMMAND_MAX_LENGTH = 2000;
/** 规则名的长度上限。 */
export const GUARDRAIL_NAME_MAX_LENGTH = 80;
/** 结束前检查：同一回合最多让 Agent 继续几次（默认与上限）。 */
export const STOP_CHECK_ATTEMPTS_DEFAULT = 3;
export const STOP_CHECK_ATTEMPTS_MAX = 10;
/** 检查命令的时限（秒，默认与上限）。 */
export const GUARDRAIL_CHECK_TIMEOUT_DEFAULT_SEC = 600;
export const GUARDRAIL_CHECK_TIMEOUT_MAX_SEC = 3600;
/** `guardrail.blocked` 里命令、路径、原因的长度上限（按码点，超出截断）。 */
export const GUARDRAIL_EVENT_TEXT_MAX_LENGTH = 2000;

/**
 * 规则的种类：
 * - `forbidden_command`：执行命令前，命令（拆成的每一段，去掉 `sudo`、`env`、变量赋值等前缀；`sh -c` 里的也看）以前缀开头，或整条命令
 *   匹配正则时拒绝；
 * - `protected_path`：改文件（`apply_patch` 增删改与改名的每个路径）或执行写入一类命令（重定向、`rm`、`mv`、`cp`、`sed -i` 等）前，
 *   路径匹配 glob 时拒绝。不带 `/` 的 glob 匹配任何层级的文件名，带 `/` 的相对会话目录；
 * - `stop_check`：回合结束前在会话目录跑命令，失败时把输出交给 Agent、让它接着做；同一回合最多 `maxAttempts` 次，之后放行；
 * - `commit_check`：执行 `git commit` 前跑命令，失败时拒绝这次提交。
 */
export const GuardrailKindSchema = z.enum([
  'forbidden_command',
  'protected_path',
  'stop_check',
  'commit_check',
]);
export type GuardrailKind = z.infer<typeof GuardrailKindSchema>;

const CheckCommandSchema = z.string().trim().min(1).max(GUARDRAIL_COMMAND_MAX_LENGTH);
const TimeoutSchema = z.int().min(1).max(GUARDRAIL_CHECK_TIMEOUT_MAX_SEC);

export const GuardrailRuleSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('forbidden_command'),
    /** `prefix` 按词比较（`rm -rf`），`regex` 是 JavaScript 正则，匹配整条命令。 */
    match: z.enum(['prefix', 'regex']),
    pattern: z.string().trim().min(1).max(GUARDRAIL_PATTERN_MAX_LENGTH),
  }),
  z.object({
    kind: z.literal('protected_path'),
    glob: z.string().trim().min(1).max(GUARDRAIL_PATTERN_MAX_LENGTH),
  }),
  z.object({
    kind: z.literal('stop_check'),
    command: CheckCommandSchema,
    maxAttempts: z.int().min(1).max(STOP_CHECK_ATTEMPTS_MAX).optional(),
    timeoutSec: TimeoutSchema.optional(),
  }),
  z.object({
    kind: z.literal('commit_check'),
    command: CheckCommandSchema,
    timeoutSec: TimeoutSchema.optional(),
  }),
]);
export type GuardrailRule = z.infer<typeof GuardrailRuleSchema>;

export const GuardrailSchema = z.object({
  id: GuardrailIdSchema,
  /** 省略是全局规则。 */
  workspaceId: WorkspaceIdSchema.optional(),
  name: z.string().max(GUARDRAIL_NAME_MAX_LENGTH).optional(),
  rule: GuardrailRuleSchema,
  enabled: z.boolean(),
  /** 每次改动（名字、规则、开关）加一，从 1 起；命中计数不算。 */
  revision: z.int().min(1),
  createdAt: IsoTimeSchema,
  updatedAt: IsoTimeSchema,
  /** 拦下（或让 Agent 继续）的次数。 */
  hits: z.int().min(0),
  lastHitAt: IsoTimeSchema.optional(),
});
export type Guardrail = z.infer<typeof GuardrailSchema>;

/**
 * 仓库自带的一个 hook（只列 Codex 会读的：从仓库根到项目目录一路上的 `.codex/hooks.json` 与 `.codex/config.toml` 的 `[hooks]`）。
 * `id` 在这个项目里稳定（`<相对路径>:<事件>:<组序号>:<处理器序号>`）；`hash` 是内容散列（事件、matcher 与处理器的全部字段），内容一改就变。
 */
export const RepoHookSchema = z.object({
  id: z.string().min(1),
  /** 相对项目根，`/` 分隔。 */
  file: z.string().min(1),
  /** Codex 的事件名（`PreToolUse`、`Stop`…），开放字符串。 */
  event: z.string().min(1),
  matcher: z.string().optional(),
  /** 处理器种类：`command`、`mcp_tool`、`prompt`、`agent`。开放字符串；只有 `command` 能启用。 */
  handler: z.string().min(1),
  command: z.string().optional(),
  timeoutSec: z.int().min(1).optional(),
  hash: z.string().min(1),
  /**
   * `disabled` 没启用（默认）；`enabled` 启用了，内容与启用时一样；`changed` 启用过但内容变了，不执行，要重新启用；`unsupported` 不是
   * 命令 hook，Wevir 不执行。
   */
  status: z.string().min(1),
  enabledAt: IsoTimeSchema.optional(),
});
export type RepoHook = z.infer<typeof RepoHookSchema>;
export type RepoHookStatus = 'disabled' | 'enabled' | 'changed' | 'unsupported';

/**
 * 一次拦截（`guardrail.blocked` 事件）。`action`：`denied` 拒绝了命令或改动（理由交给了 Agent）；`continued` 结束前检查失败，Agent
 * 接着做；`allowed` 结束前检查仍失败但已到次数上限，放行。
 */
export const GuardrailBlockedSchema = z.object({
  /** 拦下它的规则；规则已被删掉时照样带原来的 ID。 */
  guardrailId: GuardrailIdSchema,
  kind: GuardrailKindSchema,
  /** 开放字符串：`denied`、`continued`、`allowed`。 */
  action: z.string().min(1),
  turnId: TurnIdSchema.optional(),
  /** 引擎的工具名（`Bash`、`apply_patch`）；结束前检查没有。 */
  tool: z.string().optional(),
  command: z.string().max(GUARDRAIL_EVENT_TEXT_MAX_LENGTH).optional(),
  path: z.string().max(GUARDRAIL_EVENT_TEXT_MAX_LENGTH).optional(),
  /** 交给 Agent 的理由（检查失败时含输出的末尾）。 */
  reason: z.string().max(GUARDRAIL_EVENT_TEXT_MAX_LENGTH),
  /** 结束前检查：这是本回合第几次、最多几次。 */
  attempt: z.int().min(1).optional(),
  maxAttempts: z.int().min(1).optional(),
});
export type GuardrailBlocked = z.infer<typeof GuardrailBlockedSchema>;

// ── guardrail.* ─────────────────────────────────────────────────────────

export const GuardrailListParamsSchema = z.object({
  /** 给了列全局的与这个项目的；省略只列全局的。 */
  workspaceId: WorkspaceIdSchema.optional(),
});

/** 全局的在前，各自按创建先后。 */
export const GuardrailListResultSchema = z.object({
  guardrails: z.array(GuardrailSchema),
});

export const GuardrailAddParamsSchema = z.object({
  /** 省略加全局规则。 */
  workspaceId: WorkspaceIdSchema.optional(),
  name: z.string().trim().max(GUARDRAIL_NAME_MAX_LENGTH).optional(),
  rule: GuardrailRuleSchema,
  /** 默认 true。 */
  enabled: z.boolean().optional(),
});

/** 正则写错、glob 为空、范围里规则已满时 `INVALID_PARAMS`。 */
export const GuardrailResultSchema = z.object({
  guardrail: GuardrailSchema,
});

export const GuardrailUpdateParamsSchema = z.object({
  guardrailId: GuardrailIdSchema,
  /** `null` 去掉名字。 */
  name: z.string().trim().max(GUARDRAIL_NAME_MAX_LENGTH).nullable().optional(),
  /** 整条换掉；种类可以变。 */
  rule: GuardrailRuleSchema.optional(),
});

export const GuardrailDeleteParamsSchema = z.object({
  guardrailId: GuardrailIdSchema,
});

export const GuardrailSetEnabledParamsSchema = z.object({
  guardrailId: GuardrailIdSchema,
  enabled: z.boolean(),
});

// ── repoHook.* ──────────────────────────────────────────────────────────

export const RepoHookListParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema,
});

/** 读不出的文件不列，原因在 `warnings`（相对项目根的路径与说明）。 */
export const RepoHookListResultSchema = z.object({
  hooks: z.array(RepoHookSchema),
  warnings: z.array(z.string()),
});

export const RepoHookSetEnabledParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  hookId: z.string().min(1),
  enabled: z.boolean(),
});

/** 不在当前检测到的 hooks 里时 `INVALID_PARAMS`；不是命令 hook 时启用回 `INVALID_PARAMS`。 */
export const RepoHookResultSchema = z.object({
  hook: RepoHookSchema,
});

/**
 * `guardrail.changed`：规则或仓库 hooks 的启用变了（任何客户端或 Host 自己，命中计数变化也算）。`workspaceId` 省略是全局的规则。发给
 * 调用过 `guardrail.*` 或 `repoHook.*` 的连接。
 */
export const GuardrailChangedParamsSchema = z.object({
  workspaceId: WorkspaceIdSchema.optional(),
});
