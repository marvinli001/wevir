// SPDX-License-Identifier: MIT
// Adapted from pingdotgg/t3code apps/server/src/orchestration-v2/IdleCompaction.ts
// at a03648901640216a154d387cfb2cdec268e6527e. Copyright (c) 2026 T3 Tools Inc.

import type { SessionSnapshot } from '@wevir/protocol';

export function idleCompactionWindow(
  snapshot: SessionSnapshot,
  now: number,
): { start: number; end: number } | undefined {
  const { session, usage } = snapshot;
  if (
    session.state !== 'idle' ||
    session.archivedAt !== undefined ||
    session.readOnly !== undefined ||
    session.subagent !== undefined ||
    session.goal?.status === 'active' ||
    snapshot.pendingApprovals.length > 0 ||
    (snapshot.pendingQuestions?.length ?? 0) > 0 ||
    (snapshot.pendingMessages?.length ?? 0) > 0 ||
    snapshot.subagents?.some((child) => child.status === 'running') ||
    (usage?.contextUsed ?? 0) < 200_000
  )
    return undefined;
  const end = Date.parse(usage?.promptCacheExpiresAt ?? '');
  if (!Number.isFinite(end) || now >= end) return undefined;
  return { start: end - 2 * 60_000, end };
}
