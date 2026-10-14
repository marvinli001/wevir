import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CodexRpcError } from './codex-process.js';
import { classifyResumeError } from './resume-error.js';

// thread/resume 失败的归类（resume-error.ts，codex-event-mapping.md §4.2）。样本由 record-app-server.test.ts 用真实
// codex-app-server 录制（test-fixtures/app-server/errors/resume-*.json）。

function sample(name: string): CodexRpcError {
  const file = join(import.meta.dirname, 'test-fixtures', 'app-server', 'errors', `${name}.json`);
  const { code, message } = JSON.parse(readFileSync(file, 'utf8')) as {
    code: number;
    message: string;
  };
  return new CodexRpcError('thread/resume', { code, message });
}

describe('classifyResumeError', () => {
  it.each([
    ['resume-not-found', 'not_found'],
    ['resume-invalid-id', 'not_found'],
    ['resume-corrupted', 'corrupted'],
  ] as const)('%s → lost（%s），原文原样保留', (name, reason) => {
    const error = sample(name);
    const classified = classifyResumeError(error);
    expect(classified.failure).toMatchObject({ kind: 'lost', reason });
    expect(classified.message).toBe(error.rpcMessage);
    expect(classified.code).toBe(error.code);
  });

  it('thread 正在卸载：closing（适配器稍后重试）', () => {
    const error = new CodexRpcError('thread/resume', {
      code: -32600,
      message:
        'thread 019a0000-0000-7000-8000-000000000000 is closing; retry thread/resume after the thread is closed',
    });
    expect(classifyResumeError(error).failure).toEqual({ kind: 'closing' });
  });

  it('app-server 拒绝的其他请求：rejected；内部错误与不是 JSON-RPC 的错误：unknown', () => {
    expect(
      classifyResumeError(
        new CodexRpcError('thread/resume', { code: -32600, message: 'session x is archived.' }),
      ).failure,
    ).toEqual({ kind: 'rejected' });
    expect(
      classifyResumeError(new CodexRpcError('thread/resume', { code: -32603, message: 'boom' }))
        .failure,
    ).toEqual({ kind: 'unknown' });
    expect(classifyResumeError(new Error('进程退出')).failure).toEqual({ kind: 'unknown' });
  });
});
