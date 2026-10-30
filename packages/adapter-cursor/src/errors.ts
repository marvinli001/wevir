// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-cursor/src/server/CursorSdk.ts（isCursorShellSpawnFailure、isCursorClosedStreamWrite）、CursorAgentSdk.ts（isCursorCancellationError、
// isActiveRunConflict）、CursorSdkCatalog.ts（isAuthenticationFailure）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：错误按 name 判断而不用 instanceof；去掉 T3 自己注册的 unhandledRejection 监听，改由 Host 的 cli.ts 先问 engines.ts；
// 加上 AgentNotFoundError 与 AdapterError 的归类。isCursorClosedStreamWrite 跟进 T3 f54dfc0991。
//
// SDK 抛出的错误的归类（docs/architecture/cursor-event-mapping.md §6）。SDK 的错误类有自己的 `name`（AuthenticationError、
// AgentNotFoundError…），按 `name` 与 `status` 判断，不用 instanceof：测试里的假 SDK 与动态加载的真 SDK 是两套类。

import { AdapterError, type AdapterErrorCode } from '@wevir/runtime-adapter';

function field(error: unknown, key: string): unknown {
  return typeof error === 'object' && error !== null ? Reflect.get(error, key) : undefined;
}

/** 给人看的错误原文。 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message;
  const message = field(error, 'message');
  return typeof message === 'string' && message !== '' ? message : String(error);
}

/** API Key 无效、过期或被吊销（`AuthenticationError`，或 HTTP 401）。 */
export function isAuthenticationFailure(error: unknown): boolean {
  return field(error, 'name') === 'AuthenticationError' || field(error, 'status') === 401;
}

/** 本地 agent 不在 SDK 的存储里（`AgentNotFoundError`）。 */
export function isAgentNotFound(error: unknown): boolean {
  return (
    field(error, 'name') === 'AgentNotFoundError' || field(error, 'code') === 'agent_not_found'
  );
}

/** 取消 run 时 SDK 抛的 AbortError（沿 `cause` 链找，T3 的 isCursorCancellationError）。 */
export function isCancellationError(error: unknown): boolean {
  let current = error;
  const seen = new Set<object>();
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    if (Reflect.get(current, 'name') === 'AbortError') return true;
    seen.add(current);
    current = Reflect.get(current, 'cause');
  }
  return false;
}

/** 恢复的 agent 还挂着上一个进程留下的 run（T3 的 isActiveRunConflict）。 */
export function isActiveRunConflict(error: unknown): boolean {
  return /already has active run/i.test(errorMessage(error));
}

/** SDK 调用失败 → AdapterError：认证失败是 `missing_credentials`，其余是 `engine_unavailable`。 */
export function adapterError(error: unknown, what: string): AdapterError {
  const code: AdapterErrorCode = isAuthenticationFailure(error)
    ? 'missing_credentials'
    : 'engine_unavailable';
  return new AdapterError(code, `Cursor ${what} failed: ${errorMessage(error)}`, { cause: error });
}

/**
 * SDK 在本进程里为工具调用起 shell（Cursor 的沙箱包装，命令里带 `dump_zsh_state` 等标记）。工作目录不对时 Node 报
 * `spawn /bin/zsh ENOENT`，SDK 监听到之后 reject 一个没人等的内部 promise，成了进程级的 unhandled rejection。Host 把
 * unhandled rejection 当致命错误退出（cli.ts），所以要先认出这一种并只记日志（engines.ts 的 isIgnorableEngineRejection）。
 */
const CURSOR_SHELL_SPAWN_MARKERS = [
  'dump_zsh_state',
  'dump_bash_state',
  '__CURSOR_SANDBOX_ENV_RESTORE',
] as const;

export function isCursorShellSpawnFailure(reason: unknown): boolean {
  const syscall = field(reason, 'syscall');
  const code = field(reason, 'code');
  const spawnargs = field(reason, 'spawnargs');
  if (typeof syscall !== 'string' || !syscall.startsWith('spawn') || typeof code !== 'string') {
    return false;
  }
  if (!Array.isArray(spawnargs)) return false;
  return spawnargs.some(
    (arg) =>
      typeof arg === 'string' && CURSOR_SHELL_SPAWN_MARKERS.some((marker) => arg.includes(marker)),
  );
}

/**
 * 本地 exec 失败后，SDK 从一个没人等的 promise 往这个 exec 的流里写最后一帧；流已经关了时这次写入 reject，同样成了进程级的
 * unhandled rejection。SDK 的类名被压缩过，只能按 `name` 认。
 */
export function isCursorClosedStreamWrite(reason: unknown): boolean {
  return reason instanceof Error && reason.name === 'WriteIterableClosedError';
}
