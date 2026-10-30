// 诊断文本的遮盖（`redactDiagnostics`）：引擎的 stderr 与错误原文进事件库之前用。

import { describe, expect, it } from 'vitest';
import { looksLikeSecret, redactDiagnostics } from './secret-patterns.js';

describe('redactDiagnostics', () => {
  it('凭据类键名之后的值换掉，键名前可以有别的词（环境变量、下划线与连字符的组合）', () => {
    expect(redactDiagnostics('OPENAI_API_KEY=abc123 github_token: ghx-1 db-password=p')).toBe(
      'OPENAI_API_KEY=[REDACTED] github_token: [REDACTED] db-password=[REDACTED]',
    );
    expect(redactDiagnostics('x-api-key: k1, apiKey=k2; client_secret="a b c"')).toBe(
      'x-api-key: [REDACTED], apiKey=[REDACTED]; client_secret=[REDACTED]',
    );
    expect(redactDiagnostics('{"provider_api_key": "k3", "access_token":"k4"}')).toBe(
      '{"provider_api_key": "[REDACTED]", "access_token":"[REDACTED]"}',
    );
  });

  it('Bearer / Basic 的凭据不论长短都换掉，键名保留', () => {
    expect(redactDiagnostics('Authorization: Bearer short-tok')).toBe(
      'Authorization: Bearer [REDACTED]',
    );
    expect(redactDiagnostics('authorization=Basic dXNlcjpwYXNz')).toBe(
      'authorization=Basic [REDACTED]',
    );
  });

  it('令牌形状的（sk-，含下划线）照 redactSecrets 换掉；不相干的词不动', () => {
    expect(redactDiagnostics('key sk-proj_abcdefghijklmnop_qrstuvwxyz failed')).toBe(
      'key [REDACTED] failed',
    );
    expect(redactDiagnostics('max_tokens: 4096, token_count=12, tokenizer=o200k')).toBe(
      'max_tokens: 4096, token_count=12, tokenizer=o200k',
    );
  });

  it('只用于遮盖：检测（looksLikeSecret）不因键名而变', () => {
    expect(looksLikeSecret('password: hunter2')).toBe(false);
  });
});
