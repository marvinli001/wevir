// 运行体会话库里每次模型请求的 token：protobuf 的几个字段、水位与没结束的步骤、旧表结构。样本照本机 Antigravity IDE 会话库里
// 一个真实步骤的数字。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AntigravityStepUsage, type StepUsage, stepUsage } from './step-usage.js';
import { removeDir, tempDir } from './test-fixtures/runtime.js';
import {
  message,
  metadata,
  stepDatabase,
  usageMetadata as usage,
  type Value,
} from './test-fixtures/step-db.js';

const SAMPLE: Array<[number, Value]> = [
  [1, 1417],
  [2, 2933],
  [3, 204],
  [5, 19365],
  [6, 24],
  [7, 'msg-1'],
  [9, 28],
  [10, 176],
  [11, 'resp-1'],
];

describe('stepUsage', () => {
  it('输入不含缓存、输出含思考，requestId 是 response_id，时长与首字从步骤建立算起', () => {
    expect(stepUsage(metadata(SAMPLE), '3')).toEqual({
      requestId: 'resp-1',
      inputTokens: 2933,
      outputTokens: 204,
      cacheReadTokens: 19365,
      reasoningTokens: 28,
      durationMs: 11_165,
      firstTokenMs: 6_817,
    } satisfies StepUsage);
  });

  it('output_tokens 缺时按思考加正文；没有 response_id 时用 message_id，再没有用步骤号；没有时间就不报时长', () => {
    expect(
      stepUsage(
        metadata(
          [
            [2, 10],
            [4, 5],
            [9, 3],
            [10, 4],
            [7, 'msg-2'],
          ],
          false,
        ),
        '7',
      ),
    ).toEqual({
      requestId: 'msg-2',
      inputTokens: 10,
      outputTokens: 7,
      cacheWriteTokens: 5,
      reasoningTokens: 3,
    });
    expect(stepUsage(metadata([[2, 1]], false), '7')).toMatchObject({ requestId: 'step-7' });
  });

  it('没有 model_usage、全是 0 或坏数据时不报', () => {
    expect(stepUsage(message([[3, 4]]), '0')).toBeUndefined();
    expect(stepUsage(metadata([[1, 1417]]), '0')).toBeUndefined();
    expect(stepUsage(Uint8Array.from([0xff, 0xff]), '0')).toBeUndefined();
    expect(stepUsage(Uint8Array.from([0x4a, 0x05, 0x10]), '0')).toBeUndefined();
  });
});

describe('AntigravityStepUsage', () => {
  let profile: string;
  const SESSION = '9b0c7a5e-2f4d-4c1a-9e3b-6d8f0a1b2c3d';

  beforeEach(() => {
    profile = tempDir();
  });

  afterEach(() => {
    removeDir(profile);
  });

  const database = (columns: 'metadata' | 'payload' = 'metadata') =>
    stepDatabase(profile, SESSION, columns);

  it('库还不在：什么都不报；之后从第一步读起', () => {
    const reader = new AntigravityStepUsage(profile, SESSION);
    reader.start();
    expect(reader.read()).toEqual({ usage: [], pending: false });
    const db = database();
    db.add(0, 3);
    db.add(1, 3, usage('a', 100));
    db.close();
    expect(reader.read().usage.map((u) => u.requestId)).toEqual(['a']);
    expect(reader.read().usage).toEqual([]);
  });

  it('start 之前已有的步骤不报（恢复、分支）；没结束的步骤停住水位，结束后再报，不重复', () => {
    const db = database();
    db.add(0, 3, usage('old', 50));
    const reader = new AntigravityStepUsage(profile, SESSION);
    reader.start();
    db.add(1, 3);
    db.add(2, 8, usage('partial', 10));
    db.add(3, 3, usage('b', 30));
    expect(reader.read()).toMatchObject({ usage: [{ requestId: 'b' }], pending: true });
    db.update(2, 3, usage('c', 20));
    expect(reader.read()).toMatchObject({
      usage: [{ requestId: 'c', inputTokens: 20 }],
      pending: false,
    });
    expect(reader.read().usage).toEqual([]);
    db.close();
  });

  it('没有 metadata 列的旧表：从整个步骤的第 5 个字段取', () => {
    const db = database('payload');
    db.add(0, 3, usage('p', 7));
    db.close();
    const reader = new AntigravityStepUsage(profile, SESSION);
    expect(reader.read().usage).toMatchObject([{ requestId: 'p', inputTokens: 7 }]);
  });
});
