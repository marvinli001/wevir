// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-cursor/src/server/transportFailure.test.ts、CursorSdk.test.ts（用例）
// 来源提交 ec1313c8f8333292506f05a355bb72d308a455d8
// Copyright (c) 2026 T3 Tools Inc.
// 修改：用例改写成 Vitest，补上 isCursorShellSpawnFailure 的用例；isCursorClosedStreamWrite 的用例跟进 T3 f54dfc0991，isUsageLimitError 的用例跟进 T3 8298664e9e。

import { describe, expect, it } from 'vitest';
import {
  isCursorClosedStreamWrite,
  isCursorShellSpawnFailure,
  isUsageLimitError,
} from './errors.js';
import { CursorTransportFailure } from './transport-failure.js';

function failureOf(...chunks: string[]): string | undefined {
  const reply = new CursorTransportFailure();
  for (const chunk of chunks) reply.push(chunk);
  return reply.failure;
}

describe('CursorTransportFailure', () => {
  it('整段回答只是传输诊断（可以带堆栈）时认出它', () => {
    expect(failureOf('Error: ConnectError: [unavailable] no healthy upstream')).toBe(
      'Error: ConnectError: [unavailable] no healthy upstream',
    );
    expect(failureOf('Error: RetriableError: stream closed\n', '    at foo (bar.js:1:1)\n')).toBe(
      'Error: RetriableError: stream closed',
    );
    expect(failureOf('Something went wrong communicating with the server. Please try again.')).toBe(
      'Something went wrong communicating with the server. Please try again.',
    );
  });

  it('引用了诊断的正常回答、[internal] 的 RetriableError、超长的行都不算', () => {
    expect(
      failureOf('The log shows:\n', 'Error: ConnectError: [unavailable] no healthy upstream'),
    ).toBeUndefined();
    expect(failureOf('Error: RetriableError: [internal] tool loop failed')).toBeUndefined();
    expect(failureOf('x'.repeat(5000))).toBeUndefined();
    expect(failureOf('')).toBeUndefined();
  });
});

describe('isCursorShellSpawnFailure', () => {
  it('只认 Cursor 沙箱包装的 shell 起不来', () => {
    const failure = {
      syscall: 'spawn /bin/zsh',
      code: 'ENOENT',
      spawnargs: ['-c', 'dump_zsh_state'],
    };
    expect(isCursorShellSpawnFailure(failure)).toBe(true);
    expect(isCursorShellSpawnFailure({ ...failure, spawnargs: ['-c', 'git status'] })).toBe(false);
    expect(isCursorShellSpawnFailure({ ...failure, syscall: 'open' })).toBe(false);
    expect(isCursorShellSpawnFailure(new Error('boom'))).toBe(false);
    expect(isCursorShellSpawnFailure(undefined)).toBe(false);
  });
});

describe('isCursorClosedStreamWrite', () => {
  it('按 name 认出 SDK 往已关闭的流写入（类名被压缩，不看构造函数）', () => {
    // 形状照 SDK 压缩后的类：构造函数不叫这个名字。
    class o extends Error {
      override name = 'WriteIterableClosedError';
    }
    expect(isCursorClosedStreamWrite(new o('WritableIterable is closed'))).toBe(true);
    expect(isCursorClosedStreamWrite(new Error('WritableIterable is closed'))).toBe(false);
    expect(isCursorClosedStreamWrite({ name: 'WriteIterableClosedError' })).toBe(false);
    expect(isCursorClosedStreamWrite(undefined)).toBe(false);
  });
});

describe('isUsageLimitError', () => {
  it('RateLimitError、HTTP 429 与用量上限一类的错误码算；别的错误码与普通错误不算', () => {
    expect(
      isUsageLimitError({ message: "You've hit your usage limit", code: 'PRO_USER_USAGE_LIMIT' }),
    ).toBe(true);
    expect(isUsageLimitError({ message: 'Too many requests', code: 'RATE_LIMITED' })).toBe(true);
    expect(isUsageLimitError({ message: 'x', code: 'resource_exhausted' })).toBe(true);
    expect(isUsageLimitError({ message: 'x', code: 'team_rate_limit_exceeded' })).toBe(true);
    expect(
      isUsageLimitError(Object.assign(new Error('slow down'), { name: 'RateLimitError' })),
    ).toBe(true);
    expect(isUsageLimitError(Object.assign(new Error('Too many requests'), { status: 429 }))).toBe(
      true,
    );
    expect(isUsageLimitError({ message: 'Unauthenticated', code: 'unauthenticated' })).toBe(false);
    expect(isUsageLimitError({ message: 'x', code: 'usage_limit_note' })).toBe(false);
    expect(isUsageLimitError(new Error('model overloaded'))).toBe(false);
    expect(isUsageLimitError(undefined)).toBe(false);
  });
});
