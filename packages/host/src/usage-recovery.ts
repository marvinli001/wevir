import type { RoutingDecision, Session, SessionId, TurnId, WevirEvent } from '@wevir/protocol';
import { redactSecrets } from './secret-patterns.js';
import { unattended } from './unattended.js';

export const USAGE_RECOVERY_EVENT_TYPES = [
  'routing.decided',
  'session.auto_continue',
  'session.handoff',
  'session.configured',
] as const;

export interface UsageRecoveryReport {
  sessionId: SessionId;
  turnId: TurnId;
  originTurnId: TurnId;
  seq: number;
  at: string;
  text: string;
}

export function reportsUsageRecovery(session: Session): boolean {
  return (
    session.parentSessionId === undefined &&
    session.side !== true &&
    (unattended(session) || session.channel !== undefined)
  );
}

export function isUsageRecoveryEvent(event: WevirEvent): boolean {
  return (
    (event.type === 'session.auto_continue' && event.payload.resumeAt !== null) ||
    ((event.type === 'session.handoff' || event.type === 'session.configured') &&
      event.payload.reason === 'usage_limit' &&
      event.payload.failover !== undefined)
  );
}

/** 从已落地的配置与继续计划生成报告；单有路由决定不算接力成功。 */
export function usageRecoveryReports(
  events: readonly WevirEvent[],
  providerName: (id: string) => string,
): UsageRecoveryReport[] {
  const reports: UsageRecoveryReport[] = [];
  let decision: RoutingDecision | undefined;
  for (const event of events) {
    if (event.type === 'routing.decided') decision = event.payload;
    let turnId: TurnId | undefined;
    let text: string | undefined;
    if (event.type === 'session.auto_continue' && event.payload.resumeAt !== null) {
      turnId = event.payload.turnId;
      text = `额度用完，${event.payload.resumeAt}后继续`;
    } else if (
      (event.type === 'session.handoff' || event.type === 'session.configured') &&
      event.payload.reason === 'usage_limit' &&
      event.payload.failover !== undefined &&
      decision?.to != null &&
      decision.originTurnId === event.payload.failover.originTurnId &&
      decision.attempt === event.payload.failover.attempt &&
      (event.type === 'session.handoff'
        ? decision.to.providerId === event.payload.to.providerId &&
          decision.to.modelId === event.payload.to.modelId
        : decision.to.modelId === event.payload.modelId)
    ) {
      turnId = decision.turnId;
      const label = (target: RoutingDecision['from']) =>
        `${providerName(target.providerId)} / ${target.modelId}`;
      text = `因额度从 ${label(decision.from)} 接力到 ${label(decision.to)}（第 ${decision.attempt} 次）`;
    }
    if (turnId === undefined || text === undefined) continue;
    reports.push({
      sessionId: event.sessionId,
      turnId,
      originTurnId: decision?.turnId === turnId ? decision.originTurnId : turnId,
      seq: event.seq,
      at: event.ts,
      text: redactSecrets(text).text,
    });
  }
  return reports;
}
