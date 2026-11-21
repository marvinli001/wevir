// SPDX-License-Identifier: MIT
// 改写自 pingdotgg/t3code apps/server/src/provider/acp/AntigravityAcpSupport.ts
// 来源提交 ab8e488e10d883fa880b0ddcf01917b51839ab07
// Copyright (c) 2026 T3 Tools Inc.

import type { InitializeResponse } from '@wevir/adapter-acp/sdk';
import { matchesReleaseVersion } from './release.js';

export function antigravityAppendsSystemPrompt(
  initialize: InitializeResponse | undefined,
): boolean {
  const extension = initialize?.agentCapabilities?._meta?.antigravity as
    | { systemPrompt?: { append?: unknown } }
    | undefined;
  return (
    extension?.systemPrompt?.append === true ||
    matchesReleaseVersion(initialize?.agentInfo?.version, '1.4.5')
  );
}

export function antigravitySessionMeta(
  initialize: InitializeResponse | undefined,
  instructions?: string,
) {
  const version = initialize?.agentInfo?.version;
  const disableWorkflow =
    version === undefined || /^(?:agy_acp_server_)?1\.4\.[2-5](?:$|[-+])/u.test(version);
  const antigravity = {
    // 1.4.2–1.4.5 在建立和恢复会话时写 SKILL.md，必须在会话请求里禁用。
    ...(disableWorkflow && { disabledTools: ['run_workflow'] }),
    ...(instructions &&
      antigravityAppendsSystemPrompt(initialize) && { systemPrompt: { append: instructions } }),
  };
  return Object.keys(antigravity).length === 0 ? undefined : { antigravity };
}
