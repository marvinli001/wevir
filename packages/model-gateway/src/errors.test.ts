import { describe, expect, it } from 'vitest';
import { normalizeErrorBody } from './errors.js';

describe('normalizeErrorBody', () => {
  it('OpenAI 风格：保留 message、type、code（Codex 按 code 认出额度用完等）', () => {
    const body = JSON.stringify({
      error: {
        message: 'quota',
        type: 'insufficient_quota',
        code: 'insufficient_quota',
        param: null,
      },
    });
    expect(normalizeErrorBody(body, 429)).toEqual({
      error: { message: 'quota', type: 'insufficient_quota', code: 'insufficient_quota' },
    });
  });

  it('Anthropic 风格、{error: "…"}、{message}、{detail}', () => {
    expect(
      normalizeErrorBody(
        JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } }),
        529,
      ),
    ).toEqual({ error: { message: 'busy', type: 'overloaded_error' } });
    expect(normalizeErrorBody('{"error":"bad model"}', 400)).toEqual({
      error: { message: 'bad model' },
    });
    expect(normalizeErrorBody('{"message":"Model Not Exist"}', 400)).toEqual({
      error: { message: 'Model Not Exist' },
    });
    expect(normalizeErrorBody('{"detail":"Not Found"}', 404)).toEqual({
      error: { message: 'Not Found' },
    });
  });

  it('不是 JSON 用原文；空正文给状态码', () => {
    expect(normalizeErrorBody('<html>502 Bad Gateway</html>', 502)).toEqual({
      error: { message: '<html>502 Bad Gateway</html>' },
    });
    expect(normalizeErrorBody('', 503)).toEqual({ error: { message: '上游返回 HTTP 503' } });
  });

  it('原文里回显的 Key 换成 ***', () => {
    const key = 'sk-test-0123456789';
    expect(
      normalizeErrorBody(
        JSON.stringify({ error: { message: `Incorrect API key provided: ${key}` } }),
        401,
        key,
      ),
    ).toEqual({ error: { message: 'Incorrect API key provided: ***' } });
  });
});
