// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-cursor/src/server/adapter.ts（cursorToolFailed、cursorToolOutput、cursorToolOutputText、
// cursorToolName、cursorToolSearchPattern、cursorTodoSteps、assistantTextsFromConversationSteps）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：T3 投影成自己的回合项（命令、文件改动、搜索结果）；这里换成 Wevir 的 ToolDisplay 与输出文本，待办状态换成 in_progress 写法。
//
// Cursor 的工具调用（SDK 的 `ToolCall`）→ 工具名、展示类型、输出与待办（docs/architecture/cursor-event-mapping.md §4）。SDK 的
// 工具调用自带类型与结构化参数，不必按工具名猜（domain-model §7）。只读、列目录与搜索归为 read / search，与 Codex 一致
// （codex-event-mapping.md §6.3），桌面端把连续的读取 / 搜索合成一组。

import type { ToolCall } from '@cursor/sdk';
import type { TodoItem, ToolDisplay } from '@wevir/runtime-adapter';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** 工具的参数（SDK 不认识的工具类型也按对象读）。 */
function argsOf(toolCall: ToolCall): Record<string, unknown> {
  return record((toolCall as { args?: unknown }).args) ?? {};
}

function firstLine(text: string | undefined): string | undefined {
  return text
    ?.split('\n')
    .find((line) => line.trim() !== '')
    ?.trim();
}

/** 工具名（`tool.started.toolName`，引擎原值）：SDK 的类型；MCP 是 `mcp__<server>__<tool>`（domain-model §7）。 */
export function toolName(toolCall: ToolCall): string {
  if (toolCall.type !== 'mcp') return toolCall.type;
  const provider = toolCall.args.providerIdentifier ?? 'mcp';
  const tool = toolCall.args.toolName ?? 'unknown';
  return `mcp__${provider}__${tool}`;
}

export function toolDisplay(toolCall: ToolCall): ToolDisplay {
  const args = argsOf(toolCall);
  switch (toolCall.type) {
    case 'shell': {
      const command = toolCall.args.command;
      return { kind: 'shell', summary: command, command };
    }
    case 'read':
      return { kind: 'read', summary: toolCall.args.path, paths: [toolCall.args.path] };
    case 'readLints':
      return {
        kind: 'read',
        summary: toolCall.args.paths.join(', '),
        paths: [...toolCall.args.paths],
      };
    case 'ls':
      return { kind: 'search', summary: toolCall.args.path, paths: [toolCall.args.path] };
    case 'glob': {
      const query = toolCall.args.globPattern;
      const dir = toolCall.args.targetDirectory;
      return { kind: 'search', summary: query, query, ...(dir && { paths: [dir] }) };
    }
    case 'grep': {
      const query = toolCall.args.pattern;
      const dir = toolCall.args.path;
      return { kind: 'search', summary: query, query, ...(dir && { paths: [dir] }) };
    }
    case 'semSearch': {
      const query = toolCall.args.query;
      const dirs = toolCall.args.targetDirectories;
      return {
        kind: 'search',
        summary: query,
        query,
        ...(dirs !== undefined && dirs.length > 0 && { paths: [...dirs] }),
      };
    }
    case 'edit':
    case 'delete':
      return { kind: 'edit', summary: toolCall.args.path, paths: [toolCall.args.path] };
    case 'write':
      return { kind: 'write', summary: toolCall.args.path, paths: [toolCall.args.path] };
    case 'generateImage': {
      const path = toolCall.args.filePath;
      return path === undefined
        ? { kind: 'write', summary: 'generateImage' }
        : { kind: 'write', summary: path, paths: [path] };
    }
    case 'updateTodos':
    case 'createPlan':
      return { kind: 'plan' };
    case 'task':
      return {
        kind: 'sub_agent',
        summary: firstLine(toolCall.args.description) ?? firstLine(toolCall.args.prompt) ?? 'task',
      };
    case 'mcp': {
      const server = toolCall.args.providerIdentifier;
      return {
        kind: 'unknown',
        summary: `${server ?? 'mcp'}/${toolCall.args.toolName ?? 'unknown'}`,
        ...(server !== undefined && { mcpServer: server }),
      };
    }
    default: {
      // SDK 类型表以外的工具（webFetch、webSearch 等随平台新增的）：按常见参数名猜。
      const name = toolName(toolCall);
      const url = str(args.url);
      if (url !== undefined) return { kind: 'fetch', summary: url, url };
      const query = str(args.query) ?? str(args.searchTerm);
      if (query !== undefined) return { kind: 'search', summary: query, query };
      return { kind: 'unknown', summary: name };
    }
  }
}

/** 结果是错误（MCP 工具的 `isError` 也算，T3 的 cursorToolFailed）。 */
export function toolFailed(toolCall: ToolCall): boolean {
  if (toolCall.result?.status === 'error') return true;
  return toolCall.type === 'mcp' && toolCall.result?.status === 'success'
    ? toolCall.result.value.isError === true
    : false;
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * 工具结束时的输出文本：命令是 stdout 与 stderr，MCP 是文本内容，编辑是 diff，任务是子 agent 的回答，其余是结果的 JSON；
 * 失败时是错误。`streamed` 是流式收到的命令输出（`shell-output-delta`），结果里没有输出时用它。没有可显示的内容时省略。
 */
export function toolOutput(toolCall: ToolCall, streamed = ''): string | undefined {
  const result = toolCall.result;
  if (result === undefined) return streamed === '' ? undefined : streamed;
  if (result.status === 'error') {
    const error = result.error;
    const text =
      typeof error === 'string' ? error : (str(record(error)?.error) ?? stableJson(error));
    return text === '' ? undefined : text;
  }
  let text: string;
  switch (toolCall.type) {
    case 'shell': {
      const value = toolCall.result?.status === 'success' ? toolCall.result.value : undefined;
      text =
        [value?.stdout ?? '', value?.stderr ?? ''].filter((part) => part.length > 0).join('\n') ||
        streamed;
      break;
    }
    case 'mcp':
      text =
        toolCall.result?.status === 'success'
          ? toolCall.result.value.content
              .flatMap((part) => (part.text === undefined ? [] : [part.text.text]))
              .join('\n')
          : '';
      break;
    case 'edit':
      text = toolCall.result?.status === 'success' ? (toolCall.result.value.diffString ?? '') : '';
      break;
    case 'task':
      text = taskResultText(toolCall) ?? '';
      break;
    case 'read':
      text = toolCall.result?.status === 'success' ? toolCall.result.value.content : '';
      break;
    default: {
      const value = (result as { value?: unknown }).value;
      text = value === undefined ? '' : typeof value === 'string' ? value : stableJson(value);
    }
  }
  return text === '' ? undefined : text;
}

/** 子 agent（`task`）的回答：它对话里的助手消息加上结果后缀（T3 的 assistantTextsFromConversationSteps）。 */
export function taskResultText(toolCall: Extract<ToolCall, { type: 'task' }>): string | undefined {
  if (toolCall.result?.status !== 'success') return undefined;
  const value = toolCall.result.value;
  const steps: readonly unknown[] = value.conversationSteps ?? [];
  const texts = steps.flatMap((step) => {
    const entry = record(step);
    const text =
      entry?.type === 'assistantMessage'
        ? record(entry.message)?.text
        : record(entry?.assistantMessage)?.text;
    return typeof text === 'string' && text.trim() !== '' ? [text] : [];
  });
  if (value.resultSuffix !== undefined && value.resultSuffix.trim() !== '') {
    texts.push(value.resultSuffix);
  }
  return texts.length === 0 ? undefined : texts.join('\n');
}

/**
 * `updateTodos` → 完整的待办列表。取结果里的（引擎合并后的），没有结果时取参数；去掉取消的与空的（T3 的 cursorTodoSteps）。
 * 状态换成 Wevir 认的写法：`inProgress` → `in_progress`，其他原样。
 */
export function todoItems(toolCall: Extract<ToolCall, { type: 'updateTodos' }>): TodoItem[] {
  const todos =
    toolCall.result?.status === 'success' ? toolCall.result.value.todos : toolCall.args.todos;
  return todos
    .filter((todo) => todo.status !== 'cancelled' && todo.content.trim() !== '')
    .map((todo) => ({
      content: todo.content,
      status: todo.status === 'inProgress' ? 'in_progress' : todo.status,
    }));
}
