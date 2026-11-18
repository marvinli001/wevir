import { type EventSubscription, isRpcError, type WevirClient } from '@wevir/client-sdk';
import type {
  CheckId,
  SessionId,
  TurnId,
  VerificationEvidence,
  VerificationEvidenceStatus,
  VerificationRun,
  WevirEvent,
} from '@wevir/protocol';

type Requirement = true | readonly string[];
type Reason =
  | Exclude<VerificationEvidenceStatus, 'passed' | 'running'>
  | 'not_configured'
  | 'unknown_check';
interface RequiredCheck {
  name: string;
  status: VerificationEvidenceStatus;
  reason?: Reason;
  checkId?: CheckId;
}

export function requiredChecks(
  requirement: Requirement,
  evidence?: VerificationEvidence,
): RequiredCheck[] {
  const names = requirement === true ? ['*'] : requirement;
  if (evidence === undefined || evidence.status === 'unconfigured') {
    const reason = evidence === undefined ? 'unbound' : 'not_configured';
    return names.map((name) => ({
      name,
      status: reason === 'unbound' ? reason : 'not_run',
      reason,
    }));
  }
  const selected =
    requirement === true
      ? evidence.checks
      : evidence.checks.filter((check) => names.includes(check.name));
  const checks = selected.map(
    ({ name, status, checkId }): RequiredCheck => ({
      name,
      status,
      checkId,
      ...(status !== 'passed' && { reason: status === 'running' ? 'not_run' : status }),
    }),
  );
  if (requirement !== true) {
    for (const name of names) {
      if (!selected.some((check) => check.name === name)) {
        checks.push({ name, status: 'not_run', reason: 'unknown_check' });
      }
    }
  }
  return checks;
}

export async function checkExecResult(
  client: WevirClient,
  sessionId: SessionId,
  turnId: TurnId,
  subscription: EventSubscription,
  requirement: Requirement,
  onEvent: (event: WevirEvent) => void,
  interrupted: () => boolean,
  cancel: () => Promise<unknown>,
) {
  const status = () => client.request('verification.status', { sessionId, target: 'working_tree' });
  const wait = async (runs: VerificationRun[]) => {
    const pending = new Set(runs.map(({ id }) => id));
    while (pending.size > 0 && !interrupted()) {
      const item = await subscription.next();
      if (item.done || item.value.type === 'reset') return false;
      if (item.value.type !== 'event') continue;
      const { event } = item.value;
      onEvent(event);
      if (event.type === 'verification.updated' && event.payload.run.status !== 'running') {
        pending.delete(event.payload.run.id);
      }
    }
    return true;
  };

  let current = await status();
  if (interrupted()) return;
  const automatic = current.verification.runs.filter(
    (run) => run.trigger === 'after_turn' && run.turnId === turnId,
  );
  if (automatic.length > 0) {
    if (!(await wait(automatic)) || interrupted()) return;
    current = await status();
    if (interrupted()) return;
  }
  const checkIds = requiredChecks(requirement, current.evidence).flatMap((check) =>
    check.status === 'passed' || check.checkId === undefined ? [] : [check.checkId],
  );
  if (checkIds.length > 0) {
    const round = await client
      .request('verification.run', { sessionId, checkIds })
      .catch((error: unknown) => {
        // A different turn or a config edit can invalidate the requested run before it starts.
        if (isRpcError(error, 'SESSION_BUSY') || isRpcError(error, 'INVALID_PARAMS'))
          return undefined;
        throw error;
      });
    if (interrupted()) {
      // A cancellation may have reached the Host while the round was being created.
      await cancel();
      return;
    }
    if (round !== undefined && (!(await wait(round.runs)) || interrupted())) return;
    current = await status();
  }
  return requiredChecks(requirement, current.evidence);
}
