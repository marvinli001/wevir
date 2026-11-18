import type { WevirClient } from '@wevir/client-sdk';
import type { AccountState } from '@wevir/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatgptAccountSection } from './chatgpt-account';

const client = { supports: () => true } as unknown as WevirClient;
const render = (account?: AccountState) =>
  renderToStaticMarkup(
    createElement(ChatgptAccountSection, { client, account, provider: undefined }),
  );

describe('订阅详情的首帧用量', () => {
  it('账号未加载时保留两个用量框，进度条留空', () => {
    const html = render();
    expect(html).toContain('5 小时用量');
    expect(html).toContain('每周用量');
    expect(html).not.toContain('width:');
    expect(html).not.toContain('data-reset-credits');
  });

  it('直接显示账号表带来的进度和重置额度', () => {
    const html = render({
      kind: 'chatgpt',
      status: 'signed_in',
      plan: 'plus',
      email: 'sample@example.test',
      rateLimits: {
        windows: [
          { usedPercent: 37, windowMinutes: 300 },
          { usedPercent: 62, windowMinutes: 10080 },
        ],
      },
      resetCredits: { availableCount: 1 },
    });
    expect(html).toContain('width:37%');
    expect(html).toContain('width:62%');
    expect(html).toContain('data-reset-credits');
    expect(html).not.toContain('sample@example.test');
  });
});
