// R11：回合进行中发消息，Host + 真实 codex-app-server + mock 模型（runHostCli 在进程内运行，同 cli.codex.integration.test.ts）。
// 一个慢回合（mock 的“慢”关键词，约 1.5 秒）里先插话、再排队：插话等这次回答流完再进同一个回合（user.steered，
// instant_interrupt 关掉，codex-event-mapping.md §4.5），模型接着回答它；排队的在回合结束后作为下一个回合发出。
// 没有 codex-app-server 时跳过并打印下载命令。

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCodexBinary } from '@wevir/adapter-codex';
import { MOCK_MODEL, startMockModel } from '@wevir/adapter-codex/testing';
import type { SessionId, WevirEvent } from '@wevir/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { runHostCli } from './cli.js';
import type { HostRuntimeInfo } from './runtime-file.js';
import { fakeProcess, TestRpcClient, useTempDir, waitReady } from './test-utils.js';

const tempDir = useTempDir();
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function binaryAvailable(): boolean {
  try {
    resolveCodexBinary();
    return true;
  } catch (error) {
    console.warn(`[wevir-host 插话与排队] 跳过：${(error as Error).message}`);
    return false;
  }
}

describe.skipIf(!binaryAvailable())(
  'wevir-host：回合进行中插话与排队（真实 codex-app-server）',
  () => {
    it('慢回合里插话一次、排队一次', async () => {
      const model = await startMockModel();
      cleanups.push(() => model.close());
      const home = join(tempDir(), 'home');
      const workspace = join(tempDir(), 'workspace');
      mkdirSync(workspace);
      const fake = fakeProcess(['--home', home, '--adapter', 'codex']);
      const exit = runHostCli(fake.proc);
      cleanups.push(async () => {
        fake.emit('SIGTERM', 'SIGTERM');
        await exit;
      });
      const ready = await waitReady(fake.out);
      const info = JSON.parse(
        readFileSync(join(home, 'run', 'host.json'), 'utf8'),
      ) as HostRuntimeInfo;
      const client = await TestRpcClient.connect(ready.url);
      cleanups.push(() => client.ws.close());
      const hello = await client.hello(info.token as string);
      expect(hello.result.features).toMatchObject({ pending_messages: true, host_settings: true });

      const { workspace: ws } = await client.request('workspace.add', { rootPath: workspace });
      await client.request('provider.upsert', {
        id: 'wevir-mock',
        kind: 'openai-compatible',
        displayName: 'Wevir Mock',
        api: 'openai-responses',
        baseURL: model.baseURL,
        models: [{ id: MOCK_MODEL, contextWindow: 128_000 }],
        defaultModelId: MOCK_MODEL,
        apiKey: 'wevir-mock-key-not-a-secret',
      });
      const { session } = await client.request('session.create', {
        workspaceId: ws.id,
        providerId: 'wevir-mock',
      });
      const sessionId = session.id as SessionId;
      const { subscriptionId } = await client.request('events.subscribe', {
        sessionId,
        sinceSeq: 0,
      });
      const events = (): WevirEvent[] => client.events(subscriptionId);
      const text = (value: string) => [{ type: 'text', text: value }];

      const slow = await client.request('session.send', { sessionId, content: text('请慢慢回答') });
      // 看到这次回答已经在流出，再插话与排队。
      await client.until(
        () => events().find((e) => e.type === 'assistant.delta'),
        '慢回答开始流出',
        30_000,
      );
      const steer = await client.request('session.send', {
        sessionId,
        content: text('打个招呼'),
        delivery: 'steer',
      });
      const queued = await client.request('session.send', {
        sessionId,
        content: text('列一下工作区的文件（调用工具）'),
        delivery: 'queue',
      });
      expect(steer.pendingId).toMatch(/^pnd_/);
      expect(queued.pendingId).toMatch(/^pnd_/);

      await client.until(
        () => events().filter((e) => e.type === 'turn.finished').length === 2 || undefined,
        '慢回合与排队的回合都结束',
        60_000,
      );
      const all = events();
      const inTurn = (turnId: string) =>
        all.filter((e) => (e.payload as { turnId?: string }).turnId === turnId);

      // 插话：慢回答完整地流完，之后插话进了同一个回合，模型接着回答它。
      const story = inTurn(slow.turnId).flatMap((e) =>
        e.type === 'assistant.message'
          ? [e.payload.text.startsWith('慢慢说') ? 'slow' : e.payload.text]
          : e.type === 'user.steered'
            ? ['steer']
            : [],
      );
      expect(story).toEqual(['slow', 'steer', '你好！我是 Wevir 的 mock 模型。']);
      const slowAnswer = inTurn(slow.turnId).find((e) => e.type === 'assistant.message');
      expect(slowAnswer?.type === 'assistant.message' && slowAnswer.payload.text).toContain(
        '慢慢说第 10 句。',
      );
      expect(inTurn(slow.turnId).find((e) => e.type === 'turn.finished')?.payload).toMatchObject({
        outcome: 'completed',
      });

      // 排队：回合结束后作为下一个回合发出，带 pendingId，跑了一次工具。
      const next = all.filter((e) => e.type === 'user.message').at(-1);
      expect(next?.payload).toMatchObject({
        pendingId: queued.pendingId,
        content: text('列一下工作区的文件（调用工具）'),
      });
      if (next?.type !== 'user.message') throw new Error('没有排队发出的回合');
      const nextTurn = next.payload.turnId;
      expect(inTurn(nextTurn).some((e) => e.type === 'tool.started')).toBe(true);
      expect(
        all
          .filter((e) => e.type === 'pending.updated')
          .map((e) => e.type === 'pending.updated' && e.payload.pending.status),
      ).toEqual(['inserted', 'sent']);
      const snapshot = await client.request('session.get', { sessionId });
      expect(snapshot.pendingMessages).toBeUndefined();
      expect(snapshot.session.state).toBe('idle');
    }, 120_000);
  },
);
