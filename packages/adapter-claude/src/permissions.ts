// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts（`permissionModeForClaudeRuntimePolicy`、`claudeRuntimeQueryPolicyForRuntimePolicy`、`permissionResultFromDecision`、`toSessionPermissionUpdates`）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：按 Wevir 的三种权限模式重写映射；审批选项照 adapter-codex 的四个。
//
// 权限（claude-event-mapping.md §4）。Wevir 的三种模式按语义对到 Claude Code 的权限模式，同 T3 的 runtimeMode 一支：
// - `on_request`（请求批准）→ `default`：Claude Code 自己判断哪些调用要问（改文件、不在只读名单里的命令等），经 `canUseTool`
//   交给用户；
// - `auto_review`（自动批准）→ `auto`：Claude Code 的模型分类器逐个批准或拒绝，拿不准时照样经 `canUseTool` 问用户；
// - `full_access`（完全访问）→ `bypassPermissions`（带 `allowDangerouslySkipPermissions`）：不问。
// 审批选项照 Codex 的四个（adapter-codex 的 `COMMAND_APPROVAL_OPTIONS`），决定照 T3 换成 SDK 的 `PermissionResult`。

import type { ApprovalOption, PermissionMode } from '@wevir/runtime-adapter';
import type { PermissionResult, PermissionUpdate, SdkPermissionMode } from './sdk.js';

export const PERMISSION_MODES: readonly PermissionMode[] = Object.freeze([
  'on_request',
  'auto_review',
  'full_access',
]);

/** Wevir 的权限模式 → Claude Code 的权限模式；省略是 `on_request`。 */
export function claudePermissionMode(mode: PermissionMode | undefined): SdkPermissionMode {
  switch (mode) {
    case 'auto_review':
      return 'auto';
    case 'full_access':
      return 'bypassPermissions';
    default:
      return 'default';
  }
}

/** 审批选项：`optionId` 是回给 `canUseTool` 的决定；`kind` 以 `allow_` / `reject_` 开头决定批准与否。 */
export const APPROVAL_OPTIONS: readonly ApprovalOption[] = Object.freeze([
  { optionId: 'accept', label: '允许', kind: 'allow_accept' },
  { optionId: 'acceptForSession', label: '允许，本会话不再询问', kind: 'allow_accept_for_session' },
  { optionId: 'decline', label: '拒绝并继续', kind: 'reject_decline' },
  // 中断回合：用户接着说该怎么做（SDK 的 `interrupt: true`）。
  { optionId: 'cancel', label: '拒绝并停止', kind: 'reject_cancel' },
]);

export type ApprovalDecisionId = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

/**
 * 审批的决定 → `canUseTool` 的结果（T3 的 `permissionResultFromDecision`）：本会话不再询问时把 Claude 给的建议规则改成只在
 * 本会话生效（`destination: 'session'`），不写进用户的设置文件；没有建议时按工具名加一条。
 */
export function permissionResult(input: {
  decision: ApprovalDecisionId;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseID: string;
  suggestions?: readonly PermissionUpdate[];
}): PermissionResult {
  if (input.decision === 'accept' || input.decision === 'acceptForSession') {
    return {
      behavior: 'allow',
      updatedInput: input.toolInput,
      toolUseID: input.toolUseID,
      decisionClassification:
        input.decision === 'acceptForSession' ? 'user_permanent' : 'user_temporary',
      ...(input.decision === 'acceptForSession' && {
        updatedPermissions: sessionPermissionUpdates(input.toolName, input.suggestions),
      }),
    };
  }
  return {
    behavior: 'deny',
    message:
      input.decision === 'cancel'
        ? 'User cancelled tool execution.'
        : 'User declined tool execution.',
    toolUseID: input.toolUseID,
    decisionClassification: 'user_reject',
    ...(input.decision === 'cancel' && { interrupt: true }),
  };
}

function sessionPermissionUpdates(
  toolName: string,
  suggestions: readonly PermissionUpdate[] | undefined,
): PermissionUpdate[] {
  const updates = (suggestions ?? []).map(
    (suggestion): PermissionUpdate => ({ ...suggestion, destination: 'session' }),
  );
  if (updates.length > 0) return updates;
  return [{ type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'session' }];
}
