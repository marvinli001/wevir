// R4：子会话端到端。runHostCli 在进程内运行，适配器是真实 CodexAdapter（codex-app-server + 模型网关），模型是
// @wevir/adapter-codex/testing 的 mock，脚本与 Spike 的 subagent 场景相同（spawn → wait）。客户端只走 Host API：
// - 父会话派出子会话：父会话的流里 subagent.started / subagent.updated，子会话自己的流，标题由会话的模型生成；
// - 子会话的审批：父会话的摘要带着它，用 approval.respond 回复；
// - 取消父会话：Codex 不动子 agent，Host 级联取消子会话（domain-model §4.5）。
// 没有 codex-app-server 时跳过并打印下载命令。

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCodexBinary } from '@wevir/adapter-codex';
import { MOCK_MODEL, startMockModel } from '@wevir/adapter-codex/testing';
import type { SessionId, SessionSnapshot, WevirEvent } from '@wevir/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { EXIT_CODE, runHostCli } from './cli.js';
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
    console.warn(`[wevir-host 子会话] 跳过：${(error as Error).message}`);
    return false;
  }
}

/**
 * 子 agent 审批用例写的目录：工作区外、且不在系统临时目录（workspace-write 对两者都不要审批），所以建在本包的
 * .test-outside/ 下（gitignore），用完删掉。
 */
function outsideDir(): string {
  const root = fileURLToPath(new URL('../.test-outside/', import.meta.url));
  mkdirSync(root, { recursive: true });
  const dir = realpathSync(mkdtempSync(join(root, 'subagent-')));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return dir;
}

describe.skipIf(!binaryAvailable())(
  'wevir-host 子会话（runHostCli + 真实 codex-app-server + mock 模型）',
  () => {
    it('派出子会话、子会话的审批经父会话处理、取消父会话时级联取消子会话', async () => {
      const outside = outsideDir();
      const previousOutside = process.env.WEVIR_MOCK_OUTSIDE_DIR;
      process.env.WEVIR_MOCK_OUTSIDE_DIR = outside;
      cleanups.push(() => {
        if (previousOutside === undefined) delete process.env.WEVIR_MOCK_OUTSIDE_DIR;
        else process.env.WEVIR_MOCK_OUTSIDE_DIR = previousOutside;
      });
      const model = await startMockModel();
      cleanups.push(() => model.close());
      const home = join(tempDir(), 'home');
      const workspace = join(tempDir(), 'workspace');
      mkdirSync(workspace);

      const fake = fakeProcess(['--home', home, '--adapter', 'codex']);
      const exit = runHostCli(fake.proc);
      let stopped = false;
      cleanups.push(async () => {
        if (!stopped) fake.emit('SIGTERM', 'SIGTERM');
        await exit;
      });
      const ready = await waitReady(fake.out);
      const info = JSON.parse(
        readFileSync(join(home, 'run', 'host.json'), 'utf8'),
      ) as HostRuntimeInfo;
      const client = await TestRpcClient.connect(ready.url);
      cleanups.push(() => client.ws.close());
      expect(
        (await client.hello(info.token as string, undefined, { title_source_generated: true }))
          .error,
      ).toBeUndefined();

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

      async function newParent() {
        const { session } = await client.request('session.create', {
          workspaceId: ws.id,
          providerId: 'wevir-mock',
        });
        const sessionId = session.id as SessionId;
        const { subscriptionId } = await client.request('events.subscribe', {
          sessionId,
          sinceSeq: 0,
        });
        return { sessionId, subscriptionId };
      }
      const get = (sessionId: SessionId): Promise<SessionSnapshot> =>
        client.request('session.get', { sessionId });
      /** 轮询到 `probe` 给出结果（可以是异步的）为止。 */
      async function until<T>(
        probe: () => T | undefined | Promise<T | undefined>,
        what: string | (() => string),
      ): Promise<T> {
        const deadline = Date.now() + 30_000;
        for (;;) {
          const found = await probe();
          if (found !== undefined) return found;
          if (Date.now() > deadline) {
            throw new Error(`等待超时：${typeof what === 'string' ? what : what()}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }

      // ── 1. 派出子会话（spawn → wait） ─────────────────────────────────────────────
      const first = await newParent();
      const { turnId } = await client.request('session.send', {
        sessionId: first.sessionId,
        content: [{ type: 'text', text: '派一个子智能体去做' }],
      });
      await until(
        () =>
          client
            .events(first.subscriptionId)
            .find((e) => e.type === 'turn.finished' && e.payload.turnId === turnId),
        '父回合结束',
      );
      const parentEvents: WevirEvent[] = client.events(first.subscriptionId);
      const started = parentEvents.find((e) => e.type === 'subagent.started');
      if (started?.type !== 'subagent.started') throw new Error('没有 subagent.started');
      const child = started.payload.subagent.sessionId;
      expect(started.payload.subagent).toMatchObject({
        parentTurnId: turnId,
        title: 'Helper task: 派一个子智能体去做',
        modelId: MOCK_MODEL,
        status: 'running',
      });
      // 子会话的标题由会话的模型生成（mock 回 JSON），父会话的摘要跟着变；昵称来自 thread/read。
      let lastSummary: unknown;
      const summary = await until(
        async () => {
          const [item] = (await get(first.sessionId)).subagents ?? [];
          lastSummary = item;
          return item?.status === 'completed' &&
            item.nickname !== undefined &&
            item.title.startsWith('Mock：')
            ? item
            : undefined;
        },
        () => `子会话完成、标题生成、昵称补上（最后看到的摘要：${JSON.stringify(lastSummary)}）`,
      );
      expect(summary).toMatchObject({ sessionId: child, pendingApprovals: [] });
      expect(
        (await client.request('session.list')).sessions.map((s: { id: string }) => s.id),
      ).toEqual([first.sessionId]);

      const childSnapshot = await get(child);
      expect(childSnapshot.session).toMatchObject({
        parentSessionId: first.sessionId,
        titleSource: 'generated',
        subagent: { status: 'completed', parentTurnId: turnId },
      });
      const childSub = await client.request('events.subscribe', { sessionId: child, sinceSeq: 0 });
      await until(
        () =>
          client.events(childSub.subscriptionId).at(-1)?.seq === childSnapshot.session.lastSeq
            ? true
            : undefined,
        '子会话的历史',
      );
      const childEvents = client.events(childSub.subscriptionId);
      expect(childEvents.find((e) => e.type === 'turn.started')?.payload).toMatchObject({
        input: [{ type: 'text', text: 'Helper task: 派一个子智能体去做\n做完说一声。' }],
      });
      expect(childEvents.find((e) => e.type === 'assistant.message')?.payload).toMatchObject({
        text: '子 agent 完成了。',
      });
      const send = await client.call('session.send', {
        sessionId: child,
        content: [{ type: 'text', text: 'hi' }],
      });
      expect(send.error).toMatchObject({ data: { parentSessionId: first.sessionId } });

      // ── 2. 子会话的审批：经父会话的摘要处理 ─────────────────────────────────────────
      const second = await newParent();
      await client.request('session.send', {
        sessionId: second.sessionId,
        content: [{ type: 'text', text: '派一个子智能体去工作区外创建 r4-child.txt' }],
      });
      const waiting = await until(async () => {
        const snapshot = await get(second.sessionId);
        return snapshot.subagents?.[0]?.pendingApprovals[0];
      }, '子会话的审批出现在父会话的摘要里');
      expect((await get(second.sessionId)).session.state).toBe('running');
      expect(waiting.sessionId).not.toBe(second.sessionId);
      await client.request('approval.respond', { approvalId: waiting.id, optionId: 'accept' });
      await until(async () => {
        const snapshot = await get(second.sessionId);
        return snapshot.session.state === 'idle' && snapshot.subagents?.[0]?.status === 'completed'
          ? snapshot
          : undefined;
      }, '父子都完成');
      expect(existsSync(join(outside, 'r4-child.txt'))).toBe(true);

      // ── 3. 取消父会话：级联取消子会话 ──────────────────────────────────────────────
      const third = await newParent();
      await client.request('session.send', {
        sessionId: third.sessionId,
        content: [{ type: 'text', text: '派一个子智能体，让它写一段长回答' }],
      });
      const runningChild = await until(async () => {
        const [item] = (await get(third.sessionId)).subagents ?? [];
        if (item === undefined) return undefined;
        const { session } = await get(item.sessionId);
        return session.state === 'running' && session.lastSeq > 4 ? item.sessionId : undefined;
      }, '子会话开始流式回答');
      await client.request('session.cancel', { sessionId: third.sessionId });
      const [parentAfter, childAfter] = await Promise.all([
        get(third.sessionId),
        get(runningChild),
      ]);
      expect(parentAfter.session.state).toBe('idle');
      expect(childAfter.session).toMatchObject({
        state: 'idle',
        subagent: { status: 'cancelled' },
      });
      expect(parentAfter.subagents?.[0]).toMatchObject({ status: 'cancelled' });

      stopped = true;
      fake.emit('SIGTERM', 'SIGTERM');
      expect(await exit).toBe(EXIT_CODE.ok);
    }, 90_000);
  },
);
