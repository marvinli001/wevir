import { describe, expect, it } from 'vitest';
import { serviceName, testNotice } from './web-settings-model';

describe('联网搜索设置', () => {
  it('服务名：认得的翻译，不认得的按 ID', () => {
    expect(serviceName('bocha')).toBe('博查');
    expect(serviceName('tavily')).toBe('Tavily');
    expect(serviceName('brave')).toBe('brave');
  });

  it('测试结果：成功说用时，失败说原因并附原文', () => {
    expect(testNotice({ ok: true, service: 'bocha', latencyMs: 812, results: 1 })).toEqual({
      tone: 'success',
      text: '连接成功，用时 812 毫秒',
    });
    expect(
      testNotice({
        ok: false,
        service: 'tavily',
        reason: 'quota',
        httpStatus: 432,
        message: 'Plan limit',
      }),
    ).toEqual({ tone: 'error', text: '余额或额度不足：Plan limit' });
    expect(testNotice({ ok: false, service: 'bocha', reason: 'missing_key' })).toEqual({
      tone: 'error',
      text: '缺少凭据',
    });
  });
});
