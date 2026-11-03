// SPDX-License-Identifier: MIT
// 改写自 pingdotgg/t3code apps/server/src/provider/acp/AntigravityAcpSupport.ts
// 来源提交 ab8e488e10d883fa880b0ddcf01917b51839ab07
// Copyright (c) 2026 T3 Tools Inc.

import { AdapterError } from '@wevir/runtime-adapter';

export function antigravitySessionMeta(version: string | undefined, instructions?: string) {
  if (instructions && version?.replace(/^agy_acp_server_/u, '') !== '1.4.5') {
    throw new AdapterError('engine_unavailable', 'System instructions require Antigravity 1.4.5.');
  }
  return {
    antigravity: {
      // 1.4.2–1.4.5 在建立和恢复会话时写 SKILL.md，必须在会话请求里禁用。
      disabledTools: ['run_workflow'],
      ...(instructions && { systemPrompt: { append: instructions } }),
    },
  };
}
