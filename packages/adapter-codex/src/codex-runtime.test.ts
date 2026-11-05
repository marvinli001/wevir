import { describe, expect, it } from 'vitest';
import { CodexAdapter } from './codex-adapter.js';
import { CodexRuntime } from './codex-runtime.js';

// Host 拿到的是 CodexRuntime，不是 CodexAdapter：适配器上的方法没转发时，Host 当作引擎不支持（可选方法静默缺席）。
// 例：formatAsyncAnswer 没转发，Codex 不挂起回合的提问就答不了（question.respond 回 INTERNAL_ERROR）。

/** CodexAdapter 上只给 CodexRuntime 自己用的方法，以及 CodexRuntime 用实例字段表达的属性。 */
const NOT_FORWARDED = new Set([
  'hasSession',
  'gateway',
  'sessionCount',
  'historyTool',
  'googleVertex',
]);

describe('CodexRuntime', () => {
  it('转发 CodexAdapter 的每个方法', () => {
    const forwarded = new Set(Object.getOwnPropertyNames(CodexRuntime.prototype));
    const missing = Object.getOwnPropertyNames(CodexAdapter.prototype).filter(
      (name) => !forwarded.has(name) && !NOT_FORWARDED.has(name),
    );
    expect(missing).toEqual([]);
  });
});
