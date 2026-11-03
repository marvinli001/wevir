import { DEFAULT_HOST_SETTINGS, type ProviderProfile } from '@wevir/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useHostSettings } from '@/data/host-settings';
import { RoutingSettingsPage } from './routing-settings';

vi.mock('@/data/host-settings', () => ({ useHostSettings: vi.fn() }));
vi.mock('@/host/host-connection', () => ({
  useHostConnection: () => ({
    view: { status: 'connected', hello: { features: { usage_limit_routing: true } } },
  }),
}));
vi.mock('@/session/start-session', () => ({
  lastChoice: { use: () => ({ providerId: 'api', modelId: 'm' }), set: vi.fn() },
  resolveChoice: () => ({ providerId: 'api', modelId: 'm' }),
}));
vi.mock('@/data/workbench-data', () => ({
  useAccounts: () => [],
  useWorkbenchData: () => ({
    status: 'ready',
    workspaces: [],
    providers: [provider('api'), provider('backup')],
  }),
}));

function provider(id: string): ProviderProfile {
  return {
    id,
    kind: 'openai-compatible',
    displayName: id,
    defaultModelId: 'm',
    models: [{ id: 'm' }],
    hasSecret: false,
    createdAt: '2026-11-03T00:00:00Z',
    updatedAt: '2026-11-03T00:00:00Z',
  };
}
const update = vi.fn();
beforeEach(() => {
  update.mockClear();
  vi.mocked(useHostSettings).mockReturnValue({
    supported: true,
    editable: true,
    settings: {
      ...DEFAULT_HOST_SETTINGS,
      routing: {
        enabled: false,
        preferSoonestReset: true,
        chain: [{ providerId: 'backup', modelId: 'm' }],
      },
    },
    update,
  });
});
const render = () =>
  renderToStaticMarkup(createElement(MemoryRouter, {}, createElement(RoutingSettingsPage)));

describe('路由设置页', () => {
  it('进入页面不改 Host 设置；关闭时开关、添加和备用拖序仍可用', () => {
    const html = render();
    expect(html).toContain('data-enabled="false"');
    expect(html).toContain('data-action="routing-toggle"');
    expect(html).toContain('draggable="true"');
    expect(html).toContain('data-action="routing-add"');
    expect(html).toContain('最近决定');
    expect(html).not.toContain('disabled=""');
    expect(update).not.toHaveBeenCalled();
  });

  it('保存期间或只读连接禁用编辑，不隐去链和额度', () => {
    vi.mocked(useHostSettings).mockReturnValue({ ...useHostSettings(), editable: false });
    const html = render();
    expect(html).toContain('draggable="false"');
    expect(html).toContain('disabled=""');
    expect(html).toContain('data-routing-node="backup"');
    expect(html).toContain('按量计费');
  });
});
