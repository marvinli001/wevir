// session/resume 失败的归类（resume-error.ts）：真实 dsh 的样本逐个归到对应的类别。

import type { ResumeFailure } from '@wevir/adapter-acp';
import { describe, expect, it } from 'vitest';
import { classifyResumeError } from './resume-error.js';
import { readFixture } from './test-fixtures/acp-fixtures.js';

const fixture = (name: string) => readFixture<{ error: unknown }>(`errors/${name}`).error;

describe('classifyResumeError', () => {
  it.each<[string, ResumeFailure]>([
    ['resume-not-resumable.json', { kind: 'lost', reason: 'not_found' }],
    ['resume-format-newer.json', { kind: 'lost', reason: 'incompatible' }],
    ['resume-log-corrupt.json', { kind: 'lost', reason: 'corrupted' }],
    ['resume-cwd-mismatch.json', { kind: 'cwd_mismatch' }],
    ['resume-active-session.json', { kind: 'already_active' }],
    ['close-unknown-session.json', { kind: 'unknown' }],
  ])('%s', (name, failure) => {
    expect(classifyResumeError(fixture(name)).failure).toEqual(failure);
  });

  it('-32603 的原文在 data.details，接在 message 后面一字不改', () => {
    const error = fixture('resume-format-newer.json') as {
      message: string;
      code: number;
      data: { details: string };
    };
    expect(classifyResumeError(error)).toMatchObject({
      message: `Internal error: ${error.data.details}`,
      code: -32603,
    });
  });

  // 以下措辞取自上游 session-persistence 的源码，并用真实 dsh 构造过（T3.5）：更旧且没有升级路径的格式、
  // 文件名与日志头的格式版本不一致、日志头帧不止一行。
  it.each<[string, ResumeFailure]>([
    [
      'session "s-1" uses log format v3, older than the supported v4, and this build ships no upgrade path (raw log: /x)',
      { kind: 'lost', reason: 'incompatible' },
    ],
    [
      'session generation filename identifies v5, but its header identifies v4',
      { kind: 'lost', reason: 'corrupted' },
    ],
    [
      'corrupt Zstandard session log: header frame failed validation: Error: corrupt Zstandard session log: first frame is not exactly one header line (raw log: /x)',
      { kind: 'lost', reason: 'corrupted' },
    ],
    [
      'session "s-1": stored log has a malformed header (raw log: /x)',
      { kind: 'lost', reason: 'corrupted' },
    ],
    ['ENOENT: no such file or directory', { kind: 'unknown' }],
  ])('-32603 details：%s', (details, failure) => {
    const error = { code: -32603, message: 'Internal error', data: { details } };
    expect(classifyResumeError(error).failure).toEqual(failure);
  });

  it('同样的措辞换了错误码不算；不是 ACP 错误的一律 unknown', () => {
    expect(
      classifyResumeError({ code: -32603, message: 'Invalid params: session is not resumable: x' })
        .failure,
    ).toEqual({ kind: 'unknown' });
    expect(classifyResumeError(new Error('dsh 进程已退出'))).toEqual({
      failure: { kind: 'unknown' },
      message: 'dsh 进程已退出',
    });
  });
});
