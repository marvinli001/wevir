import type { LspServerStatus } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { defaultPlan, installing, lspSummary, rootLabel, rowDetail } from './lsp-model';

const server = (state: LspServerStatus['state'], extra: Partial<LspServerStatus> = {}) =>
  ({ serverId: 'go', language: 'Go', root: '/p', state, ...extra }) as LspServerStatus;

describe('lsp-model', () => {
  it('摘要：能用的个数与最该注意的颜色', () => {
    expect(lspSummary([])).toEqual({ ready: 0, total: 0, tone: 'neutral' });
    expect(lspSummary([server('running'), server('not_started')])).toEqual({
      ready: 2,
      total: 2,
      tone: 'success',
    });
    expect(lspSummary([server('running'), server('missing'), server('failed')])).toEqual({
      ready: 1,
      total: 3,
      tone: 'danger',
    });
    expect(lspSummary([server('outdated')]).tone).toBe('warning');
  });

  it('项目根相对扫描目录显示', () => {
    expect(rootLabel('/p', '/p')).toBe('');
    expect(rootLabel('/p', '/p/services/one')).toBe('services/one');
    expect(rootLabel('C:\\p', 'C:\\p\\a\\b')).toBe('a/b');
    expect(rootLabel('/p', '/other')).toBe('/other');
  });

  it('一行右边：能用的写版本，不能用的写状态', () => {
    expect(rowDetail(server('running', { version: '0.16.2' }))).toEqual({
      version: '0.16.2',
      state: 'lsp.state.running',
    });
    expect(rowDetail(server('outdated', { version: '1.2.0' }))).toEqual({
      state: 'lsp.state.outdated',
    });
  });

  it('默认方案：第一个能运行的', () => {
    const manual = { id: 'a', scope: 'system' as const, command: 'sudo x', runnable: false };
    const plans = [
      manual,
      { id: 'b', scope: 'user' as const, command: 'go install x', runnable: true },
    ];
    expect(defaultPlan(plans)?.id).toBe('b');
    expect(defaultPlan([manual])?.id).toBe('a');
    expect(defaultPlan([])).toBeUndefined();
  });

  it('安装中', () => {
    const run = { status: 'verifying' } as LspServerStatus['install'];
    expect(installing(server('missing', { install: run }))).toBe(true);
    expect(installing(server('missing'))).toBe(false);
  });
});
