import { describe, expect, it } from 'vitest';
import { classifyTurnError } from './turn-error.js';

// 真实样本的归类见 acp-mapping.test.ts 的 errors 组；这里补规则表里没有样本的前缀与边界情况。

const turnFailed = (detail: string) => ({
  code: -32603,
  message: `Internal error: turn failed: ${detail}`,
});

describe('classifyTurnError', () => {
  it.each([
    ['401: {"message":"bad key"}', 'provider'],
    ['404 The model does not exist', 'provider'],
    ['Connection error.', 'provider'],
    ['Request timed out.', 'provider'],
    ['DeepSeek Messages request failed (502)', 'provider'],
    ['DeepSeek Messages returned no response body', 'provider'],
    ['llm-deepseek: no API key for provider route "deepseek-official"; …', 'missing_credentials'],
    ['llm-pi-ai: no credential for provider route "x"; …', 'missing_credentials'],
    ['Insufficient Balance', 'unknown'],
    ['tool registry is closed', 'unknown'],
  ])('turn failed: %s → %s', (detail, category) => {
    const error = turnFailed(detail);
    expect(classifyTurnError(error)).toEqual({ category, message: error.message, code: -32603 });
  });

  it('只有 turn failed 包装的才归类：其他 -32603 与其他错误码都是 unknown', () => {
    for (const error of [
      { code: -32603, message: 'Internal error: prompt was not queued: 401: x' },
      {
        code: -32603,
        message: 'Internal error: assistant output delivery failed: Connection error.',
      },
      { code: -32602, message: 'Invalid params: unknown session: s' },
    ]) {
      expect(classifyTurnError(error)).toEqual({ category: 'unknown', ...error });
    }
  });

  it('Error 实例（ACP SDK 的 RequestError）带上 code；没有 code 的错误只保留消息', () => {
    const message = 'Internal error: turn failed: Connection error.';
    const requestError = Object.assign(new Error(message), { code: -32603 });
    expect(classifyTurnError(requestError)).toEqual({
      category: 'provider',
      message: requestError.message,
      code: -32603,
    });
    expect(classifyTurnError(new Error('连接已关闭'))).toEqual({
      category: 'unknown',
      message: '连接已关闭',
    });
    expect(classifyTurnError('boom')).toEqual({ category: 'unknown', message: 'boom' });
  });
});
