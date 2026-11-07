import { sameFields } from '@/data/transcript-selection';
import type { TranscriptState } from '@/data/transcript-store';
import { hasFinishedTurn } from './side-session';
import { pendingApprovals } from './subagent-model';
import { handoffAfterLastTurn, lastTurnId } from './turn-model';
import { lastTurnShowsWrapUp } from './wrap-up-model';

export function sessionChrome(state: TranscriptState | undefined) {
  if (!state) return undefined;
  const t = state.transcript;
  return {
    error: state.error,
    caughtUp: state.caughtUp,
    hasEvents: t.lastSeq > 0,
    finishedTurn: hasFinishedTurn(t),
    turnId: lastTurnId(t),
    handoff: handoffAfterLastTurn(t),
    lastOutcome: t.messages.findLast((message) => message.role === 'assistant')?.finished?.outcome,
    hasWrapUp: lastTurnShowsWrapUp(t),
    awaitingApproval: pendingApprovals(t).length > 0,
    transcript: {
      state: t.state,
      activeTurnId: t.activeTurnId,
      readOnly: t.readOnly,
      lastError: t.lastError,
      uiShow: t.uiShow,
      goal: t.goal,
      collaborationMode: t.collaborationMode,
      latestPlan: t.state === 'idle' ? t.latestPlan : undefined,
      pendingMessages: t.pendingMessages,
      pendingQuestions: t.pendingQuestions,
      insights: t.insights,
      promptSuggestion: t.promptSuggestion,
      autoContinue: t.autoContinue,
      redoTurnIds: t.redoTurnIds,
    },
  };
}

export function sameSessionChrome(
  a: ReturnType<typeof sessionChrome>,
  b: ReturnType<typeof sessionChrome>,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const { transcript: left, ...leftMeta } = a;
  const { transcript: right, ...rightMeta } = b;
  return sameFields(leftMeta, rightMeta) && sameFields(left, right);
}
