// 压缩上下文与代码审查（0.24.0，codex-event-mapping.md §4.9）：真实 codex-app-server + 网关 + mock 模型。

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderConfig } from '@wevir/runtime-adapter';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CodexAdapter } from './codex-adapter.js';
import {
  codexBinaryOrSkip,
  collectEvents,
  finishTurn,
  newAdapter,
  ofType,
  runTurn,
  TempDirs,
} from './test-fixtures/harness.js';
import {
  MOCK_MODEL,
  type MockModel,
  type MockScript,
  mockProvider,
  startMockModel,
} from './test-fixtures/mock-model.js';

const binary = codexBinaryOrSkip('adapter-codex 压缩与审查');
const dirs = new TempDirs();
let mock: MockModel;
let script: MockScript = () => ({ text: ['?'] });
const adapters: CodexAdapter[] = [];

/** Codex 本地压缩的提示词开头（core/templates/compact/prompt.md）。 */
const COMPACT_PROMPT = 'You are performing a CONTEXT CHECKPOINT COMPACTION';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'w',
      GIT_AUTHOR_EMAIL: 'w@example.com',
      GIT_COMMITTER_NAME: 'w',
      GIT_COMMITTER_EMAIL: 'w@example.com',
    },
  });
}

async function open(models?: ProviderConfig['models']) {
  const { home, workspace } = dirs.make('command');
  git(workspace, 'init', '-q', '-b', 'main');
  writeFileSync(join(workspace, 'a.txt'), 'a\n');
  git(workspace, 'add', '.');
  git(workspace, 'commit', '-q', '-m', 'init');
  const adapter = newAdapter({
    home,
    providers: [mockProvider(mock, models === undefined ? {} : { models })],
  });
  adapters.push(adapter);
  const { engineSessionId } = await adapter.createSession({
    cwd: workspace,
    providerId: 'mock',
    modelId: MOCK_MODEL,
  });
  return {
    adapter,
    id: engineSessionId,
    events: collectEvents(adapter, engineSessionId),
    workspace,
  };
}

const FINDINGS = JSON.stringify({
  findings: [
    {
      title: '[P1] 读了未初始化的变量',
      body: 'a.txt 的第一行。',
      confidence_score: 0.8,
      priority: 1,
      code_location: { absolute_file_path: '/tmp/a.txt', line_range: { start: 1, end: 1 } },
    },
  ],
  overall_correctness: 'patch is incorrect',
  overall_explanation: '有一个问题。',
  overall_confidence_score: 0.8,
});

describe.skipIf(binary === undefined)(
  'CodexAdapter 压缩与审查（真实 codex-app-server）',
  { timeout: 60_000 },
  () => {
    beforeAll(async () => {
      mock = await startMockModel((view) => script(view));
    });
    afterEach(async () => {
      script = () => ({ text: ['?'] });
      await Promise.allSettled(adapters.splice(0).map((adapter) => adapter.dispose()));
    });
    afterAll(async () => {
      await mock?.close();
      dirs.cleanup();
    });

    it('compact：thread/compact/start 开的回合里 contextCompaction → manual 的 compacting / compacted', async () => {
      const { adapter, id, events } = await open();
      script = (view) =>
        view.lastUserText.startsWith(COMPACT_PROMPT)
          ? { text: ['摘要：打过招呼。'] }
          : { text: ['你好'] };
      await runTurn(adapter, id, 'hello', events);
      const from = events.length;
      await adapter.compact(id);
      const turn = await finishTurn(events, from);
      const compacting = turn.find(ofType('context.compacting'));
      const compacted = turn.find(ofType('context.compacted'));
      expect(compacting).toMatchObject({ trigger: 'manual' });
      expect(compacted).toEqual({ ...compacting, type: 'context.compacted' });
      expect(turn.indexOf(compacting as never)).toBeLessThan(turn.indexOf(compacted as never));
      expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
      expect(turn.some((event) => event.type === 'assistant.message')).toBe(false);
      // 压缩请求是不带工具的一次摘要；之后的回合照常。
      const request = mock.requests.at(-1)?.body;
      expect(JSON.stringify(request?.input)).toContain(COMPACT_PROMPT);
      expect(request?.tools ?? []).toEqual([]);
      const next = await runTurn(adapter, id, 'again', events);
      expect(next.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
    });

    it('上下文快满时 Codex 在回合开始前自己压缩：auto', async () => {
      // 上下文 1100：mock 每次报 1020 个 token，第二个回合开始前就过了自动压缩的线。
      const { adapter, id, events } = await open([
        { id: MOCK_MODEL, displayName: 'Wevir Mock', contextWindow: 1100 },
      ]);
      script = () => ({ text: ['好'] });
      await runTurn(adapter, id, 'hello', events);
      const turn = await runTurn(adapter, id, 'hello again', events);
      const types = turn.map((event) => event.type);
      expect(turn.find(ofType('context.compacting'))).toMatchObject({ trigger: 'auto' });
      expect(turn.find(ofType('context.compacted'))).toMatchObject({ trigger: 'auto' });
      expect(types.indexOf('context.compacted')).toBeLessThan(types.indexOf('assistant.message'));
      expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
    });

    it('review：review/start（inline）；审查结果是助手消息，进入与退出审查不出事件', async () => {
      const { adapter, id, events, workspace } = await open();
      writeFileSync(join(workspace, 'a.txt'), 'b\n');
      script = (view) =>
        view.lastUserText.startsWith('Review the') ? { text: [FINDINGS] } : { text: ['?'] };
      let from = events.length;
      await adapter.review(id, { target: 'uncommitted' });
      let turn = await finishTurn(events, from);
      expect(mock.requests.at(-1)?.body.input.at(-1)).toMatchObject({ role: 'user' });
      expect(JSON.stringify(mock.requests.at(-1)?.body.input)).toContain(
        'Review the current code changes',
      );
      const answer = turn.find(ofType('assistant.message'));
      expect(answer?.text).toContain('读了未初始化的变量');
      expect(turn.filter((event) => event.type === 'engine.raw')).toEqual([]);
      expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });

      git(workspace, 'checkout', '-q', '-b', 'feature');
      from = events.length;
      await adapter.review(id, { target: 'branch', baseBranch: 'main' });
      turn = await finishTurn(events, from);
      expect(JSON.stringify(mock.requests.at(-1)?.body.input)).toContain('main');
      expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
    });

    it('compact 后马上取消：回合 ID 到了才发 turn/interrupt，回合以 cancelled 结束', async () => {
      const { adapter, id, events } = await open();
      script = (view) =>
        view.lastUserText.startsWith(COMPACT_PROMPT)
          ? { text: Array.from({ length: 40 }, () => '摘要'), delayMs: 100 }
          : { text: ['你好'] };
      await runTurn(adapter, id, 'hello', events);
      const from = events.length;
      await adapter.compact(id);
      await adapter.cancel(id);
      const turn = await finishTurn(events, from);
      expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'cancelled' });
      expect(turn.some((event) => event.type === 'context.compacted')).toBe(false);
    });
  },
);
