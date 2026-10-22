import type { AccountUpstream } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  connectMode,
  connectParams,
  loginPrompt,
  upstreamsStamp,
  visibleUpstreams,
} from './subscription-upstreams-model';

const key = { type: 'api_key', label: 'API key', option: 'default' } as const;

function upstream(id: string, featured: boolean, methods: AccountUpstream['methods'] = [key]) {
  return { id, name: id.toUpperCase(), connected: false, featured, methods };
}

const LIST = [
  upstream('zeta', false),
  upstream('openai', true),
  upstream('groq', false),
  upstream('opencode', true),
];

describe('visibleUpstreams', () => {
  it('默认只列常用的，数出收起了几个', () => {
    const { rows, hidden } = visibleUpstreams(LIST, { query: '', expanded: false });
    expect(rows.map((u) => u.id)).toEqual(['openai', 'opencode']);
    expect(hidden).toBe(2);
  });

  it('展开后全列，常用的仍在前', () => {
    const { rows, hidden } = visibleUpstreams(LIST, { query: ' ', expanded: true });
    expect(rows.map((u) => u.id)).toEqual(['openai', 'opencode', 'zeta', 'groq']);
    expect(hidden).toBe(0);
  });

  it('搜索在全部里按名称与 ID 匹配，大小写不分', () => {
    expect(visibleUpstreams(LIST, { query: 'GRO', expanded: false })).toEqual({
      rows: [LIST[2]],
      hidden: 0,
    });
    expect(
      visibleUpstreams(LIST, { query: 'open', expanded: false }).rows.map((u) => u.id),
    ).toEqual(['openai', 'opencode']);
    expect(visibleUpstreams(LIST, { query: 'nope', expanded: true }).rows).toEqual([]);
  });
});

describe('connectMode', () => {
  it('一种方式：OAuth 直接开始，填 Key 展开输入；多种让用户选', () => {
    expect(connectMode(upstream('a', true))).toBe('key');
    expect(connectMode(upstream('b', true, [{ type: 'oauth', label: 'Login', option: '0' }]))).toBe(
      'oauth',
    );
    expect(
      connectMode(upstream('c', true, [{ type: 'oauth', label: 'Login', option: '0' }, key])),
    ).toBe('choose');
  });

  it('connectParams：Key 去掉首尾空白，没有 Key 时不带这个字段', () => {
    const openai = upstream('openai', true);
    expect(connectParams({ kind: 'opencode' }, openai, key, '  sk-1\n')).toEqual({
      kind: 'opencode',
      method: 'browser',
      upstream: 'openai',
      option: 'default',
      apiKey: 'sk-1',
    });
    expect(connectParams({ kind: 'opencode' }, openai, key)).not.toHaveProperty('apiKey');
    expect(connectParams({ kind: 'opencode', id: 'opencode-ab12' }, openai, key)).toMatchObject({
      kind: 'opencode',
      id: 'opencode-ab12',
    });
  });
});

describe('loginPrompt', () => {
  const base = { loginId: 'l1', startedAt: '2026-10-18T00:00:00.000Z' };
  it('没有登录时是 undefined；设备码、浏览器授权、还没有网址三种', () => {
    expect(loginPrompt(undefined)).toBeUndefined();
    expect(
      loginPrompt({
        ...base,
        method: 'device_code',
        verificationUrl: 'https://x.test/device',
        userCode: 'AB-12',
      }),
    ).toEqual({ kind: 'device_code', url: 'https://x.test/device', code: 'AB-12' });
    expect(loginPrompt({ ...base, method: 'browser', authUrl: 'https://x.test/a' })).toEqual({
      kind: 'browser',
      url: 'https://x.test/a',
    });
    expect(loginPrompt({ ...base, method: 'browser' })).toEqual({ kind: 'waiting' });
  });
});

describe('upstreamsStamp', () => {
  it('接上、断开或登录开始时变化', () => {
    const a = { kind: 'opencode', status: 'signed_in', plan: 'opencode' } as const;
    expect(upstreamsStamp(a)).not.toBe(upstreamsStamp({ ...a, plan: 'opencode,openai' }));
    expect(upstreamsStamp(a)).not.toBe(
      upstreamsStamp({
        ...a,
        login: { loginId: 'l1', method: 'browser', startedAt: '2026-10-18T00:00:00.000Z' },
      }),
    );
    expect(upstreamsStamp(a)).toBe(upstreamsStamp({ ...a }));
  });
});
