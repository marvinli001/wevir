// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 OpenAI
// 改写自 openai/codex（0a94398fa60c4fac0e7659e4213a0a36e613dd46）的 codex-rs/tui/src/chatwidget/protocol_requests.rs 与
// codex-rs/app-server-protocol/src/protocol/v2/{item,permissions}.rs。将 v2 审查记录转回 core 的授权消息，展示文本单独脱敏。

import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type EngineNotice, redactDiagnostics } from '@wevir/runtime-adapter';

type ReviewNotice = Extract<EngineNotice, { kind: 'approval_review' }>;
export interface GuardianDenial {
  detail: ReviewNotice;
  event: Record<string, unknown>;
  authorization?: Promise<string>;
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function uri(path: unknown) {
  return typeof path === 'string' && isAbsolute(path) ? pathToFileURL(path).href : path;
}

function permissionProfile(input: unknown) {
  if (!record(input) || !record(input.fileSystem))
    return { network: record(input) ? input.network : undefined };
  const fs = input.fileSystem;
  const entries = Array.isArray(fs.entries)
    ? fs.entries.map((entry: unknown) =>
        record(entry) && record(entry.path) && entry.path.type === 'path'
          ? { ...entry, path: { ...entry.path, path: uri(entry.path.path) } }
          : entry,
      )
    : (['read', 'write'] as const).flatMap((access) =>
        (Array.isArray(fs[access]) ? fs[access] : []).map((path) => ({
          access,
          path: { type: 'path', path: uri(path) },
        })),
      );
  return {
    network: input.network,
    file_system: { entries, glob_scan_max_depth: fs.globScanMaxDepth },
  };
}

/** 授权接口接收 core 的 GuardianAssessmentEvent，动作的线缆格式与 v2 通知不同。 */
function coreAction(action: Record<string, unknown>) {
  const source = action.source === 'unifiedExec' ? 'unified_exec' : action.source;
  switch (action.type) {
    case 'command':
    case 'execve':
      return { ...action, source };
    case 'networkAccess':
      return {
        ...action,
        type: 'network_access',
        protocol:
          action.protocol === 'socks5Tcp'
            ? 'socks5_tcp'
            : action.protocol === 'socks5Udp'
              ? 'socks5_udp'
              : action.protocol,
      };
    case 'applyPatch':
      return { ...action, type: 'apply_patch' };
    case 'writeStdin':
      return {
        type: 'write_stdin',
        approval_id: action.approvalId,
        process_id: action.processId,
        stdin: action.stdin,
        cwd: uri(action.cwd),
      };
    case 'mcpToolCall':
      return {
        type: 'mcp_tool_call',
        server: action.server,
        tool_name: action.toolName,
        connector_id: action.connectorId,
        connector_name: action.connectorName,
        tool_title: action.toolTitle,
      };
    case 'requestPermissions':
      return {
        type: 'request_permissions',
        reason: action.reason,
        permissions: permissionProfile(action.permissions),
      };
    default:
      return undefined;
  }
}

function actionLabel(action: Record<string, unknown>): string {
  const cwd = typeof action.cwd === 'string' ? ` (${action.cwd})` : '';
  switch (action.type) {
    case 'command':
      return String(action.command) + cwd;
    case 'execve':
      return `${action.program} ${JSON.stringify(action.argv)}${cwd}`;
    case 'writeStdin':
      return `${action.processId} ← ${JSON.stringify(action.stdin)}${cwd}`;
    case 'applyPatch':
      return `apply_patch ${JSON.stringify(action.files)}${cwd}`;
    case 'networkAccess':
      return String(action.target);
    case 'mcpToolCall':
      return `${action.server} / ${action.toolName}`;
    default:
      return JSON.stringify(action);
  }
}

export function guardianReview(
  params: Record<string, unknown>,
): { detail: ReviewNotice; event?: Record<string, unknown> } | undefined {
  const { review, action, reviewId, turnId } = params;
  if (
    !record(review) ||
    !record(action) ||
    typeof reviewId !== 'string' ||
    !reviewId ||
    typeof turnId !== 'string'
  )
    return undefined;
  const { status } = review;
  if (
    status !== 'inProgress' &&
    status !== 'approved' &&
    status !== 'denied' &&
    status !== 'timedOut' &&
    status !== 'aborted'
  )
    return undefined;
  const detail: ReviewNotice = {
    kind: 'approval_review',
    reviewId: `${params.threadId}/${turnId}/${reviewId}`,
    status,
    action: redactDiagnostics(actionLabel(action)),
    ...(typeof review.riskLevel === 'string' && { riskLevel: review.riskLevel }),
    ...(typeof review.rationale === 'string' && { rationale: redactDiagnostics(review.rationale) }),
  };
  const original = status === 'denied' ? coreAction(action) : undefined;
  return {
    detail,
    ...(original && {
      event: {
        id: reviewId,
        turn_id: turnId,
        target_item_id: params.targetItemId,
        started_at_ms: params.startedAtMs,
        completed_at_ms: params.completedAtMs,
        status,
        risk_level: review.riskLevel,
        user_authorization: review.userAuthorization,
        rationale: review.rationale,
        decision_source: params.decisionSource,
        action: original,
      },
    }),
  };
}
