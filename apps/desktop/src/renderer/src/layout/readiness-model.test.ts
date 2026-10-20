import type {
  InstallRun,
  ReadinessItem,
  ReadinessReport,
  SessionId,
  WorkspaceId,
} from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { reasonLabel } from '@/session/verification-model';
import {
  adviceLabels,
  itemDetail,
  itemTone,
  mergeChange,
  problemCount,
  readinessReasonLabel,
  sortedItems,
} from './readiness-model';

const WORKSPACE = 'ws_01JA2B3C4D5E6F7G8H9JKMNPQR' as WorkspaceId;
const SESSION = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR' as SessionId;
const OTHER = 'ses_01JA2B3C4D5E6F7G8H9JKMNPQS' as SessionId;

function item(id: string, patch: Partial<ReadinessItem> = {}): ReadinessItem {
  return {
    id,
    kind: 'runtime',
    name: id,
    path: '',
    status: 'ready',
    blocking: true,
    evidence: [],
    ...patch,
  };
}

function report(patch: Partial<ReadinessReport> = {}): ReadinessReport {
  return {
    workspaceId: WORKSPACE,
    sessionId: SESSION,
    root: '/p',
    status: 'ready',
    checkedAt: '2026-10-20T00:00:00.000Z',
    durationMs: 1,
    projects: [],
    items: [],
    plans: [],
    network: {
      registries: [],
      proxy: [],
      agent: { engine: 'codex', network: 'sandboxed', domains: 'not_enforced' },
      advice: [],
    },
    ...patch,
  };
}

function run(startedAt: string, patch: Partial<InstallRun> = {}): InstallRun {
  return {
    id: 'ins_01JA2B3C4D5E6F7G8H9JKMNPQR' as InstallRun['id'],
    workspaceId: WORKSPACE,
    root: '/p',
    planId: 'pln_1',
    path: '',
    manager: 'npm',
    command: 'npm ci',
    status: 'running',
    startedAt,
    timeoutMs: 60_000,
    bytes: 0,
    ...patch,
  };
}

describe('sortedItems', () => {
  it('阻塞的在前，不阻塞的、未知的其次，就绪的最后；同一档保持原顺序', () => {
    const items = [
      item('a'),
      item('b', { status: 'unknown', blocking: false }),
      item('c', { status: 'missing' }),
      item('d', { status: 'incompatible', blocking: false }),
      item('e', { status: 'permission' }),
      item('f', { status: 'missing' }),
    ];
    expect(sortedItems(items).map((entry) => entry.id)).toEqual(['e', 'c', 'f', 'd', 'b', 'a']);
    expect(problemCount(items)).toBe(4);
  });
});

describe('itemTone 与 itemDetail', () => {
  it('阻塞的是红色，不阻塞的是黄色；版本不符写出要求', () => {
    expect(itemTone(item('a', { status: 'missing' }))).toBe('danger');
    expect(itemTone(item('a', { status: 'missing', blocking: false }))).toBe('warning');
    expect(itemTone(item('a', { status: 'unknown' }))).toBe('neutral');
    expect(itemTone(item('a'))).toBe('success');
    expect(
      itemDetail(
        item('node', {
          status: 'incompatible',
          reason: 'version_mismatch',
          required: '>=24.15',
          found: '22.1.0',
        }),
      ),
    ).toEqual({ reason: 'readiness.reason.version_mismatch', version: '22.1.0 → >=24.15' });
    expect(itemDetail(item('node', { found: '24.21.0' }))).toEqual({ version: '24.21.0' });
    expect(itemDetail(item('x', { status: 'unknown', reason: 'whatever' }))).toEqual({});
  });
});

describe('原因与建议的文案', () => {
  it('认识的原因有文案，不认识的没有；验证记录的原因也能用预检的文案', () => {
    expect(readinessReasonLabel('lockfile_mismatch')).toBe('readiness.reason.lockfile_mismatch');
    expect(readinessReasonLabel('nope')).toBeUndefined();
    expect(reasonLabel('dependencies_outdated')).toBe('readiness.reason.dependencies_outdated');
    expect(reasonLabel('dependencies_missing')).toBe('verification.reason.dependencies_missing');
    expect(reasonLabel('environment_not_ready')).toBe('verification.reason.environment_not_ready');
  });

  it('建议去重、不认识的跳过', () => {
    expect(
      adviceLabels(['domains_not_enforced', 'x', 'domains_not_enforced', 'install_by_user']),
    ).toEqual(['readiness.advice.domains_not_enforced', 'readiness.advice.install_by_user']);
  });
});

describe('mergeChange', () => {
  it('别的根目录不管；只带安装的换掉 install（旧的不覆盖新的）', () => {
    const current = report({ install: run('2026-10-20T00:00:02.000Z') });
    expect(
      mergeChange(current, {
        workspaceId: WORKSPACE,
        root: '/other',
        run: run('2026-10-20T00:00:03.000Z'),
      }),
    ).toBe(current);
    expect(
      mergeChange(current, {
        workspaceId: WORKSPACE,
        root: '/p',
        run: run('2026-10-20T00:00:01.000Z'),
      }),
    ).toBe(current);
    const next = run('2026-10-20T00:00:03.000Z', { status: 'succeeded' });
    expect(mergeChange(current, { workspaceId: WORKSPACE, root: '/p', run: next })?.install).toBe(
      next,
    );
    expect(
      mergeChange(undefined, { workspaceId: WORKSPACE, root: '/p', run: next }),
    ).toBeUndefined();
  });

  it('带报告的整份换掉；别的会话的报告留着自己的会话与 Agent 网络', () => {
    const current = report();
    const same = report({ status: 'not_ready' });
    expect(mergeChange(current, { workspaceId: WORKSPACE, root: '/p', report: same })).toBe(same);
    const other = report({
      sessionId: OTHER,
      status: 'not_ready',
      network: {
        registries: [],
        proxy: [],
        agent: { engine: 'claude', network: 'engine_managed', domains: 'not_enforced' },
        advice: ['install_by_user'],
      },
    });
    const merged = mergeChange(current, { workspaceId: WORKSPACE, root: '/p', report: other });
    expect(merged).toMatchObject({
      sessionId: SESSION,
      status: 'not_ready',
      network: { agent: { engine: 'codex' }, advice: ['install_by_user'] },
    });
  });
});
