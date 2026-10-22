import { join } from 'node:path';
import type { HostSettings, TuningMetrics, TuningProposalId, WorkspaceId } from '@wevir/protocol';
import type { Storage } from '@wevir/storage';
import { describe, expect, it } from 'vitest';
import { useStorages, useTempDir } from '../test-utils.js';
import { TrialService } from './trials.js';

const tempDir = useTempDir();
const storages = useStorages();
const WS = 'ws_1' as WorkspaceId;
const T0 = '2026-10-10T00:00:00.000Z';
const HASH = 'a'.repeat(64);

function metrics(turns: number, failed: number, passed?: number, total?: number): TuningMetrics {
  return {
    sessions: 1,
    turns,
    failedTurns: failed,
    ...(total !== undefined && { checks: { passed: passed ?? 0, total } }),
    guardrailHits: 0,
  };
}

function setup(options: { settings?: HostSettings; now?: string } = {}) {
  const storage: Storage = storages.open(join(tempDir(), 'data'));
  storage.workspaces.insert({
    id: WS,
    rootPath: '/p',
    displayName: 'p',
    createdAt: T0,
    updatedAt: T0,
  });
  const sessionMetrics = new Map<string, TuningMetrics>();
  let seq = 0;
  const version = (createdAt = T0, global = false) =>
    storage.profileVersions.ensure({
      id: `pfv_${++seq}`,
      ...(!global && { workspaceId: WS }),
      fingerprint: `${seq}`.padStart(64, '0'),
      manifest: { layers: [] },
      createdAt,
    }).version;
  let sessions = 0;
  const session = (versionId: string, m: TuningMetrics, createdAt = T0) => {
    const id = `ses_${++sessions}`;
    storage.sessions.insert({
      id,
      workspaceId: WS,
      cwd: '/p',
      engine: 'echo',
      engineSessionId: id,
      providerId: 'p',
      modelId: 'm',
      title: '',
      titleSource: 'first_prompt',
      state: 'idle',
      lastSeq: 0,
      createdAt,
      updatedAt: createdAt,
      profileVersionId: versionId,
    });
    sessionMetrics.set(id, m);
    return id;
  };
  const proposal = (id: string, versionId?: string, decidedAt = T0) => {
    storage.tuningProposals.insert({
      id,
      workspaceId: WS,
      sessionId: 'ses_x',
      kind: 'rule',
      title: id,
      target: 'AGENTS.md',
      baseHash: HASH,
      payload: {},
      evidence: [],
      status: 'trial',
      origin: 'auto',
      createdAt: decidedAt,
      decidedAt,
      ...(versionId !== undefined && { versionId }),
    });
  };
  const calls: unknown[][] = [];
  let now = options.now ?? '2026-10-12T00:00:00.000Z';
  const settings = options.settings ?? { sendWhileBusy: 'steer' };
  const service = new TrialService({
    storage,
    metrics: {
      eligible: (ids) =>
        ids.flatMap((sessionId) => {
          const m = sessionMetrics.get(sessionId);
          return m === undefined || m.turns === 0 ? [] : [{ sessionId, metrics: m }];
        }),
    },
    proposals: {
      trialRecords: (workspaceId) =>
        storage.tuningProposals
          .list({ workspaceId, statuses: ['trial'] })
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      conclude: (id, outcome) => {
        calls.push(['conclude', id, outcome]);
        storage.tuningProposals.update(id, { status: 'accepted', outcome });
      },
      revert: async (id, by, outcome) => {
        calls.push(['revert', id, by, outcome]);
        storage.tuningProposals.update(id, { status: 'reverted', outcome });
        return {} as never;
      },
    },
    settings: () => settings,
    now: () => new Date(now),
  });
  return {
    storage,
    service,
    version,
    session,
    proposal,
    calls,
    setNow: (at: string) => {
      now = at;
    },
  };
}

describe('TrialService', () => {
  it('没有试用时什么都不做；还没有起点时试用会话数是 0，到期按数据不足保留', async () => {
    const h = setup();
    await h.service.evaluate(WS);
    expect(h.calls).toEqual([]);
    expect(h.service.hasTrial(WS)).toBe(false);

    h.proposal('tpr_1');
    expect(h.service.hasTrial(WS)).toBe(true);
    const overview = await h.service.overview({ workspaceId: WS });
    expect(overview.trial).toEqual({
      proposalIds: ['tpr_1'],
      sessions: 0,
      needed: 5,
      startedAt: T0,
      deadline: '2026-10-24T00:00:00.000Z',
    });
    expect(h.calls).toEqual([]);

    h.setNow('2026-10-24T00:00:00.000Z');
    await h.service.evaluate(WS);
    expect(h.calls).toEqual([
      ['conclude', 'tpr_1', expect.objectContaining({ decidedBy: 'auto', reason: 'insufficient' })],
    ]);
  });

  it('凑够 5 个会话：失败回合变多就整组回退，依据带上两边的指标', async () => {
    const h = setup();
    const v1 = h.version();
    const v2 = h.version();
    for (let i = 0; i < 4; i++) h.session(v1.id, metrics(5, 0, 2, 2));
    h.proposal('tpr_1', v2.id);
    h.proposal('tpr_2');
    // 起点之后的版本也算试用会话。
    const v3 = h.version();
    for (let i = 0; i < 4; i++) h.session(v2.id, metrics(5, 2));
    // 只有 4 个：不决定。
    await h.service.evaluate(WS);
    expect(h.calls).toEqual([]);
    // 没完成回合的不算。
    h.session(v3.id, metrics(0, 0));
    await h.service.evaluate(WS);
    expect(h.calls).toEqual([]);
    h.session(v3.id, metrics(5, 2));
    await h.service.evaluate(WS);
    const baseline = { sessions: 4, turns: 20, failedTurns: 0, checks: { passed: 8, total: 8 } };
    const trial = { sessions: 5, turns: 25, failedTurns: 10 };
    expect(h.calls).toEqual([
      [
        'revert',
        'tpr_1',
        'auto',
        {
          reason: 'worse',
          baseline: { ...baseline, guardrailHits: 0 },
          trial: { ...trial, guardrailHits: 0 },
        },
      ],
      ['revert', 'tpr_2', 'auto', expect.objectContaining({ reason: 'worse' })],
    ]);
  });

  it('通过率明显变高时保留为 better；总览的走势标出试用中的版本', async () => {
    const h = setup();
    const v1 = h.version();
    const v2 = h.version();
    for (let i = 0; i < 3; i++) h.session(v1.id, metrics(4, 0, 1, 2));
    h.proposal('tpr_1', v2.id);
    for (let i = 0; i < 4; i++) h.session(v2.id, metrics(4, 0, 2, 2));
    const overview = await h.service.overview({ workspaceId: WS });
    expect(overview.trial).toMatchObject({ sessions: 4, startVersion: { id: v2.id, seq: 2 } });
    expect(
      overview.series.map((point) => [point.version.seq, point.metrics.sessions, point.trial]),
    ).toEqual([
      [1, 3, undefined],
      [2, 4, true],
    ]);
    expect(overview.totals).toEqual({ adopted: 1, kept: 0, reverted: 0 });

    h.session(v2.id, metrics(4, 0, 2, 2));
    await h.service.evaluate(WS);
    expect(h.calls).toEqual([
      ['conclude', 'tpr_1', expect.objectContaining({ decidedBy: 'auto', reason: 'better' })],
    ]);
    const after = await h.service.overview({ workspaceId: WS });
    expect(after.trial).toBeUndefined();
    expect(after.totals).toEqual({ adopted: 1, kept: 1, reverted: 0 });
  });

  it('预算：本月（本地时区）的合计，上限只算后台生成；全局总览没有试用与合计', async () => {
    const h = setup({
      settings: { sendWhileBusy: 'steer', autoTuning: true, autoTuningMonthlyTokens: 10_000 },
      now: '2026-10-20T12:00:00.000Z',
    });
    const run = (id: string, origin: string, createdAt: string, tokens: number) =>
      h.storage.tuningRuns.insert({
        id,
        workspaceId: WS,
        sessionId: 'ses_x',
        origin,
        usage: { inputTokens: tokens, outputTokens: 0 },
        proposals: 0,
        createdAt,
      });
    run('trr_1', 'auto', '2026-09-15T00:00:00.000Z', 50_000);
    run('trr_2', 'auto', '2026-10-15T00:00:00.000Z', 6_000);
    run('trr_3', 'user', '2026-10-16T00:00:00.000Z', 7_000);
    expect(h.service.budget()).toEqual({
      month: '2026-10',
      limitTokens: 10_000,
      usedTokens: 13_000,
      autoTokens: 6_000,
      exhausted: false,
    });
    run('trr_4', 'auto', '2026-10-17T00:00:00.000Z', 4_000);
    expect(h.service.budget()).toMatchObject({ autoTokens: 10_000, exhausted: true });
    h.version(T0, true);
    const global = await h.service.overview({});
    expect(global.auto).toEqual({ enabled: true, decided: true });
    expect(global.series).toHaveLength(1);
    expect(global).not.toHaveProperty('trial');
    expect(global).not.toHaveProperty('totals');
    expect(global).not.toHaveProperty('lastRun');
    const project = await h.service.overview({ workspaceId: WS });
    expect(project.lastRun).toEqual({
      at: '2026-10-17T00:00:00.000Z',
      origin: 'auto',
      proposals: 0,
      usage: { inputTokens: 4_000, outputTokens: 0 },
    });
  });

  it('同一个项目的核对不并发', async () => {
    const h = setup();
    const v1 = h.version();
    h.proposal('tpr_1' as TuningProposalId, v1.id);
    for (let i = 0; i < 5; i++) h.session(v1.id, metrics(5, 0));
    await Promise.all([h.service.evaluate(WS), h.service.evaluate(WS)]);
    expect(h.calls).toHaveLength(1);
  });
});
