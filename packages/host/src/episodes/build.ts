import { createHash } from 'node:crypto';
import type {
  Episode,
  EpisodeId,
  EpisodeLesson,
  SessionId,
  SessionRetro,
  WevirEvent,
  WorkspaceId,
} from '@wevir/protocol';
import { clipText, type RetroState } from '../retro/fold.js';
import { redactSecrets } from '../secret-patterns.js';

export const EPISODE_SCHEMA_VERSION = 1;

export const EPISODE_EVENT_TYPES = [
  'session.created',
  'session.handoff',
  'guardrail.blocked',
  'engine.error',
  'turn.finished',
] as const;

export function redactEpisodeValue<T>(value: T): { value: T; count: number } {
  let count = 0;
  const walk = (item: unknown): unknown => {
    if (typeof item === 'string') {
      const result = redactSecrets(item);
      count += result.count;
      return result.text;
    }
    if (Array.isArray(item)) return item.map(walk);
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, walk(child)]));
    return item;
  };
  return { value: walk(value) as T, count };
}

export function episodeRevision(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

export function episodeLessons(
  state: RetroState,
  retro: SessionRetro,
  events: readonly WevirEvent[],
): EpisodeLesson[] {
  const lessons: EpisodeLesson[] = [];
  const visible = state.turns.filter((turn) => !turn.hidden);
  const visibleIds = new Set(visible.map((turn) => turn.turnId));
  const filesBetween = (from: number, to: number) =>
    [
      ...new Set(
        visible
          .filter((turn) => (turn.endSeq ?? turn.seq) > from && turn.seq < to)
          .flatMap((turn) => turn.files),
      ),
    ].slice(0, 50);
  const runs = state.runs.filter(
    ({ run }) => run.turnId === undefined || visibleIds.has(run.turnId),
  );
  for (const check of retro.verification.checks) {
    if (check.turnId !== undefined && !visibleIds.has(check.turnId)) continue;
    const earlier = runs.filter(({ run, seq }) => run.checkId === check.checkId && seq < check.seq);
    const failure = earlier.findLast(
      ({ run }) => run.status === 'failed' || run.status === 'timed_out',
    );
    if (check.status === 'passed' && failure !== undefined) {
      lessons.push({
        kind: 'check_recovered',
        text: `${check.name}: ${failure.run.status} → passed`,
        sources: [`v:${failure.run.id}`, check.id],
        files: filesBetween(failure.seq, check.seq),
        verified: true,
      });
    } else if (['failed', 'timed_out', 'environment_unavailable'].includes(check.status)) {
      lessons.push({
        kind: 'check_failed',
        text: `${check.name}: ${check.status}${check.reason ? `: ${check.reason}` : ''}`,
        sources: [check.id],
        verified: true,
      });
    }
  }
  const commands = visible.flatMap((turn) => turn.commands).sort((a, b) => a.seq - b.seq);
  const failed = new Map<string, (typeof commands)[number]>();
  for (const command of commands) {
    const normalized = command.text.trim().replace(/\s+/g, ' ');
    if (command.status !== undefined && command.status !== 'completed')
      failed.set(normalized, command);
    else if (command.status === 'completed' && failed.has(normalized)) {
      const before = failed.get(normalized) as (typeof commands)[number];
      lessons.push({
        kind: 'command_recovered',
        text: `${normalized}: ${before.status} → completed (Agent command, not verification)`,
        sources: [`e${before.seq}`, `e${command.seq}`],
        verified: false,
      });
      failed.delete(normalized);
    }
  }
  for (const decision of retro.decisions) {
    if (decision.kind === 'steer' || decision.kind === 'declined') {
      lessons.push({
        kind: 'correction',
        text: clipText(decision.text, 200),
        sources: [decision.id],
        verified: false,
      });
    }
  }
  for (const event of events) {
    if (event.seq <= (state.inheritedThrough ?? 0)) continue;
    if (
      event.type === 'guardrail.blocked' &&
      (event.payload.turnId === undefined || visibleIds.has(event.payload.turnId))
    ) {
      lessons.push({
        kind: 'guardrail',
        text: clipText(
          `${event.payload.guardrailId ?? ''} ${event.payload.command ?? event.payload.path ?? ''}: ${event.payload.reason}`,
          200,
        ),
        sources: [`e${event.seq}`],
        verified: false,
      });
    }
    if (
      event.type === 'engine.error' &&
      event.payload.turnId !== undefined &&
      visible.some((turn) => turn.turnId === event.payload.turnId && turn.outcome === 'failed')
    ) {
      lessons.push({
        kind: 'turn_failed',
        text: clipText(event.payload.message, 200),
        sources: [`e${event.seq}`],
        verified: false,
      });
    }
  }
  return lessons.slice(-10);
}

export function buildEpisode(input: {
  workspaceId: WorkspaceId;
  rootSessionId: SessionId;
  title: string;
  createdAt: string;
  state: RetroState;
  retro: SessionRetro;
  events: readonly WevirEvent[];
  startHead?: string;
}): Episode {
  const { retro, state } = input;
  const turns = retro.turns.filter((turn) => !turn.inherited);
  const decisions = [...retro.decisions]
    .sort(
      (a, b) =>
        Number(['steer', 'declined'].includes(b.kind)) -
        Number(['steer', 'declined'].includes(a.kind)),
    )
    .slice(0, 15);
  const engines: Episode['engines'] = input.events.flatMap((event) => {
    if (event.type === 'session.created')
      return [
        { providerId: event.payload.providerId, modelId: event.payload.modelId, seq: event.seq },
      ];
    if (event.type === 'session.handoff')
      return [
        {
          providerId: event.payload.to.providerId,
          modelId: event.payload.to.modelId,
          seq: event.seq,
        },
      ];
    return [];
  });
  const goal = retro.goal.goal ?? retro.goal.request;
  const raw: Episode = {
    id: `ep_${retro.sessionId.slice(4)}` as EpisodeId,
    workspaceId: input.workspaceId,
    sessionId: retro.sessionId,
    rootSessionId: input.rootSessionId,
    title: input.title,
    ...(goal !== undefined && { goal }),
    outcome: {
      ...retro.delivery,
      ...(turns.at(-1)?.outcome !== undefined && { lastTurn: turns.at(-1)?.outcome }),
      open: retro.open.length,
      checkedAt: retro.checkedAt,
      comparedToCode: false,
    },
    done: retro.done.slice(0, 10),
    open: retro.open.slice(0, 10),
    decisions,
    lessons: episodeLessons(state, retro, input.events),
    files: retro.changes.files.slice(0, 50),
    ...(retro.changes.files.length > 50 && { omittedFiles: retro.changes.files.length - 50 }),
    commits: retro.changes.commits.slice(0, 20),
    anchor: {
      ...(retro.changes.branch !== undefined && { branch: retro.changes.branch }),
      ...(retro.changes.head !== undefined && { head: retro.changes.head }),
      ...(input.startHead !== undefined && { startHead: input.startHead }),
    },
    engines,
    period: {
      start: turns[0]?.at ?? input.createdAt,
      end:
        input.events.find((event) => event.seq === turns.at(-1)?.endSeq)?.ts ??
        turns.at(-1)?.at ??
        input.createdAt,
    },
    throughSeq: state.throughSeq,
    schemaVersion: EPISODE_SCHEMA_VERSION,
    memories: retro.memories,
    chapters: retro.chapters ?? [],
    sessions: retro.sessions,
    ...(retro.summary !== undefined && { summary: retro.summary }),
    overrides: {},
    pinned: false,
    excluded: false,
    source: 'available',
    revision: '',
    redactions: 0,
    updatedAt: retro.checkedAt,
  };
  const redacted = redactEpisodeValue(raw);
  redacted.value.redactions = redacted.count;
  redacted.value.revision = episodeRevision(redacted.value);
  return redacted.value;
}

export { episodeMarkdown } from '@wevir/protocol';
