import type { AccountState, ProviderProfile } from '@wevir/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QuotaNode } from './quota-node';

const provider: ProviderProfile = {
  id: 'claude',
  kind: 'claude',
  displayName: 'Claude',
  defaultModelId: 'm',
  models: [{ id: 'm', displayName: 'Model' }],
  hasSecret: false,
  createdAt: '2026-11-03T00:00:00Z',
  updatedAt: '2026-11-03T00:00:00Z',
};
const account: AccountState = {
  id: 'claude',
  kind: 'claude',
  label: '工作',
  status: 'signed_in',
  rateLimits: {
    windows: [
      { usedPercent: 100, windowMinutes: 300, resetsAt: '2026-11-03T04:00:00Z' },
      { usedPercent: 42, windowMinutes: 10080, resetsAt: '2026-11-07T00:00:00Z' },
    ],
  },
};
const props = {
  provider,
  providerId: provider.id,
  modelId: 'm',
  accounts: [account],
  now: Date.parse('2026-11-03T00:00:00Z'),
};

describe('共用额度节点', () => {
  it('账号、模型、全部额度窗口、节奏与重置时间', () => {
    const html = renderToStaticMarkup(createElement(QuotaNode, props));
    expect(html).toContain('Claude · 工作');
    expect(html).toContain('Model');
    expect(html).toContain('已用 100%');
    expect(html).toContain('已用 42%');
    expect(html).toContain('重置');
    expect(html.match(/data-testid="usage-pace-mark"/g)).toHaveLength(2);
  });

  it('置灰注明原因，但节点编辑控件仍可用', () => {
    const html = renderToStaticMarkup(
      createElement(QuotaNode, {
        ...props,
        reason: 'exhausted',
        controls: createElement('button', { type: 'button' }, '模型'),
      }),
    );
    expect(html).toContain('data-reason="exhausted"');
    expect(html).toContain('grayscale');
    expect(html).toContain('额度已满');
    expect(html).toContain('<button type="button">模型</button>');
  });

  it('没有额度不画虚构的进度条，区分按量来源、未知额度与来源缺失', () => {
    const api = renderToStaticMarkup(
      createElement(QuotaNode, { ...props, provider: { ...provider, kind: 'openai-compatible' } }),
    );
    expect(api).toContain('按量计费');
    expect(api).not.toContain('usage-pace-mark');
    expect(renderToStaticMarkup(createElement(QuotaNode, { ...props, accounts: [] }))).toContain(
      '暂无额度',
    );
    expect(
      renderToStaticMarkup(
        createElement(QuotaNode, { ...props, provider: undefined, reason: 'provider_missing' }),
      ),
    ).toContain('来源已移除');
  });
});
