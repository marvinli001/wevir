import type { SessionInsight } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { currentInsight, insightsEnabled } from './insight-model';

const insight = (id: string, status: SessionInsight['status']): SessionInsight => ({
  id: `isg_01JA2B3C4D5E6F7G8H9JKMNP${id}`,
  turnId: 'trn_01JA2B3C4D5E6F7G8H9JKMNPQR',
  tag: 'heads_up',
  summary: '只跑了登录目录下的测试。',
  title: '只跑了登录相关的测试',
  detail: '其余的没跑。',
  status,
  throughSeq: 10,
  createdAt: '2026-10-21T08:00:00.000Z',
  updatedAt: '2026-10-21T08:00:00.000Z',
});

describe('currentInsight', () => {
  it('最近提出的、还没处理的那条', () => {
    expect(currentInsight([insight('A1', 'open'), insight('A2', 'known')])?.id).toBe(
      'isg_01JA2B3C4D5E6F7G8H9JKMNPA1',
    );
    expect(currentInsight([insight('A1', 'open'), insight('A2', 'open')])?.id).toBe(
      'isg_01JA2B3C4D5E6F7G8H9JKMNPA2',
    );
  });

  it('都处理过或没有时不显示', () => {
    expect(currentInsight([insight('A1', 'known'), insight('A2', 'dismissed')])).toBeUndefined();
    expect(currentInsight([])).toBeUndefined();
    expect(currentInsight(undefined)).toBeUndefined();
  });
});

describe('insightsEnabled', () => {
  const base = {
    featureSupported: true,
    settings: { sessionInsights: true },
    variant: 'main' as const,
    side: undefined,
    parentSessionId: undefined,
  };

  it('Host 有功能、设置开着、主窗格的顶层会话', () => {
    expect(insightsEnabled(base)).toBe(true);
  });

  it('设置默认关：省略按关着', () => {
    expect(insightsEnabled({ ...base, settings: {} })).toBe(false);
    expect(insightsEnabled({ ...base, settings: { sessionInsights: false } })).toBe(false);
  });

  it('Host 没有功能、并排窗格、支线、子会话都不显示', () => {
    expect(insightsEnabled({ ...base, featureSupported: false })).toBe(false);
    expect(insightsEnabled({ ...base, variant: 'pane' })).toBe(false);
    expect(insightsEnabled({ ...base, side: true })).toBe(false);
    expect(insightsEnabled({ ...base, parentSessionId: 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR' })).toBe(
      false,
    );
  });
});
