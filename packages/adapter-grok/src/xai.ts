// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-grok/src/server/acpSupport.ts（`grokAcpSpawnArgs`、`GROK_ACP_CANCEL_META`、`GROK_ACP_INITIALIZE_META`、`grokApprovalOptions`）、packages/provider-grok/src/server/xaiAcpExtension.ts（`xAiPromptCompleteFromSessionUpdate`、`promptResponseFromXAi`、`xAiPromptFailure`、`extractXAiAskUserQuestions`、`makeXAiAskUserQuestionResponse`、`extractXAiExitPlanMarkdown`、`makeXAiExitPlanModeCapturedResponse`）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：改写成不依赖 `effect` 的普通 TS，Schema 解码换成手写的字段检查；T3 的运行模式换成 Wevir 的权限模式；审批选项不再
// 换成 T3 的决定，只过滤 Grok 给的选项；提问的回答按 Wevir 的 `respondToQuestion`（问题 ID → 选项 label 或填写的文本）；
// 退出计划模式照 T3 把计划报成计划条目（0.36.0 起，`plan.proposed`）、放弃这道关等用户，不再当审批问；计划只取请求里的
// `planContent`，不去找 Grok 写的 plan.md。
//
// Grok Build 的 ACP 扩展（grok-event-mapping.md §1、§4、§5）：启动参数、`initialize` 与 `session/cancel` 的 `_meta`、审批
// 选项、引擎自己报的回合结束（`prompt_complete` / `turn_completed`）、向用户提问（`ask_user_question`）与退出计划模式
// （`exit_plan_mode`）。方法名都有带 `_` 与不带 `_` 两种写法（发布版用 `_x.ai/…`，开源的运行时用 `x.ai/…`）。

import type { ApprovalOption, PermissionMode, UserQuestion } from '@wevir/runtime-adapter';

/** Grok 能以哪几种权限模式启动：问、它自己的自动分类器、全部自动批准（T3 的 `GROK_SUPPORTED_RUNTIME_MODES`）。 */
export const GROK_PERMISSION_MODES: readonly PermissionMode[] = Object.freeze([
  'on_request',
  'auto_review',
  'full_access',
]);

/**
 * 权限模式 → `grok` 的启动参数（T3 的 `grokAcpSpawnArgs`）。命令行上的 `--permission-mode` 压过用户 Grok 配置里的设置，
 * 所以“请求批准”不会继承配置里的 always-approve。权限模式在启动时定下，会话中途不能改（grok-event-mapping.md §6）。
 */
export function grokSpawnArgs(mode: PermissionMode): string[] {
  switch (mode) {
    case 'auto_review':
      return ['--permission-mode', 'auto', 'agent', 'stdio'];
    case 'full_access':
      return ['agent', '--always-approve', 'stdio'];
    default:
      return ['--permission-mode', 'default', 'agent', 'stdio'];
  }
}

/**
 * `initialize` 的 `_meta`（T3 的 `GROK_ACP_INITIALIZE_META`）：自动模式下分类器拦下的操作，Grok 只在客户端声明自己能弹出
 * 询问时才问（`extension`），默认的 `generic` 直接拒绝。
 */
export const GROK_INITIALIZE_META = Object.freeze({ clientType: 'extension' });

/**
 * `session/cancel` 的 `_meta`（T3 的 `GROK_ACP_CANCEL_META`）：Grok 把 Ctrl+C 式的取消当作屏障，之后直到用户下一次真的发
 * 消息之前，不再因为后台任务结束而自己开回合。
 */
export const GROK_CANCEL_META = Object.freeze({ cancelTrigger: 'ctrl_c' });

/**
 * Grok 唯一只在本会话有效的 `allow_always`：编辑审批的“本会话允许所有编辑”。命令、监视与 MCP 的 `always-allow` 会给整个
 * 项目存一条比会话活得长的授权（T3 引 grok-build 的 `prompter.rs` / `grants.rs`）。
 */
export const GROK_ALLOW_EDITS_SESSION_OPTION_ID = 'allow-edits-session';

/**
 * 交给用户的审批选项（T3 的 `grokApprovalOptions`）：只留一次性的批准与拒绝，加上本会话允许编辑；对整个项目长期有效的
 * `always-allow` / `reject-always` 去掉，权限的长期变化只经 Wevir 的权限模式。
 */
export function grokApprovalOptions(options: ApprovalOption[]): ApprovalOption[] {
  return options.filter(
    (option) =>
      option.kind === 'allow_once' ||
      option.kind === 'reject_once' ||
      (option.kind === 'allow_always' &&
        option.optionId.trim() === GROK_ALLOW_EDITS_SESSION_OPTION_ID),
  );
}

// ── 回合结束 ──────────────────────────────────────────────────────────────────────

/** 引擎自己报回合结束的扩展通知。 */
export const XAI_PROMPT_COMPLETE_METHODS: readonly string[] = Object.freeze([
  'x.ai/session/prompt_complete',
  '_x.ai/session/prompt_complete',
]);

/** 带 `update.sessionUpdate` 的扩展通知（`turn_completed`、子 agent、后台任务等都走这里）。 */
export const XAI_SESSION_NOTIFICATION_METHODS: readonly string[] = Object.freeze([
  'x.ai/session_notification',
  '_x.ai/session_notification',
  '_x.ai/session/update',
]);

/** 后台任务结束后 Grok 自己开的回合，`promptId` 是这个前缀（T3 的 `XAI_TASK_COMPLETED_PROMPT_ID_PREFIX`）。 */
export const XAI_TASK_COMPLETED_PROMPT_ID_PREFIX = 'task-completed-';

/** Grok 的用量上限错误码（T3 的 `xAiRateLimitedErrorCode`）。 */
export const XAI_RATE_LIMITED_CODE = -32003;

export interface XAiPromptComplete {
  sessionId: string;
  promptId?: string;
  stopReason?: string;
  agentResult?: unknown;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * 一条扩展通知若是根会话一个回合的结束，取出它（T3 的 `xAiPromptCompleteFromSessionUpdate` 与 `prompt_complete` 的解码）：
 * `prompt_complete` 本身，或 `session_notification` 里带 `prompt_id` 的 `turn_completed`。后台任务的回合
 * （`task-completed-*`）与没有 `prompt_id` 的不算。
 */
export function promptCompleteOf(method: string, params: unknown): XAiPromptComplete | undefined {
  const fields = record(params);
  const sessionId = nonEmpty(fields?.sessionId);
  if (fields === undefined || sessionId === undefined) return undefined;
  let complete: XAiPromptComplete;
  if (XAI_PROMPT_COMPLETE_METHODS.includes(method)) {
    complete = {
      sessionId,
      ...optional('promptId', nonEmpty(fields.promptId)),
      ...optional('stopReason', nonEmpty(fields.stopReason)),
      ...('agentResult' in fields && { agentResult: fields.agentResult }),
    };
  } else if (XAI_SESSION_NOTIFICATION_METHODS.includes(method)) {
    const update = record(fields.update);
    if (update?.sessionUpdate !== 'turn_completed') return undefined;
    const promptId = nonEmpty(update.prompt_id) ?? nonEmpty(update.promptId);
    if (promptId === undefined) return undefined;
    complete = {
      sessionId,
      promptId,
      ...optional('stopReason', nonEmpty(update.stop_reason) ?? nonEmpty(update.stopReason)),
      ...('agent_result' in update && { agentResult: update.agent_result }),
    };
  } else {
    return undefined;
  }
  if (complete.promptId?.startsWith(XAI_TASK_COMPLETED_PROMPT_ID_PREFIX)) return undefined;
  return complete;
}

/** 一个回合里一个模型的用量（0.62.0，`usage.recorded` 去掉 `type`、`engineSessionId` 与 `requestId`）。 */
export interface XAiModelUsage {
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  durationMs?: number;
}

/**
 * `turn_completed` 带的回合用量（0.62.0）。录到的 Grok 1.0.41：`usage` 有 `inputTokens`、`outputTokens`、`totalTokens`、
 * `cachedReadTokens`、`cacheCreationTokens`、`reasoningTokens`、`modelCalls`、`apiDurationMs`，`modelUsage` 按模型各一份
 * 同样的字段。`totalTokens` 是输入加输出，所以输入含缓存（OpenAI 口径，减掉缓存的读写才是事件的口径），推理含在输出里。
 * 按模型各报一条（没有 `modelUsage` 时报整份、不带模型），时长是这些请求的 `apiDurationMs` 之和；首个 token 的时间不报
 * （一个回合可能有几次调用）。后台任务的回合（`task-completed-*`）也算，它们同样花了 token。没有用量时 undefined。
 */
export function turnUsageOf(
  method: string,
  params: unknown,
): { sessionId: string; promptId: string; models: XAiModelUsage[] } | undefined {
  if (!XAI_SESSION_NOTIFICATION_METHODS.includes(method)) return undefined;
  const fields = record(params);
  const sessionId = nonEmpty(fields?.sessionId);
  const update = record(fields?.update);
  if (sessionId === undefined || update?.sessionUpdate !== 'turn_completed') return undefined;
  const promptId = nonEmpty(update.prompt_id) ?? nonEmpty(update.promptId);
  const usage = record(update.usage);
  if (promptId === undefined || usage === undefined) return undefined;
  const byModel = record(usage.modelUsage);
  const entries: Array<[string | undefined, Record<string, unknown>]> =
    byModel === undefined
      ? [[undefined, usage]]
      : Object.entries(byModel).flatMap(([model, value]) => {
          const entry = record(value);
          return entry === undefined ? [] : [[nonEmpty(model), entry] as const];
        });
  const models = entries.flatMap(([model, entry]) => {
    const parsed = modelUsageOf(entry);
    return parsed === undefined ? [] : [{ ...(model !== undefined && { model }), ...parsed }];
  });
  return models.length === 0 ? undefined : { sessionId, promptId, models };
}

function modelUsageOf(entry: Record<string, unknown>): XAiModelUsage | undefined {
  const count = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  const input = count(entry.inputTokens);
  const output = count(entry.outputTokens);
  if (input + output === 0) return undefined;
  const cacheRead = Math.min(count(entry.cachedReadTokens), input);
  const cacheWrite = Math.min(count(entry.cacheCreationTokens), input - cacheRead);
  const reasoning = Math.min(count(entry.reasoningTokens), output);
  const duration = count(entry.apiDurationMs);
  return {
    inputTokens: input - cacheRead - cacheWrite,
    outputTokens: output,
    ...(cacheRead > 0 && { cacheReadTokens: cacheRead }),
    ...(cacheWrite > 0 && { cacheWriteTokens: cacheWrite }),
    ...(reasoning > 0 && { reasoningTokens: reasoning }),
    ...(duration > 0 && { durationMs: duration }),
  };
}

function optional<K extends string>(key: K, value: string | undefined): { [P in K]?: string } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: string };
}

/** Grok 回合失败的原文（T3 的 `XAiPromptFailureText`），作为错误交给 `classifyTurnError`。 */
export class XAiPromptFailure extends Error {
  readonly code: number;
  constructor(message: string, code: number) {
    super(message);
    this.name = 'XAiPromptFailure';
    this.code = code;
  }
}

/**
 * 回合结束 → 停止原因或错误（T3 的 `promptResponseFromXAi` 与 `xAiPromptFailure`）：`rate_limit` 是用量上限，`error` 带
 * Grok 的原文（它先于 `session/prompt` 的错误到达）；其余不认识的停止原因按 `end_turn`。
 */
export function completionOf(
  complete: XAiPromptComplete,
): { stopReason: string } | { error: XAiPromptFailure } {
  switch (complete.stopReason) {
    case 'rate_limit':
      return {
        error: new XAiPromptFailure(
          nonEmpty(complete.agentResult) ?? 'Grok usage limit reached. Try again later.',
          XAI_RATE_LIMITED_CODE,
        ),
      };
    case 'error':
      return {
        error: new XAiPromptFailure(
          nonEmpty(complete.agentResult) ?? 'Grok ended the turn with an error.',
          -32603,
        ),
      };
    case 'cancelled':
    case 'end_turn':
    case 'max_tokens':
    case 'max_turn_requests':
    case 'refusal':
      return { stopReason: complete.stopReason };
    default:
      return { stopReason: 'end_turn' };
  }
}

// ── 向用户提问 ────────────────────────────────────────────────────────────────────

export const XAI_ASK_USER_QUESTION_METHODS: readonly string[] = Object.freeze([
  'x.ai/ask_user_question',
  '_x.ai/ask_user_question',
]);

export interface XAiQuestion {
  id?: string;
  question: string;
  options: Array<{ label: string; description?: string; preview?: string }>;
  multiSelect?: boolean | null;
}

export interface XAiAskUserQuestion {
  sessionId: string;
  toolCallId: string;
  questions: XAiQuestion[];
}

/** 扩展请求的参数可能包了一层 `{method, params}`（T3 的 `unwrapAskUserQuestionParams`）。 */
function unwrap(params: unknown): Record<string, unknown> | undefined {
  const fields = record(params);
  const inner = record(fields?.params);
  return typeof fields?.method === 'string' && inner !== undefined ? inner : fields;
}

/** `ask_user_question` 的参数（T3 的 `XAiAskUserQuestionRequest`）；形状不对时 undefined。 */
export function parseAskUserQuestion(params: unknown): XAiAskUserQuestion | undefined {
  const fields = unwrap(params);
  const sessionId = nonEmpty(fields?.sessionId);
  const toolCallId = nonEmpty(fields?.toolCallId);
  if (sessionId === undefined || toolCallId === undefined || !Array.isArray(fields?.questions)) {
    return undefined;
  }
  const questions: XAiQuestion[] = [];
  for (const entry of fields.questions) {
    const question = record(entry);
    if (typeof question?.question !== 'string' || !Array.isArray(question.options)) {
      return undefined;
    }
    const options: XAiQuestion['options'] = [];
    for (const raw of question.options) {
      const option = record(raw);
      if (typeof option?.label !== 'string') return undefined;
      options.push({
        label: option.label,
        ...optional('description', nonEmpty(option.description)),
        ...optional('preview', nonEmpty(option.preview)),
      });
    }
    questions.push({
      ...optional('id', nonEmpty(question.id)),
      question: question.question,
      options,
      multiSelect: question.multiSelect === true,
    });
  }
  return { sessionId, toolCallId, questions };
}

/**
 * Grok 的问题 → Wevir 的 `UserQuestion`（T3 的 `extractXAiAskUserQuestions`）：ID 是问题的 `id`，没有时用问题原文；没有选项
 * 时给一个 OK。Grok 接受不在选项里的回答（记为 Other 加备注），所以允许填写。
 */
export function toUserQuestions(questions: readonly XAiQuestion[]): UserQuestion[] {
  return questions.map((question) => ({
    id: question.id ?? question.question,
    question: question.question,
    options:
      question.options.length > 0
        ? question.options.map((option) => ({
            label: option.label,
            ...(option.description !== undefined && { description: option.description }),
          }))
        : [{ label: 'OK', description: 'Continue' }],
    ...(question.multiSelect === true && { multiSelect: true }),
    allowOther: true,
  }));
}

/**
 * 回答 → `ask_user_question` 的响应（T3 的 `makeXAiAskUserQuestionResponse`）：按问题原文给选中的 label；不在选项里的回答记
 * 为 `Other`，原文放进 `annotations` 的 `notes`；单选时带上所选项的 `preview`。没回答的问题不出现。
 */
export function askUserQuestionResponse(
  questions: readonly XAiQuestion[],
  answers: Record<string, string[]>,
): {
  outcome: 'accepted';
  answers: Record<string, string[]>;
  annotations?: Record<string, { preview?: string; notes?: string }>;
} {
  const out: Record<string, string[]> = {};
  const annotations: Record<string, { preview?: string; notes?: string }> = {};
  for (const question of questions) {
    const values = (answers[question.id ?? question.question] ?? answers[question.question] ?? [])
      .map((value) => value.trim())
      .filter((value) => value !== '');
    if (values.length === 0) continue;
    const byLabel = new Map(question.options.map((option) => [option.label, option]));
    const selected = values.flatMap((value) => (byLabel.has(value) ? [value] : []));
    const notes = values.filter((value) => !byLabel.has(value));
    const preview =
      question.multiSelect === true
        ? undefined
        : values.map((value) => byLabel.get(value)?.preview).find((value) => value !== undefined);
    out[question.question] = selected.length > 0 ? selected : ['Other'];
    if (preview !== undefined || notes.length > 0) {
      annotations[question.question] = {
        ...(preview !== undefined && { preview }),
        ...(notes.length > 0 && { notes: notes.join('\n') }),
      };
    }
  }
  return {
    outcome: 'accepted',
    answers: out,
    ...(Object.keys(annotations).length > 0 && { annotations }),
  };
}

export const ASK_USER_QUESTION_CANCELLED = Object.freeze({ outcome: 'cancelled' as const });

// ── 退出计划模式 ──────────────────────────────────────────────────────────────────

export const XAI_EXIT_PLAN_MODE_METHODS: readonly string[] = Object.freeze([
  'x.ai/exit_plan_mode',
  '_x.ai/exit_plan_mode',
]);

export interface XAiExitPlanMode {
  sessionId: string;
  toolCallId: string;
  planContent?: string;
}

/** `exit_plan_mode` 的参数（T3 的 `XAiExitPlanModeRequest`）；形状不对时 undefined。 */
export function parseExitPlanMode(params: unknown): XAiExitPlanMode | undefined {
  const fields = unwrap(params);
  const sessionId = nonEmpty(fields?.sessionId);
  const toolCallId = nonEmpty(fields?.toolCallId);
  if (sessionId === undefined || toolCallId === undefined) return undefined;
  const planContent = nonEmpty(fields?.planContent);
  return { sessionId, toolCallId, ...(planContent !== undefined && { planContent }) };
}

/**
 * 退出计划模式的回复（T3 的 `makeXAiExitPlanModeCapturedResponse`）：计划已经交给客户端，放弃这道关，让 Grok 停下等用户
 * （T3 #8358：不回复回合会一直挂着）。
 */
export const EXIT_PLAN_CAPTURED = Object.freeze({
  outcome: 'abandoned' as const,
  feedback:
    "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
});
