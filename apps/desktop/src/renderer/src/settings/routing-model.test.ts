import type {
  AccountState,
  ProviderProfile,
  RoutingDecision,
  RoutingSettings,
  WevirEvent,
} from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { decideRouting } from '../../../../../../packages/host/src/routing.js';
import {
  isRoutingSwitch,
  moveRoutingNode,
  routingMenuProviders,
  routingNodes,
  routingReason,
} from './routing-model';

const now = Date.parse('2026-11-03T00:00:00Z');
const turnId = 'trn_1';
const from = { providerId: 'claude', modelId: 'm' };
const provider = (
  id: string,
  kind: ProviderProfile['kind'] = 'claude',
  enabled = true,
): ProviderProfile => ({
  id,
  kind,
  enabled,
  displayName: id,
  models: [{ id: 'm' }, { id: 'other' }],
  defaultModelId: 'm',
  hasSecret: false,
  createdAt: new Date(now).toISOString(),
  updatedAt: new Date(now).toISOString(),
});
const account = (id: string, usedPercent = 20, hours = 3): AccountState => ({
  id,
  kind: 'claude',
  status: 'signed_in',
  rateLimits: {
    windows: [{ usedPercent, resetsAt: new Date(now + hours * 3_600_000).toISOString() }],
  },
});
const settings: RoutingSettings = {
  enabled: false,
  preferSoonestReset: true,
  chain: [
    { providerId: 'api', modelId: 'm' },
    { providerId: 'other-api', modelId: 'other' },
  ],
};
const providers = [
  provider('claude'),
  provider('late'),
  provider('soon'),
  provider('api', 'openai-compatible'),
  provider('other-api', 'openai-compatible'),
];
const accounts = [account('claude', 100), account('late', 20, 5), account('soon', 10, 1)];

describe('路由链与 Host 一致', () => {
  it('关闭仍显示常用来源、按重置排序的同订阅账号和可编辑备用链', () => {
    const nodes = routingNodes(providers, accounts, from, settings, now);
    expect(nodes.map((node) => [node.providerId, node.section])).toEqual([
      ['claude', 'current'],
      ['soon', 'account'],
      ['late', 'account'],
      ['api', 'backup'],
      ['other-api', 'backup'],
    ]);
    expect(nodes[0]?.reason).toBe('exhausted');
    expect(nodes[1]?.reason).toBeUndefined();
    expect(settings.enabled).toBe(false);
  });

  it('同订阅节点的模型和停用覆盖只出现一次，不会被备用排序移到后面', () => {
    const custom = {
      ...settings,
      preferSoonestReset: false,
      chain: [...settings.chain, { providerId: 'late', modelId: 'other', enabled: false }],
    };
    const nodes = routingNodes(providers, accounts, from, custom, now);
    expect(nodes.filter((node) => node.providerId === 'late')).toMatchObject([
      { section: 'account', modelId: 'other', reason: 'node_disabled', chainIndex: 2 },
    ]);
    expect(nodes[1]?.providerId).toBe('late');
  });

  it('来源/模型缺失、未登录、停用与额度耗尽都保留并注明原因', () => {
    const chain = ['missing', 'signedout', 'disabled', 'full', 'bad-model'].map((providerId) => ({
      providerId,
      modelId: 'm',
    }));
    const listed = [
      provider('signedout'),
      provider('disabled', 'claude', false),
      provider('full'),
      { ...provider('bad-model', 'openai-compatible'), models: [{ id: 'valid' }] },
    ];
    const nodes = routingNodes(
      listed,
      [{ ...account('signedout'), status: 'signed_out' }, account('full', 100)],
      undefined,
      { ...settings, chain },
      now,
    );
    expect(nodes.map((node) => node.reason)).toEqual([
      'provider_missing',
      'signed_out',
      'provider_disabled',
      'exhausted',
      'model_missing',
    ]);
  });

  it('全满时无下一跳；过期窗口与分份窗口沿用共享额度规则', () => {
    const full = accounts.map((item) => account(item.id ?? item.kind, 100));
    const onlyAccounts = providers.filter((item) => item.kind === 'claude');
    expect(
      routingNodes(onlyAccounts, full, from, { ...settings, chain: [] }, now).every(
        (node) => node.reason === 'exhausted',
      ),
    ).toBe(true);
    full[1] = account('late', 100, -1);
    full[2] = {
      ...account('soon'),
      rateLimits: {
        windows: [
          { usedPercent: 100, scope: 'A' },
          { usedPercent: 40, scope: 'B' },
        ],
      },
    };
    expect(
      routingNodes(onlyAccounts, full, from, { ...settings, chain: [] }, now)
        .slice(1)
        .every((node) => !node.reason),
    ).toBe(true);
  });

  it('拖序后的首个可用节点就是 Host 的目标，跳过节点原因一致', () => {
    const chain = moveRoutingNode(settings.chain, 1, 0);
    expect(chain.map((node) => node.providerId)).toEqual(['other-api', 'api']);
    expect(settings.chain[0]?.providerId).toBe('api');
    const full = accounts.map((item) => account(item.id ?? item.kind, 100));
    const configuration = { ...settings, enabled: true, chain };
    const nodes = routingNodes(providers, full, from, configuration, now);
    const decision = decideRouting({
      settings: configuration,
      providers,
      account: (id) => full.find((account) => account.id === id),
      from,
      turnId,
      previous: undefined,
      now,
    });
    const next = nodes.find((node) => node.section !== 'current' && !node.reason);
    expect(decision.to).toEqual({ providerId: next?.providerId, modelId: next?.modelId });
    expect(decision.to?.providerId).toBe('other-api');
    expect(decision.skipped.map((skip) => skip.reason)).toEqual(['exhausted', 'exhausted']);
    expect(moveRoutingNode(chain, 0, -1)).toBe(chain);
  });

  it('仅定位同原回合、同次数的额度切换；未知原因原样保留', () => {
    const decision: RoutingDecision = {
      turnId,
      originTurnId: turnId,
      attempt: 2,
      from,
      to: from,
      skipped: [],
      at: new Date(now).toISOString(),
    };
    const event: WevirEvent = {
      seq: 1,
      sessionId: 'ses_1',
      ts: new Date(now).toISOString(),
      source: 'host',
      type: 'session.configured',
      payload: {
        modelId: 'm',
        reason: 'usage_limit',
        failover: { originTurnId: turnId, attempt: 2 },
      },
    };
    expect(isRoutingSwitch(event, decision)).toBe(true);
    expect(isRoutingSwitch(event, { ...decision, attempt: 1 })).toBe(false);
    expect(isRoutingSwitch({ ...event, payload: { modelId: 'm' } } as WevirEvent, decision)).toBe(
      false,
    );
    expect(routingReason('signed_out')).toBe('未登录');
    expect(routingReason('future_reason')).toBe('future_reason');
  });
});

describe('路由模型菜单', () => {
  it('只列启用且已登录的来源，当前用的照列', () => {
    const providers = [
      provider('claude'),
      provider('signed-out'),
      provider('api', 'openai-compatible'),
      provider('off', 'openai-compatible', false),
    ];
    const accounts = [
      account('claude'),
      { ...account('signed-out'), status: 'signed_out' as const },
    ];
    expect(routingMenuProviders(providers, accounts).map((p) => p.id)).toEqual(['claude', 'api']);
    expect(routingMenuProviders(providers, accounts, 'off').map((p) => p.id)).toEqual([
      'claude',
      'api',
      'off',
    ]);
  });
});
