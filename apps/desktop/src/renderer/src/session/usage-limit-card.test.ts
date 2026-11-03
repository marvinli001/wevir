import type { ChatPartOf } from '@wevir/client-sdk';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { type MessageActions, MessageActionsContext } from './message-actions';
import { UsageLimitCard } from './usage-limit-card';

vi.mock('@/data/workbench-data', () => ({
  useWorkbenchProviders: () => [],
  useAccounts: () => [],
}));
const part: ChatPartOf<'error'> = {
  type: 'error',
  key: 'e:1',
  category: 'provider',
  message: 'quota',
  fatal: false,
  turnId: 'trn_1',
  usageLimit: {},
};
function render(actions: MessageActions, extra: Partial<typeof part> = {}) {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      {},
      createElement(
        MessageActionsContext,
        { value: actions },
        createElement(UsageLimitCard, { part: { ...part, ...extra } }),
      ),
    ),
  );
}

describe('额度卡片的路由状态', () => {
  it('路由关闭时仍提供入口，旧 Host 不显示入口；不自动启用', () => {
    expect(render({ routing: { enabled: false } })).toContain('data-testid="usage-limit-routing"');
    expect(render({})).not.toContain('data-testid="usage-limit-routing"');
  });

  it('实际切换有目标且路由开启才显示接力结果', () => {
    const routedTo = { providerId: 'backup', modelId: 'Target' };
    expect(render({ routing: { enabled: true } })).not.toContain(
      'data-testid="usage-limit-routed"',
    );
    expect(render({ routing: { enabled: false } }, { routedTo })).not.toContain(
      'data-testid="usage-limit-routed"',
    );
    expect(render({ routing: { enabled: true } }, { routedTo })).toContain('已接力到 Target');
  });
});
