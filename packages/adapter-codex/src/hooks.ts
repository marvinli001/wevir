import { createHash } from 'node:crypto';
import type { EngineHook } from '@wevir/runtime-adapter';

// Host 给会话挂的 hooks（护栏，codex-event-mapping.md §6.17）→ `thread/start` / `thread/resume` / `thread/fork` 的 `config` 覆盖。
// 契约以 rust-v0.162.1 为准（upstream/codex/codex-rs/hooks/src/engine/discovery.rs、config_rules.rs）：
// - 覆盖进的是 SessionFlags 层；这一层的 hooks 不是托管的，要 `hooks.state.<key>.trusted_hash` 等于它的当前散列才执行
//   （没有信任记录 = Untrusted，不跑）。信任状态也只从用户层与 SessionFlags 层读，所以 Wevir 把散列和 hooks 一起放进同一份覆盖；
// - `<key>` = `<来源路径>:<事件>:<组序号>:<处理器序号>`，SessionFlags 层的来源路径是合成的 `/<session-flags>/config.toml`
//   （Windows 上解析到 `C:\`），带点号，所以整个 `hooks` 作为一个顶层键的对象值传，不用点分路径；
// - 散列 = `sha256:` + 规范化身份 `{event_name, matcher, hooks: [处理器]}` 去掉空值、键排序后的紧凑 JSON 的 sha256
//   （`hook_hash` 与 `version_for_toml`）。处理器取规范化后的：`timeout` 总是写上（默认 600），`commandWindows` 去掉。

/** Codex 的 hook 事件（`HOOK_EVENT_NAMES`）里 Wevir 用到的几种，与持久化键里的写法。 */
const EVENT_KEYS = {
  PreToolUse: 'pre_tool_use',
  PostToolUse: 'post_tool_use',
  PermissionRequest: 'permission_request',
  Stop: 'stop',
  SessionStart: 'session_start',
  SessionEnd: 'session_end',
  UserPromptSubmit: 'user_prompt_submit',
  PreCompact: 'pre_compact',
  PostCompact: 'post_compact',
  SubagentStart: 'subagent_start',
  SubagentStop: 'subagent_stop',
  Interrupt: 'interrupt',
} as const;

export type CodexHookEvent = keyof typeof EVENT_KEYS;

export function isCodexHookEvent(value: string): value is CodexHookEvent {
  return Object.hasOwn(EVENT_KEYS, value);
}

/** 不看 matcher 的事件（`matcher_pattern_for_event`）：身份里不带它。 */
const NO_MATCHER: ReadonlySet<CodexHookEvent> = new Set(['UserPromptSubmit', 'Stop', 'Interrupt']);

/** 不写超时时 Codex 用的（秒）；SessionEnd / Interrupt 另有 1–3 秒的限制，Wevir 不挂这两种。 */
export const CODEX_HOOK_DEFAULT_TIMEOUT_SEC = 600;

/** SessionFlags 层 hooks 的来源路径（`synthetic_layer_path("<session-flags>/config.toml")`）。 */
export function sessionFlagsSource(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'C:\\<session-flags>\\config.toml' : '/<session-flags>/config.toml';
}

/** 一个处理器的持久化键（`hook_key`）。 */
export function codexHookKey(
  source: string,
  event: CodexHookEvent,
  groupIndex: number,
  handlerIndex: number,
): string {
  return `${source}:${EVENT_KEYS[event]}:${groupIndex}:${handlerIndex}`;
}

interface CommandHandler {
  type: 'command';
  command: string;
  timeout: number;
  async: boolean;
  statusMessage?: string;
}

function commandHandler(hook: EngineHook): CommandHandler {
  return {
    type: 'command',
    command: hook.command,
    timeout: Math.max(1, Math.floor(hook.timeoutSec ?? CODEX_HOOK_DEFAULT_TIMEOUT_SEC)),
    async: false,
    ...(hook.statusMessage !== undefined && { statusMessage: hook.statusMessage }),
  };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/** 一个命令处理器的信任散列（`hook_hash`）。 */
export function codexHookHash(hook: EngineHook): string {
  const event = hook.event as CodexHookEvent;
  const matcher = NO_MATCHER.has(event) ? undefined : hook.matcher;
  const identity = {
    event_name: EVENT_KEYS[event],
    ...(matcher !== undefined && { matcher }),
    hooks: [commandHandler(hook)],
  };
  const json = JSON.stringify(sortKeys(identity));
  return `sha256:${createHash('sha256').update(json).digest('hex')}`;
}

/**
 * 会话的 hooks → `config` 覆盖的 `hooks` 键：每个 hook 一组（一组一个处理器，键的组序号就是它在同一事件里的位置），加上每个
 * 处理器的信任散列；`disabled` 是要停用的别处的 hook（仓库里的，`enabled = false`，这一层的状态覆盖用户层与项目层）。事件不认识的
 * hook 丢掉（Host 只给 Codex 认识的）。什么都没有时返回空对象，不写这个键。
 */
export function hooksThreadConfig(
  hooks: readonly EngineHook[],
  disabled: readonly string[] = [],
  platform: NodeJS.Platform = process.platform,
): Record<string, unknown> {
  const source = sessionFlagsSource(platform);
  const groups: Partial<Record<CodexHookEvent, unknown[]>> = {};
  const state: Record<string, { trusted_hash?: string; enabled?: boolean }> = {};
  for (const key of disabled) state[key] = { enabled: false };
  for (const hook of hooks) {
    if (!isCodexHookEvent(hook.event)) continue;
    const list = groups[hook.event] ?? [];
    groups[hook.event] = list;
    const matcher = NO_MATCHER.has(hook.event) ? undefined : hook.matcher;
    state[codexHookKey(source, hook.event, list.length, 0)] = {
      trusted_hash: codexHookHash(hook),
    };
    list.push({ ...(matcher !== undefined && { matcher }), hooks: [commandHandler(hook)] });
  }
  if (Object.keys(state).length === 0) return {};
  return { hooks: { ...groups, state } };
}
