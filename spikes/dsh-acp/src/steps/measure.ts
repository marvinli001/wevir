// 步骤 7（不需要 Key 的部分）：冷启动耗时、单进程并发建 3 个会话、退出耗时。

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { methods } from '@agentclientprotocol/sdk';
import { initialize, saveFixture, startAcp } from '../acp.ts';
import { DSH_HOME, makeWorkspace } from '../env.ts';
import { expect, record } from '../report.ts';

const STEP = 'measure';
const SAMPLES = 5;

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    min: sorted[0],
    median:
      sorted.length % 2
        ? sorted[mid]
        : Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2),
    max: sorted.at(-1),
  };
}

export async function measure(): Promise<void> {
  console.log('\n▶ 测量：冷启动与单进程多会话（无需 Key）');
  const firstBoot = !existsSync(join(DSH_HOME, 'profiles/acp'));
  const samples: Array<{ initializeMs: number; sessionNewMs: number; exitMs: number }> = [];
  for (let i = 0; i < SAMPLES; i++) {
    const run = startAcp({ label: `cold-${i}` });
    await initialize(run);
    const initializeMs = run.now();
    const ws = makeWorkspace('cold');
    await run.agent.request(methods.agent.session.new, { cwd: ws, mcpServers: [] });
    const sessionNewMs = run.now() - initializeMs;
    const t = run.now();
    await run.close();
    samples.push({ initializeMs, sessionNewMs, exitMs: run.now() - t });
  }
  const coldStart = {
    note: 'spawn(node dsh --profile acp) 到 initialize 响应；本机为 macOS / Node 当前版本，未预热磁盘缓存以外的任何东西',
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    firstSampleIsFirstBoot: firstBoot,
    samples,
    initializeMs: stats(samples.map((s) => s.initializeMs)),
    sessionNewMs: stats(samples.map((s) => s.sessionNewMs)),
    exitAfterStdinEofMs: stats(samples.map((s) => s.exitMs)),
  };
  record(STEP, '冷启动到 initialize 完成（ms）', 'observe', coldStart.initializeMs);
  record(STEP, 'session/new 耗时（ms）', 'observe', coldStart.sessionNewMs);
  record(STEP, 'stdin EOF 到进程退出（ms）', 'observe', coldStart.exitAfterStdinEofMs);

  // 单进程同时建 3 个会话，各自不同 cwd
  const run = startAcp({ label: 'concurrent-new' });
  await initialize(run);
  const workspaces = [0, 1, 2].map((i) => makeWorkspace(`multi${i}`));
  const t0 = run.now();
  const created = await Promise.all(
    workspaces.map((cwd) => run.agent.request(methods.agent.session.new, { cwd, mcpServers: [] })),
  );
  const concurrentNewMs = run.now() - t0;
  const ids = new Set(created.map((c) => c.sessionId));
  expect(STEP, '单进程并发 session/new ×3 成功且 id 互不相同', ids.size === 3, {
    concurrentNewMs,
  });
  await Promise.all(
    created.map((c) => run.agent.request(methods.agent.session.close, { sessionId: c.sessionId })),
  );
  const listed = await run.agent.request(methods.agent.session.list, {});
  const listedIds = new Set(listed.sessions.map((s) => s.sessionId));
  expect(
    STEP,
    '关闭后 3 个会话都出现在 session/list',
    created.every((c) => listedIds.has(c.sessionId)),
  );
  await run.close();
  saveFixture('measure/cold-start.json', { ...coldStart, concurrentSessionNewMs: concurrentNewMs });
}
