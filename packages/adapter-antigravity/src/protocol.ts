// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/server/src/provider/acp/AntigravityProtocol.ts（interaction_* 提问、工具负载的截断、原生命令字段、
// start_subagent 的识别）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：Effect Schema 改写成手写检查；提问报成 Wevir 的 UserQuestion（回答是选项的 label，重名的 label 后面带选项 ID 以便
// 区分）；工具调用换成 Wevir 的 ToolDisplay；T3 的“允许一次 / 本会话 / 拒绝”取舍与安全提示不移植（Wevir 原样转交引擎给的
// 选项，桌面端按 kind 选）。
//
// Antigravity 在 ACP 之上的约定（docs/architecture/antigravity-event-mapping.md §4–§5）。

import type { AcpSessionNotification } from '@wevir/adapter-acp';
import type { RequestPermissionRequest, RequestPermissionResponse } from '@wevir/adapter-acp/sdk';
import type { ToolDisplay, UserQuestion } from '@wevir/runtime-adapter';

const TOOL_TEXT_LIMIT = 8_000;
const TOOL_TEXT_TRUNCATED = '[Earlier output truncated]\n\n';
const QUESTION_LABEL_LIMIT = 512;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** 截断时复制一份，V8 不再持有原来的大字符串。 */
function copyBoundedText(text: string): string {
  return Buffer.from(text, 'utf16le').toString('utf16le');
}

function boundText(text: string, limit = TOOL_TEXT_LIMIT): string {
  return text.length <= limit
    ? text
    : copyBoundedText(`${TOOL_TEXT_TRUNCATED}${text.slice(-limit)}`);
}

// ── 提问 ────────────────────────────────────────────────────────────────────────────

/** 一个 `interaction_*` 请求对应的提问与回答的换算。 */
export interface AntigravityQuestion {
  questions: UserQuestion[];
  /** 按问题 ID 的回答（选中的 label 或选项 ID）→ 给引擎的回复；对不上给出的选项时返回 undefined。 */
  respond(answers: Record<string, string[]>): RequestPermissionResponse | undefined;
}

/** 原生的提问借审批的方法发来，工具调用 ID 以 `interaction_` 开头；选项是答案，不是批准与拒绝。 */
export function isAntigravityQuestionRequest(request: RequestPermissionRequest): boolean {
  return request.toolCall.toolCallId.startsWith('interaction_');
}

function questionLabel(name: string, optionId: string): string {
  const label = name.trim() || optionId;
  return label.length > QUESTION_LABEL_LIMIT
    ? copyBoundedText(`${label.slice(0, QUESTION_LABEL_LIMIT - 3)}...`)
    : label;
}

/**
 * `interaction_*` 请求 → 一道单选题（适配器的 `interceptPermission` 用）。选项 ID 为空或重复时不认，照常当审批。回答按
 * 选项 ID 或 label 匹配（重名的 label 后面带 `(<选项 ID>)`）；匹配不上返回 undefined，提问保持未决。
 */
export function antigravityQuestion(
  request: RequestPermissionRequest,
): AntigravityQuestion | undefined {
  if (!isAntigravityQuestionRequest(request) || request.options.length === 0) return undefined;
  const ids = new Set<string>();
  for (const option of request.options) {
    if (!option.optionId.trim() || ids.has(option.optionId)) return undefined;
    ids.add(option.optionId);
  }
  const baseLabels = request.options.map((option) => questionLabel(option.name, option.optionId));
  const labels = baseLabels.map((label, index) =>
    baseLabels.indexOf(label) !== baseLabels.lastIndexOf(label)
      ? `${label} (${request.options[index]?.optionId})`
      : label,
  );
  const id = request.toolCall.toolCallId;
  const title = request.toolCall.title?.trim() || 'Choose an option.';
  const question: UserQuestion = {
    id,
    header: 'Question',
    question:
      title.length > TOOL_TEXT_LIMIT
        ? copyBoundedText(`${title.slice(0, TOOL_TEXT_LIMIT - 3)}...`)
        : title,
    options: labels.map((label) => ({ label })),
    multiSelect: false,
    allowOther: false,
  };
  return {
    questions: [question],
    respond: (answers): RequestPermissionResponse | undefined => {
      const value = answers[id]?.[0];
      if (value === undefined) return undefined;
      const exact = request.options.find((option) => option.optionId === value);
      if (exact) return { outcome: { outcome: 'selected', optionId: exact.optionId } };
      const index = labels.indexOf(value);
      const option = index === -1 ? undefined : request.options[index];
      return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : undefined;
    },
  };
}

// ── 工具负载 ────────────────────────────────────────────────────────────────────────

interface ToolPayloadBudget {
  nodes: number;
  text: number;
}

function sanitizeToolValue(value: unknown, budget: ToolPayloadBudget, depth: number): unknown {
  if (depth > 12 || budget.nodes-- <= 0) return undefined;
  if (typeof value === 'string') {
    if (/^data:image\//iu.test(value) || budget.text <= 0) return undefined;
    const text = boundText(value, Math.min(TOOL_TEXT_LIMIT, budget.text));
    budget.text -= text.length;
    return text;
  }
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const entry of value) {
      if (budget.nodes <= 0) break;
      const sanitized = sanitizeToolValue(entry, budget, depth + 1);
      if (sanitized !== undefined) result.push(sanitized);
    }
    return result;
  }
  if (!isRecord(value)) return value;
  const entries: Array<readonly [string, unknown]> = [];
  for (const [key, entry] of Object.entries(value)) {
    if (budget.nodes <= 0) break;
    if (
      (value.type === 'image' && (key === 'data' || key === 'blob')) ||
      (key === 'blob' &&
        typeof value.mimeType === 'string' &&
        value.mimeType.startsWith('image/')) ||
      ((key === 'formatted_output' || key === 'formattedOutput') &&
        (entry === value.combinedOutput || entry === value.combined_output))
    ) {
      continue;
    }
    const sanitized = sanitizeToolValue(entry, budget, depth + 1);
    if (sanitized !== undefined) entries.push([key, sanitized]);
  }
  return Object.fromEntries(entries);
}

/** 进事件库之前给工具的输入、输出与内容设上限（图片数据去掉，长文本只留结尾）。 */
export function sanitizeAntigravityToolPayload(payload: unknown): unknown {
  return sanitizeToolValue(payload, { nodes: 512, text: 64_000 }, 0);
}

/**
 * `session/update` 进映射之前的整理（引擎描述的 `normalizeUpdate`）：工具调用的标题、输入、输出、内容与 `_meta` 设上限；
 * 命令的输出（`combinedOutput`）放进 ACP 的文本内容，Wevir 的工具输出就是它。其他更新原样。
 */
export function normalizeAntigravityUpdate(
  notification: AcpSessionNotification,
): AcpSessionNotification {
  const update = notification.update;
  if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') {
    return notification;
  }
  const contentBudget = { nodes: 512, text: 32_000 };
  const content = Array.isArray(update.content)
    ? update.content.flatMap((entry) => {
        const sanitized = sanitizeToolValue(entry, contentBudget, 0);
        return sanitized === undefined ? [] : [sanitized];
      })
    : update.content;
  const rawOutput =
    update.rawOutput === undefined ? undefined : sanitizeAntigravityToolPayload(update.rawOutput);
  const commandOutput = nativeOutput(rawOutput);
  const hasText =
    Array.isArray(content) &&
    content.some(
      (entry) => isRecord(entry) && isRecord(entry.content) && entry.content.type === 'text',
    );
  const withOutput =
    commandOutput !== undefined && !hasText
      ? [
          ...(Array.isArray(content) ? content : []),
          { type: 'content', content: { type: 'text', text: commandOutput } },
        ]
      : content;
  return {
    ...notification,
    update: {
      ...update,
      ...(typeof update.title === 'string' && { title: boundText(update.title) }),
      ...(update.rawInput !== undefined && {
        rawInput: sanitizeAntigravityToolPayload(update.rawInput),
      }),
      ...(rawOutput !== undefined && { rawOutput }),
      ...(withOutput !== undefined && { content: withOutput }),
      ...(update._meta !== undefined && { _meta: sanitizeAntigravityToolPayload(update._meta) }),
    },
  };
}

function nativeOutput(rawOutput: unknown): string | undefined {
  if (!isRecord(rawOutput)) return undefined;
  const output = rawOutput.combinedOutput ?? rawOutput.combined_output;
  return typeof output === 'string' ? boundText(output) : undefined;
}

/** 原生命令工具的命令行（不同版本的字段名不一样）。 */
export function antigravityCommand(rawInput: unknown, rawOutput?: unknown): string | undefined {
  const input = isRecord(rawInput) ? rawInput : {};
  const output = isRecord(rawOutput) ? rawOutput : {};
  const command =
    str(input.CommandLine) ??
    str(input.command_line) ??
    str(input.commandLine) ??
    str(input.command) ??
    str(output.commandLine) ??
    str(output.command_line);
  return command === undefined ? undefined : boundText(command);
}

/** ACP 1.1.1 起子 agent 是普通工具（`start_subagent`），没有子会话 ID；MCP 的同名工具不算。 */
export function isAntigravitySubagentTool(title: string, kind: unknown, meta: unknown): boolean {
  return (
    (kind === undefined || kind === null || kind === 'other') &&
    (title === 'Running start_subagent' || title === 'Run start_subagent?') &&
    !(isRecord(meta) && meta.is_mcp_tool_call === true)
  );
}

/** 工具的展示类型（引擎描述的 `tools.display`）：按 ACP 的 `kind`，命令取原生字段，路径取 `locations`。 */
export function antigravityToolDisplay(
  toolName: string,
  rawInput: unknown,
  update: Record<string, unknown>,
): ToolDisplay {
  const paths = Array.isArray(update.locations)
    ? update.locations.flatMap((location) =>
        isRecord(location) && typeof location.path === 'string' ? [location.path] : [],
      )
    : [];
  const withPaths = paths.length > 0 ? { paths, summary: paths.join(', ') } : {};
  const command = antigravityCommand(rawInput, update.rawOutput);
  if (isAntigravitySubagentTool(toolName, update.kind, update._meta)) {
    return { kind: 'sub_agent', summary: toolName };
  }
  switch (update.kind) {
    case 'execute':
      return command === undefined
        ? { kind: 'shell', summary: toolName }
        : { kind: 'shell', summary: command, command };
    case 'read':
      return { kind: 'read', ...withPaths };
    case 'edit':
    case 'delete':
    case 'move':
      return { kind: 'edit', ...withPaths };
    case 'search':
      return { kind: 'search', ...withPaths };
    case 'fetch': {
      const url = isRecord(rawInput) ? (str(rawInput.url) ?? str(rawInput.Url)) : undefined;
      return url === undefined
        ? { kind: 'fetch', summary: toolName }
        : { kind: 'fetch', summary: url, url };
    }
    default:
      return command === undefined
        ? { kind: 'unknown', summary: toolName, ...withPaths }
        : { kind: 'shell', summary: command, command };
  }
}
