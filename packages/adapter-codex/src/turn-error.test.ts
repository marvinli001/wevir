import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TurnError } from './protocol.js';
import { classifyTurnError } from './turn-error.js';

// 回合失败的归类（turn-error.ts，codex-event-mapping.md §6.7）。样本由 record-app-server.test.ts 用真实
// codex-app-server + 网关 + mock 上游录制（test-fixtures/app-server/errors/turn-*.json）；Codex 改了 codexErrorInfo
// 或措辞时先重录，这里先失败。

function sample(name: string): TurnError {
  const file = join(import.meta.dirname, 'test-fixtures', 'app-server', 'errors', `${name}.json`);
  const { params } = JSON.parse(readFileSync(file, 'utf8')) as {
    params: { turn: { status: string; error: TurnError } };
  };
  expect(params.turn.status).toBe('failed');
  return params.turn.error;
}

describe('classifyTurnError', () => {
  it('Vertex 缺少服务账号 JSON 归 missing_credentials，交换失败仍归 provider', () => {
    expect(
      classifyTurnError({
        ...sample('turn-missing-key'),
        message: 'wevir gateway: Provider vertex 没有服务账号 JSON',
      }),
    ).toMatchObject({ category: 'missing_credentials', httpStatus: 401 });
    expect(
      classifyTurnError({
        ...sample('turn-401'),
        message: 'wevir gateway: Google Cloud 服务账号认证失败',
      }),
    ).toMatchObject({ category: 'provider' });
  });
  it.each([
    ['turn-missing-key', 'missing_credentials', 401],
    ['turn-401', 'provider', 401],
    ['turn-429', 'provider', 429],
    ['turn-unreachable', 'provider', 502],
    ['turn-500', 'provider', undefined],
    ['turn-400', 'provider', undefined],
  ] as const)('%s → %s', (name, category, httpStatus) => {
    expect(classifyTurnError(sample(name))).toEqual({
      category,
      ...(httpStatus !== undefined && { httpStatus }),
    });
  });

  it('other 而原文不是上游的错误体、Codex 自己的错误、没有 error：unknown', () => {
    const base = { additionalDetails: null };
    expect(classifyTurnError({ ...base, message: 'boom', codexErrorInfo: 'other' })).toEqual({
      category: 'unknown',
    });
    expect(classifyTurnError({ ...base, message: 'x', codexErrorInfo: 'sandboxError' })).toEqual({
      category: 'unknown',
    });
    expect(classifyTurnError({ ...base, message: 'x', codexErrorInfo: { future: {} } })).toEqual({
      category: 'unknown',
    });
    expect(classifyTurnError(null)).toEqual({ category: 'unknown' });
  });

  it('上游报的几类（字符串形式）与不带状态码的连接失败：provider', () => {
    const base = { message: 'x', additionalDetails: null };
    for (const info of ['contextWindowExceeded', 'usageLimitExceeded', 'serverOverloaded']) {
      expect(classifyTurnError({ ...base, codexErrorInfo: info })).toEqual({
        category: 'provider',
      });
    }
    expect(
      classifyTurnError({
        ...base,
        codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
      }),
    ).toEqual({ category: 'provider' });
  });
});
