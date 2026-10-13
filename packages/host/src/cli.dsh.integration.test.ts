// T3.6：wevir-host --adapter dsh 接通。runHostCli 在进程内运行（信号与 stdout 是假的），适配器由默认的
// createAdapter 建：真实 DshAdapter，增量旁路开启，告警写 Host 的日志。Provider 是 @wevir/adapter-dsh/testing 的
// 本地 mock，经 provider.upsert 登记，不需要 Key。客户端只走 Host API：建会话 → 发消息 → 收到增量与助手消息 →
// SIGTERM 优雅退出，dsh 随适配器回收。子进程形式的 wevir-host --adapter dsh 见 scripts/gate-m2.ts 的 B1。

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DSH_VERSION, type DshAdapter } from '@wevir/adapter-dsh';
import { MOCK_MODEL, startMockModel } from '@wevir/adapter-dsh/testing';
import type { SessionId, WevirEvent } from '@wevir/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createAdapter, EXIT_CODE, runHostCli } from './cli.js';
import { LOG_FILE } from './logger.js';
import type { HostRuntimeInfo } from './runtime-file.js';
import { fakeProcess, TestRpcClient, useTempDir, waitReady } from './test-utils.js';

const tempDir = useTempDir();
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('wevir-host --adapter dsh（runHostCli + 真实 dsh + mock Provider）', () => {
  it('建会话、流式回答、SIGTERM 优雅退出并回收 dsh', async () => {
    const text = ['你好，', '这里是', ' wevir-host', ' 上的 dsh。'];
    const model = await startMockModel(() => ({ text, delayMs: 30 }));
    cleanups.push(() => model.close());
    const home = join(tempDir(), 'home');
    const workspace = join(tempDir(), 'workspace');
    mkdirSync(workspace);

    let adapter: DshAdapter | undefined;
    const fake = fakeProcess(['--home', home, '--adapter', 'dsh']);
    const exit = runHostCli(fake.proc, {
      // 照常用默认的工厂，只是留下实例，最后确认 dsh 已回收。
      createAdapter: (kind, context) => {
        adapter = createAdapter(kind, context) as DshAdapter;
        return adapter;
      },
    });
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
    expect((await client.hello(info.token as string)).error).toBeUndefined();

    const { workspace: ws } = await client.request('workspace.add', { rootPath: workspace });
    await client.request('provider.upsert', {
      id: 'wevir-test',
      kind: 'openai-compatible',
      displayName: 'Wevir Test',
      api: 'openai-completions',
      baseURL: model.baseURL,
      models: [{ id: MOCK_MODEL }],
      defaultModelId: MOCK_MODEL,
      apiKey: 'wevir-mock-key-not-a-secret',
    });
    const { session } = await client.request('session.create', {
      workspaceId: ws.id,
      providerId: 'wevir-test',
    });
    const sessionId = session.id as SessionId;
    const { subscriptionId } = await client.request('events.subscribe', {
      sessionId,
      sinceSeq: 0,
    });
    const { turnId } = await client.request('session.send', {
      sessionId,
      content: [{ type: 'text', text: '打个招呼' }],
    });
    await client.until(
      () =>
        client
          .events(subscriptionId)
          .find((e) => e.type === 'turn.finished' && e.payload.turnId === turnId),
      'turn.finished',
      30_000,
    );

    const events: WevirEvent[] = client.events(subscriptionId);
    expect(events[0]).toMatchObject({
      type: 'session.created',
      payload: { engineVersion: DSH_VERSION },
    });
    // 增量经 stream-tap 旁路先到，已提交的消息随后替换它们。
    const firstDelta = events.findIndex((e) => e.type === 'assistant.delta');
    const message = events.findIndex((e) => e.type === 'assistant.message');
    expect(firstDelta).toBeGreaterThan(-1);
    expect(firstDelta).toBeLessThan(message);
    expect(events[message]).toMatchObject({ payload: { text: text.join('') } });
    expect(events.find((e) => e.type === 'turn.finished')?.payload).toMatchObject({
      outcome: 'completed',
    });
    expect(adapter?.process.streamTapState).toBe('active');

    stopped = true;
    fake.emit('SIGTERM', 'SIGTERM');
    expect(await exit).toBe(EXIT_CODE.ok);
    expect(adapter?.process.state).toBe('disposed');
    expect(adapter?.process.pid).toBeUndefined();
    expect(existsSync(join(home, 'run', 'host.json'))).toBe(false);
    const log = readFileSync(join(home, 'logs', LOG_FILE), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(log.find((l) => l.msg === 'starting')).toMatchObject({ adapter: 'dsh' });
    expect(log.filter((l) => l.level === 'error' || l.level === 'warn')).toEqual([]);
  }, 60_000);
});
