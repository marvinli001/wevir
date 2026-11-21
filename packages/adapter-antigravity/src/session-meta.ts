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

export function antigravitySessionMeta(
  initialize: InitializeResponse | undefined,
  nativeCli: boolean,
  instructions?: string,
): Record<string, unknown> | undefined {
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
