import type { ContinuityNotice } from '@wevir/client-sdk';
import type { ProviderProfile } from '@wevir/protocol';
import { beforeAll, describe, expect, it } from 'vitest';
import { setLocale } from '../i18n';
import { continuityView, modelLabel } from './continuity';

beforeAll(() => setLocale('zh-CN'));
const providers = [
  {
    id: 'claude',
    kind: 'claude',
    displayName: 'Claude',
    models: [{ id: 'm', displayName: 'Sonnet' }],
  },
  {
    id: 'chatgpt',
    kind: 'chatgpt',
    displayName: 'ChatGPT',
    models: [{ id: 'n', displayName: 'GPT' }],
  },
] as ProviderProfile[];
const notice: ContinuityNotice = {
  kind: 'handoff',
  fromProviderId: 'claude',
  fromModelId: 'm',
  providerId: 'chatgpt',
  modelId: 'n',
  strategy: 'full_thread_summary',
  resumed: false,
  covered: { fromSeq: 1, toSeq: 9 },
  items: 4,
  omittedItems: 1,
  historyTool: true,
  context: 'Keep the task going.',
  delivery: { status: 'delivered', turnId: 'trn_2' },
  reason: 'usage_limit',
  failover: { originTurnId: 'trn_1', attempt: 2 },
  skipped: [{ providerId: 'removed', reason: 'future_reason' }],
  receipt: {
    bytes: 120,
    budgetBytes: 16000,
    hash: '0123456789abcdef0123',
    constraints: 1,
    notes: [],
    omitted: [{ first: 'e1', last: 'e3', count: 3 }],
  },
};

describe('phone continuity details', () => {
  it('shows both sources and the same receipt, delivery and routing facts as desktop', () => {
    const view = continuityView(notice, providers);
    expect(view.label).toBe('Claude → Codex');
    expect(view.rows.find((row) => row.key === 'target')?.value).toBe('Codex · GPT');
    expect(view.rows.find((row) => row.key === 'from')?.value).toBe('Claude · Sonnet');
    expect(view.rows.find((row) => row.key === 'skipped')?.value).toBe('removed · future_reason');
    expect(view.rows.find((row) => row.key === 'status')).toMatchObject({
      value: '已递交',
      tone: 'success',
    });
    expect(view.rows.map((row) => row.key)).toEqual([
      'target',
      'from',
      'reason',
      'attempt',
      'skipped',
      'strategy',
      'engine',
      'covered',
      'items',
      'history',
      'omitted',
      'constraints',
      'notes',
      'bytes',
      'hash',
      'status',
    ]);
  });

  it('keeps manual model changes and deleted providers readable', () => {
    const view = continuityView(
      {
        kind: 'configured',
        from: { providerId: 'removed', modelId: 'old' },
        to: { providerId: 'chatgpt', modelId: 'n' },
      },
      providers,
    );
    expect(view.label).toBe('removed → Codex');
    expect(view.rows.map((row) => row.key)).toEqual(['target', 'from']);
    expect(modelLabel([], { providerId: 'removed', modelId: 'old' })).toBe('removed · old');
  });
});
