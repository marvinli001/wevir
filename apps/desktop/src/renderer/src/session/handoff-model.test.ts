import type { EngineFeatures, ProviderProfile, Session } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  canHandoffTo,
  engineFeaturesOf,
  type HandoffNoticeOf,
  handoffDetailRows,
  modelLabel,
} from './handoff-model';

function provider(id: string, kind: ProviderProfile['kind'], extra: Partial<ProviderProfile> = {}) {
  return {
    id,
    kind,
    displayName: id,
    models: [{ id: 'm', displayName: 'Model M' }],
    defaultModelId: 'm',
    hasSecret: false,
    createdAt: '2026-10-15T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:00.000Z',
    ...extra,
  } satisfies ProviderProfile;
}

const api = provider('mock', 'openai-compatible', { displayName: 'Mock API' });
const claude = provider('claude', 'claude', { displayName: 'Claude' });
const features: Record<string, EngineFeatures> = {
  'openai-compatible': { engine: 'codex', additionalRoots: true, fork: true },
  claude: { engine: 'claude', additionalRoots: true },
  cursor: { engine: 'cursor' },
};
const session: Pick<
  Session,
  'providerId' | 'extraRoots' | 'state' | 'side' | 'parentSessionId' | 'readOnly'
> = { providerId: 'mock', state: 'idle' };

describe('接力的纯逻辑（0.25.0）', () => {
  it('engineFeaturesOf：按会话当前 Provider 的种类查；旧 Host 或认不出的 Provider 没有', () => {
    expect(engineFeaturesOf(features, [api, claude], 'claude')).toEqual(features.claude);
    expect(engineFeaturesOf(undefined, [api], 'mock')).toBeUndefined();
    expect(engineFeaturesOf(features, [api], 'gone')).toBeUndefined();
  });

  it('canHandoffTo：顶层、可写、空闲的会话能换到别的来源；同一个 Provider 不算', () => {
    expect(canHandoffTo(claude, session, features)).toBe(true);
    expect(canHandoffTo(api, session, features)).toBe(false);
    expect(canHandoffTo(claude, { ...session, state: 'running' }, features)).toBe(false);
    expect(canHandoffTo(claude, { ...session, state: 'error' }, features)).toBe(true);
    expect(canHandoffTo(claude, { ...session, side: true }, features)).toBe(false);
    expect(
      canHandoffTo(
        claude,
        { ...session, parentSessionId: 'ses_01JA2B3C4D5E6F7G8H9JKMNPQR' },
        features,
      ),
    ).toBe(false);
    expect(
      canHandoffTo(
        claude,
        { ...session, readOnly: { reason: 'engine_session_not_found', message: '', since: '' } },
        features,
      ),
    ).toBe(false);
  });

  it('canHandoffTo：有额外目录的会话只能换到支持额外目录的引擎', () => {
    const cursor = provider('cursor', 'cursor');
    const multi = { ...session, extraRoots: ['/repo/api'] };
    expect(canHandoffTo(claude, multi, features)).toBe(true);
    expect(canHandoffTo(cursor, multi, features)).toBe(false);
    expect(canHandoffTo(cursor, multi, undefined)).toBe(false);
    expect(canHandoffTo(cursor, session, features)).toBe(true);
  });

  it('modelLabel：订阅写软件名，API 写服务名，后面是模型名', () => {
    expect(modelLabel([api, claude], 'claude', 'm')).toBe('Claude · Model M');
    expect(modelLabel([api, claude], 'mock', 'm')).toBe('Mock API · Model M');
    expect(modelLabel([api], 'mock', 'other')).toBe('Mock API · other');
    expect(modelLabel([], 'gone', 'x')).toBe('x');
  });

  it('handoffDetailRows：方式、引擎会话、范围、条目、读历史与递交状态都来自事件；没有摘要时不说读历史', () => {
    const notice: HandoffNoticeOf = {
      kind: 'handoff',
      providerId: 'claude',
      modelId: 'm',
      fromProviderId: 'mock',
      fromModelId: 'm',
      resumed: true,
      strategy: 'delta_since_target_last_seen',
      covered: { fromSeq: 7, toSeq: 12 },
      items: 3,
      omittedItems: 2,
      context: 'Context handoff',
      historyTool: false,
      delivery: { status: 'delivered', turnId: 'trn_01JA2B3C4D5E6F7G8H9JKMNPQR' },
    };
    expect(handoffDetailRows(notice).map((row) => [row.key, row.value, row.tone])).toEqual([
      ['strategy', '增量', undefined],
      ['engine', '恢复', undefined],
      ['covered', '事件 7–12', undefined],
      ['items', '选入 3 条，省略 2 条', 'warning'],
      ['history', '仅摘要', 'warning'],
      ['status', '已递交', 'success'],
    ]);
    const none = handoffDetailRows({
      ...notice,
      resumed: false,
      strategy: 'full_thread_summary',
      items: 0,
      omittedItems: 0,
      covered: undefined,
      context: undefined,
      historyTool: undefined,
      delivery: { status: 'none' },
    });
    expect(none.map((row) => row.value)).toEqual([
      '完整',
      '新建',
      '无',
      '选入 0 条，省略 0 条',
      '无需材料',
    ]);
    const failed = handoffDetailRows({
      ...notice,
      delivery: { status: 'failed', reason: 'superseded' },
    });
    expect(failed.at(-1)).toMatchObject({ value: '已作废', tone: 'warning' });
    // 不说“模型已理解”。
    expect(JSON.stringify(handoffDetailRows(notice))).not.toMatch(/理解/);
  });

  it('handoffDetailRows：有递交记录（0.59.0）时列出省略的段、约束条数、笔记与版本、大小与散列', () => {
    const notice: HandoffNoticeOf = {
      kind: 'handoff',
      providerId: 'claude',
      modelId: 'm',
      fromProviderId: 'mock',
      fromModelId: 'm',
      resumed: false,
      strategy: 'full_thread_summary',
      covered: { fromSeq: 1, toSeq: 30 },
      items: 5,
      omittedItems: 4,
      context: 'Context handoff',
      historyTool: true,
      receipt: {
        bytes: 15234,
        budgetBytes: 16000,
        hash: 'abcdef0123456789'.repeat(4),
        omitted: [
          { first: 'e3', last: 'e9', count: 3 },
          { first: 'e12', last: 'e12', count: 1 },
        ],
        constraints: 2,
        notes: [{ scope: 'project', name: 'invoice-cents', revision: '3f1c2a9b7d4e6f10' }],
      },
      delivery: { status: 'prepared' },
    };
    const rows = Object.fromEntries(handoffDetailRows(notice).map((row) => [row.key, row.value]));
    expect(rows).toMatchObject({
      omitted: 'e3–e9（3 条）、e12',
      constraints: '2 条',
      notes: 'invoice-cents · 3f1c2a9b',
      bytes: `${(15234).toLocaleString()} / ${(16000).toLocaleString()} 字节`,
      hash: 'abcdef0123456789',
    });
    expect(Object.keys(rows).at(-1)).toBe('status');
  });
});
