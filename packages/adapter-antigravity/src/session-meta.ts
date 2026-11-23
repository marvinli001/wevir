// SPDX-License-Identifier: MIT
// 改写自 pingdotgg/t3code apps/server/src/provider/acp/AntigravityAcpSupport.ts
// 来源提交 ab8e488e10d883fa880b0ddcf01917b51839ab07
// 原生 CLI 的系统说明能力参考 6b7027b1f43eebc4c7edf5304236a0775b2d8928（同路径）。
// Copyright (c) 2026 T3 Tools Inc.

import type { InitializeResponse } from '@wevir/adapter-acp/sdk';

function legacyVersion(initialize: InitializeResponse | undefined) {
  return initialize?.agentInfo?.version.replace(/^agy_acp_server_/u, '');
}

export function antigravityAppendsSystemPrompt(
  initialize: InitializeResponse | undefined,
  nativeCli: boolean,
): boolean {
  const extension = initialize?.agentCapabilities?._meta?.antigravity as
    | { systemPrompt?: { append?: unknown } }
    | undefined;
  return (
    extension?.systemPrompt?.append === true ||
    (!nativeCli && legacyVersion(initialize) === '1.4.5')
  );
}

/**
 * 挂了应用级工具的会话追加的说明：Antigravity 的 `run_command` 能转成后台任务（`WaitMsBeforeAsync`），Wevir 看不到，
 * 结束时也不会叫醒空闲的会话；模型会拿它当“后台监控”回报给用户。长命令改用 `wevir_process_start`。
 */
export const ANTIGRAVITY_APP_TOOLS_INSTRUCTIONS =
  'Start long-running commands (test suites, builds, dev servers, anything you will check on or report later) ' +
  'with wevir_process_start, not as a background run_command task. Wevir shows those processes to the user and ' +
  'messages you when they exit, so end your turn and report then. Background run_command tasks are invisible in ' +
  'Wevir and do not wake you when they finish: never tell the user one is being monitored. Wevir tools that are ' +
  'not declared to you are loaded on demand: read their schema file and call them with call_mcp_tool.';

export function antigravitySessionMeta(
  initialize: InitializeResponse | undefined,
  nativeCli: boolean,
  rules?: string,
  appTools = false,
): Record<string, unknown> | undefined {
  const instructions = [rules, appTools ? ANTIGRAVITY_APP_TOOLS_INSTRUCTIONS : undefined]
    .filter((part) => part !== undefined && part !== '')
    .join('\n\n');
  const version = legacyVersion(initialize);
  // Legacy 1.4.2–1.4.5 write SKILL.md when creating or loading sessions.
  const disableWorkflow =
    !nativeCli && (version === undefined || /^1\.4\.[2-5](?:$|[-+])/u.test(version));
  const antigravity = {
    ...(disableWorkflow && { disabledTools: ['run_workflow'] }),
    ...(instructions &&
      antigravityAppendsSystemPrompt(initialize, nativeCli) && {
        systemPrompt: { append: instructions },
      }),
  };
  return Object.keys(antigravity).length > 0 ? { antigravity } : undefined;
}
