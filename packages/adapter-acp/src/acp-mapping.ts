import type { AgentEvent, EngineRawEvent } from '@wevir/runtime-adapter';
import type { AcpRouteCodec, AcpToolPresentation } from './engine.js';

// ACP `session/update` → AgentEvent（docs/architecture/acp-event-mapping.md 第一部分 §1）。输入是引擎写出的原始
// 通知参数：AcpProcess 在 ACP SDK 之前截下 `session/update`（acp-process.ts），因为 SDK 的 zod 校验会丢掉
// 不认识的 `sessionUpdate` 类型、删掉不认识的字段，而不认识的内容要以 `engine.raw` 原样保留。所以这里自己
// 检查要读的字段，其余字段不管。工具的展示类型与待办由引擎描述给出（engine.ts 的 `AcpToolPresentation`）。
//
// 本文件只做单条通知的翻译；回合边界由 session-events.ts 处理。

/** `session/update` 的参数（只检查了 `sessionId` 与 `update.sessionUpdate`）。 */
export interface AcpSessionNotification {
  sessionId: string;
  update: AcpSessionUpdate;
}

export interface AcpSessionUpdate {
  sessionUpdate: string;
  [field: string]: unknown;
}

export function isAcpSessionNotification(params: unknown): params is AcpSessionNotification {
  return (
    isRecord(params) &&
    typeof params.sessionId === 'string' &&
    params.sessionId !== '' &&
    isRecord(params.update) &&
    typeof params.update.sessionUpdate === 'string'
  );
}

/**
 * 映射为 `engine.raw` 的原因。by_design：认识的类型，v0 没有对应的 Wevir 事件（`RAW_BY_DESIGN_ACP_UPDATES`）；
 * 其余都是不认识的内容：unknown_type（映射不认识的类型）、unexpected_fields（认识的类型但字段不合预期，
 * 例如非文本内容）。调用方对后两种记一次告警。
 */
export type AcpRawReason = 'by_design' | 'unknown_type' | 'unexpected_fields';

export type OnRawUpdate = (reason: AcpRawReason, detail: string) => void;

/** 映射为 Wevir 事件的类型（其余一律 `engine.raw`）；与 acp-event-mapping.md 第 1 节一致。 */
export const MAPPED_ACP_UPDATES = Object.freeze([
  'agent_message_chunk',
  'agent_thought_chunk',
  'tool_call',
  'tool_call_update',
  'usage_update',
] as const);

/** 认识但 v0 有意保留为 `engine.raw` 的类型。 */
export const RAW_BY_DESIGN_ACP_UPDATES = Object.freeze([
  'config_option_update',
  'available_commands_update',
  'current_mode_update',
  'session_info_update',
] as const);

/**
 * 一条 `session/update` 对应的 AgentEvent，按发出顺序。纯函数：`assistant.message` / `assistant.thought` 的
 * `replaces` 恒为空。不认识的内容映射为一条 `engine.raw`（`params` 是整条通知的
 * 原样参数），并经 `onRaw` 说明原因；不丢弃任何通知。
 */
export function mapAcpUpdate(
  notification: AcpSessionNotification,
  tools: AcpToolPresentation,
  onRaw?: OnRawUpdate,
): AgentEvent[] {
  const engineSessionId = notification.sessionId;
  const update = notification.update;
  const kind = update.sessionUpdate;
  const raw = (reason: AcpRawReason, detail: string): EngineRawEvent[] => {
    onRaw?.(reason, detail);
    return [rawEvent(notification)];
  };

  switch (kind) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      const content = update.content;
      if (typeof update.messageId !== 'string' || update.messageId === '') {
        return raw('unexpected_fields', `${kind} 没有 messageId`);
      }
      if (!isRecord(content) || content.type !== 'text' || typeof content.text !== 'string') {
        return raw('unexpected_fields', `${kind} 的内容不是文本`);
      }
      return [
        {
          type: kind === 'agent_message_chunk' ? 'assistant.message' : 'assistant.thought',
          engineSessionId,
          messageId: update.messageId,
          text: content.text,
          replaces: [],
        },
      ];
    }

    case 'tool_call': {
      const { toolCallId, title: toolName } = update;
      if (typeof toolCallId !== 'string' || toolCallId === '' || typeof toolName !== 'string') {
        return raw('unexpected_fields', 'tool_call 缺少 toolCallId 或 title');
      }
      const status = toolStatus(update.status);
      const output = toolOutput(update.content);
      if (status === undefined || output === undefined) {
        return raw('unexpected_fields', `tool_call 的 status 或 content 不认识`);
      }
      const events: AgentEvent[] = [
        {
          type: 'tool.started',
          engineSessionId,
          toolCallId,
          toolName,
          display: tools.display(toolName, update.rawInput, update),
          ...('rawInput' in update && { input: update.rawInput }),
        },
      ];
      const items = tools.todos?.(toolName, update.rawInput);
      if (items !== undefined) {
        events.push({ type: 'todo.updated', engineSessionId, toolCallId, items });
      }
      // ACP 允许 tool_call 直接带终态（dsh 只发 in_progress）。
      if (status === 'completed' || status === 'failed') {
        events.push({
          type: 'tool.finished',
          engineSessionId,
          toolCallId,
          status,
          ...(output.text !== undefined && { output: output.text }),
        });
      }
      return output.complete
        ? events
        : [...events, ...raw('unexpected_fields', '工具内容不是文本')];
    }

    case 'tool_call_update': {
      const { toolCallId } = update;
      if (typeof toolCallId !== 'string' || toolCallId === '') {
        return raw('unexpected_fields', 'tool_call_update 缺少 toolCallId');
      }
      const status = toolStatus(update.status);
      const output = toolOutput(update.content);
      if (status === undefined || output === undefined) {
        return raw('unexpected_fields', 'tool_call_update 的 status 或 content 不认识');
      }
      const event: AgentEvent =
        status === 'completed' || status === 'failed'
          ? {
              type: 'tool.finished',
              engineSessionId,
              toolCallId,
              status,
              ...(output.text !== undefined && { output: output.text }),
            }
          : {
              type: 'tool.updated',
              engineSessionId,
              toolCallId,
              // 只有带了 title 才知道工具名；rawInput 单独变化时 display 留给 Host 沿用 tool.started 的。
              ...(typeof update.title === 'string' && {
                display: tools.display(update.title, update.rawInput, update),
              }),
              ...('rawInput' in update && { input: update.rawInput }),
              ...(output.text !== undefined && { output: output.text }),
            };
      return output.complete ? [event] : [event, ...raw('unexpected_fields', '工具内容不是文本')];
    }

    case 'usage_update': {
      const { used, size } = update;
      if (!isCount(used) || !isCount(size)) {
        return raw('unexpected_fields', 'usage_update 的 used / size 不是非负数');
      }
      return [{ type: 'usage.updated', engineSessionId, contextUsed: used, contextSize: size }];
    }

    case 'config_option_update':
      // v0 没有中途改模型的事件（预留 session.config_changed，domain-model.md §6.6）。
      return raw('by_design', kind);

    case 'available_commands_update':
    case 'current_mode_update':
    case 'session_info_update':
      // 引擎的斜杠命令、模式与会话标题（Grok 每个回合都发）：Wevir 不用引擎的命令与模式，标题由 Host 生成。
      return raw('by_design', kind);

    default:
      return raw('unknown_type', kind);
  }
}

/**
 * `session/new` / `session/resume` 结果的 `configOptions` 里引擎当前采用的模型与推理强度。模型选项的值按引擎的
 * 路由编码解出模型（dsh 是 JSON 编码的 `["<provider>","<model>"]`）；解析不了的项省略。
 */
export function sessionConfigInfo(
  configOptions: unknown,
  route: AcpRouteCodec,
): {
  modelId?: string;
  reasoningEffort?: string;
} {
  if (!Array.isArray(configOptions)) return {};
  const current = (id: string): string | undefined => {
    const option = configOptions.find((o) => isRecord(o) && o.id === id);
    return isRecord(option) && typeof option.currentValue === 'string'
      ? option.currentValue
      : undefined;
  };
  const info: { modelId?: string; reasoningEffort?: string } = {};
  const model = current(route.modelOption);
  const modelId = model === undefined ? undefined : route.decodeModel(model);
  if (modelId !== undefined) info.modelId = modelId;
  const effort =
    route.reasoningEffortOption === undefined ? undefined : current(route.reasoningEffortOption);
  if (effort !== undefined) info.reasoningEffort = effort;
  return info;
}

/** 整条通知原样保留。 */
export function rawEvent(notification: AcpSessionNotification): EngineRawEvent {
  return {
    type: 'engine.raw',
    engineSessionId: notification.sessionId,
    protocol: 'acp',
    method: 'session/update',
    kind: notification.update.sessionUpdate,
    params: notification,
  };
}

type ToolStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | null;

/** ACP 的工具状态；缺省（`tool_call_update` 只改别的字段）记为 null，不认识的值为 undefined。 */
function toolStatus(value: unknown): ToolStatus | undefined {
  if (value === undefined || value === null) return null;
  return value === 'pending' ||
    value === 'in_progress' ||
    value === 'completed' ||
    value === 'failed'
    ? value
    : undefined;
}

/**
 * 工具输出原文：`content` 里 `{type:'content', content:{type:'text'}}` 的文本按顺序直接拼接（dsh 一个结果块
 * 一项，模型看到的也是这些块）。`complete` 为 false 表示还有别的内容（diff、terminal、图片），调用方另发
 * `engine.raw` 保留它们。`content` 不是数组时返回 undefined。
 */
function toolOutput(content: unknown): { text?: string; complete: boolean } | undefined {
  if (content === undefined || content === null) return { complete: true };
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  let complete = true;
  for (const part of content) {
    const inner = isRecord(part) && part.type === 'content' ? part.content : undefined;
    if (isRecord(inner) && inner.type === 'text' && typeof inner.text === 'string') {
      texts.push(inner.text);
    } else {
      complete = false;
    }
  }
  return texts.length === 0 ? { complete } : { text: texts.join(''), complete };
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
