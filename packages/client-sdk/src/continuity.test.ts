import { describe, expect, it } from 'vitest';
import { type HandoffLabels, handoffDetailRows, usageLimitState } from './continuity.js';
import type { ChatPartOf } from './projection.js';

const now = Date.parse('2026-11-04T10:00:00Z');
const part: ChatPartOf<'error'> = {
  type: 'error',
  key: 'e:1',
  category: 'provider',
  fatal: false,
  message: 'quota',
  turnId: 'trn_1',
  usageLimit: { resetsAt: '2026-11-04T11:00:00Z' },
};
const armed = { turnId: 'trn_1', resumeAt: '2026-11-04T11:00:00Z' } as const;

describe('usage limit state', () => {
  it('associates only the matching turn with the Host schedule', () => {
    expect(usageLimitState(part, { armed, lastTurnId: 'trn_1' }, now)).toEqual({
      armed,
      toggleable: true,
    });
    expect(
      usageLimitState({ ...part, turnId: 'trn_old' }, { armed, lastTurnId: 'trn_1' }, now),
    ).toEqual({ armed: undefined, toggleable: false });
    expect(usageLimitState(part, { lastTurnId: 'trn_1' }, now)).toEqual({
      armed: undefined,
      toggleable: true,
    });
  });

  it('does not allow changes after continuation, a newer turn, or without capability', () => {
    expect(
      usageLimitState({ ...part, resumedAt: '2026-11-04T10:30:00Z' }, { lastTurnId: 'trn_1' }, now)
        .toggleable,
    ).toBe(false);
    expect(usageLimitState(part, { lastTurnId: 'trn_new' }, now).toggleable).toBe(false);
    expect(usageLimitState(part, undefined, now).toggleable).toBe(false);
  });

  it('does not offer a toggle for unknown reset times or waits over one day', () => {
    for (const usageLimit of [{}, { resetsAt: '2026-11-06T10:00:00Z' }]) {
      expect(
        usageLimitState({ ...part, usageLimit }, { lastTurnId: 'trn_1' }, now).toggleable,
      ).toBe(false);
    }
  });

  it('keeps an armed schedule readable and cancelable without enabling eligibility', () => {
    expect(usageLimitState({ ...part, usageLimit: {} }, { armed }, now)).toEqual({
      armed,
      toggleable: false,
    });
  });
});

describe('shared handoff detail rows', () => {
  const labels: HandoffLabels = {
    text: (key: string, params?: Record<string, string | number>) =>
      `${key}${params ? ` ${JSON.stringify(params)}` : ''}`,
    providerLabel: (id) => (id === 'claude' ? 'Claude · Work' : id),
  };

  it('retains usage routing facts and unknown skip reasons', () => {
    const rows = handoffDetailRows(
      {
        kind: 'configured',
        from: { providerId: 'api', modelId: 'm' },
        to: { providerId: 'api', modelId: 'n' },
        reason: 'usage_limit',
        failover: { originTurnId: 'trn_1', attempt: 2 },
        skipped: [
          { providerId: 'claude', reason: 'exhausted' },
          { providerId: 'removed', reason: 'future_reason' },
        ],
      },
      labels,
    );
    expect(rows.map(({ key, value }) => [key, value])).toEqual([
      ['reason', 'handoff.reason.usage_limit'],
      ['attempt', '2'],
      [
        'skipped',
        'Claude · Work · routing.reason.exhaustedcommon.listSeparatorremoved · future_reason',
      ],
    ]);
  });

  it('does not invent routing details for older notices', () => {
    expect(
      handoffDetailRows(
        {
          kind: 'configured',
          from: { providerId: 'api', modelId: 'm' },
          to: { providerId: 'api', modelId: 'n' },
        },
        labels,
      ),
    ).toEqual([]);
  });
});
