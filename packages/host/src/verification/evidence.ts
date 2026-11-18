import type {
  CheckDefinition,
  CodeState,
  VerificationConclusion,
  VerificationEvidenceStatus,
  VerificationRun,
} from '@wevir/protocol';
import { redactDiagnostics } from '../secret-patterns.js';
import { sameCodeState } from './code-state.js';

export type EvidenceCheck = Pick<CheckDefinition, 'id' | 'name' | 'kind' | 'revision'>;

export type EvidenceTarget =
  | { kind: 'working_tree'; codeState?: CodeState; contentsOnly?: true }
  | { kind: 'staged' | 'commit'; tree?: string };

function matches(target: EvidenceTarget, state: CodeState | undefined): boolean | undefined {
  if (target.kind === 'working_tree' && !target.contentsOnly) {
    return sameCodeState(target.codeState, state);
  }
  const tree =
    target.kind === 'working_tree'
      ? target.codeState?.kind === 'git'
        ? target.codeState.tree
        : undefined
      : target.tree;
  return state?.kind === 'git' && tree !== undefined ? state.tree === tree : undefined;
}

type EvidenceRun = Pick<
  VerificationRun,
  'id' | 'checkId' | 'checkRevision' | 'status' | 'codeState' | 'queuedAt'
>;

export function evaluateVerification<T extends EvidenceRun>(
  definitions: readonly EvidenceCheck[],
  records: readonly T[],
  target: EvidenceTarget,
) {
  // The history contains multiple updates for the same run.
  const runs = new Map(records.map((run) => [run.id, run]));
  const latest = new Map<string, T>();
  const matching = new Map<string, T>();
  function keepNewest(byCheck: Map<string, T>, run: T) {
    const previous = byCheck.get(run.checkId);
    if (previous === undefined || run.queuedAt >= previous.queuedAt) byCheck.set(run.checkId, run);
  }
  for (const run of runs.values()) {
    keepNewest(latest, run);
    if (matches(target, run.codeState) === true) keepNewest(matching, run);
  }
  const checks = definitions.map((check) => {
    const run = matching.get(check.id) ?? latest.get(check.id);
    const status: VerificationEvidenceStatus = (() => {
      if (run === undefined) return 'not_run';
      if (run.status === 'not_run') return 'not_run';
      const match = matches(target, run.codeState);
      if (match === false) return 'stale';
      if (run.checkRevision !== check.revision) return 'config_changed';
      if (match === undefined) {
        // A queued run has not captured a code state yet.
        if (run.status === 'running' && run.codeState === undefined) return 'running';
        return 'unbound';
      }
      return run.status;
    })();
    return { check, run, status };
  });
  return { checks, status: concludeVerification(checks.map((item) => item.status)) };
}

export function concludeVerification(
  statuses: readonly VerificationEvidenceStatus[],
): VerificationConclusion {
  if (statuses.length === 0) return 'unconfigured';
  if (statuses.every((status) => status === 'passed')) return 'passed';
  if (statuses.some((status) => status === 'failed' || status === 'timed_out')) return 'failed';
  if (statuses.includes('running')) return 'running';
  if (statuses.includes('passed')) return 'partial';
  return 'unverified';
}

/** Diagnostics may include machine-local paths even when the check ran with a relative cwd. */
export function redactEvidenceText(text: string): string {
  return redactDiagnostics(text).replace(
    /(^|[\s"'=`(>|:])(?:[a-z]:[\\/]|\\\\|\/(?!\/))[^\s"'`()<>|]+/gi,
    '$1[path]',
  );
}
