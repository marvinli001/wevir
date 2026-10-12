// 步骤 6：SDK 对照。用 @deepseek-ai/dsh-sdk-client 的 HarnessClient（dsh --profile sdk）跑同样的提示，
// 再在 ACP 上跑同一个 todo + subagent 提示，记录两边事件粒度的差异。

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { methods } from '@agentclientprotocol/sdk';
import { HarnessClient, type HarnessNotification } from '@deepseek-ai/dsh-sdk-client';
import {
  errorInfo,
  initialize,
  prompt,
  saveFixture,
  saveTranscript,
  startAcp,
  summarizeUpdates,
} from '../acp.ts';
import {
  childEnv,
  DSH_BIN,
  DSH_HOME,
  ensureDir,
  makeOutsideDir,
  makeWorkspace,
  target,
} from '../env.ts';
import { writeProviderOverlay } from '../overlays.ts';
import { expect, record } from '../report.ts';
import { CSV, prompts } from '../scenarios.ts';

const STEP = 'sdk-compare';

interface Timed {
  t: number;
  n: HarnessNotification;
}

function eventType(n: HarnessNotification): string {
  if (n.method === 'session.event') {
    const event = n.params.event as { type?: string } | undefined;
    return `session.event:${event?.type ?? '?'}`;
  }
  return n.method;
}

function countTypes(items: Timed[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { n } of items) counts[eventType(n)] = (counts[eventType(n)] ?? 0) + 1;
  return counts;
}

export async function sdkCompare(): Promise<void> {
  const t = target();
  console.log(`\n▶ SDK 对照（${t.kind}）`);
  const dir = `sdk/${t.kind}`;
  const ws = makeWorkspace('sdk');
  const outside = makeOutsideDir('sdk');
  writeFileSync(join(ws, 'input.csv'), CSV);

  const client = new HarnessClient({
    dshBin: DSH_BIN,
    profile: 'sdk',
    patches: [writeProviderOverlay(t, { acpRow: false })],
    dshHome: DSH_HOME,
    processCwd: ensureDir(DSH_HOME),
    env: childEnv(),
    initializeTimeoutMs: 60_000,
  });
  const t0 = performance.now();
  const now = () => Math.round(performance.now() - t0);
  const all: Timed[] = [];
  const subscription = client.subscribe();
  // close() 会让订阅以 TransportClosedError 结束，属于正常收尾
  const pump = (async () => {
    for await (const n of subscription) all.push({ t: now(), n });
  })().catch(() => undefined);
  client.start();
  const init = await client.initialize({ cwd: ws, provider: t.providerId, model: t.model });
  const initializeMs = now();
  saveFixture(`${dir}/initialize.result.json`, init);
  record(STEP, 'SDK 冷启动到 initialize（ms）', 'observe', initializeMs);

  const sessionId = randomUUID();
  const escalationTarget = join(outside, 'sdk.txt');
  const runs: Record<string, { items: Timed[]; ms: number; error?: unknown }> = {};
  for (const [name, text] of [
    ['readWrite', prompts.readWrite('wevir-000000')],
    ['escalation', prompts.escalation(escalationTarget)],
    ['todoSubagent', prompts.todoSubagent],
  ] as const) {
    const i0 = all.length;
    const sent = now();
    let error: unknown;
    try {
      await client.prompt(sessionId, [{ type: 'text', text }]);
      await client.request('session/wait', { sessionId });
    } catch (e) {
      error = errorInfo(e);
    }
    // 让 wait 之前已在路上的通知落地
    await new Promise((r) => setTimeout(r, 200));
    runs[name] = { items: all.slice(i0), ms: now() - sent, error };
    record(STEP, `SDK ${name}`, 'observe', {
      ms: runs[name].ms,
      types: countTypes(runs[name].items),
      error,
    });
  }
  expect(STEP, 'SDK：工作区外写入没有审批通道，文件未写入', !existsSync(escalationTarget));
  const escalationResults = (runs.escalation?.items ?? [])
    .map(({ n }) => n.params.event as { type?: string; data?: { message?: { content?: unknown } } })
    .filter((e) => e?.type === 'tool/result')
    .map((e) => e.data?.message?.content);
  saveFixture(`${dir}/escalation.tool-results.json`, escalationResults);

  const cancel = await client.request('session/cancel', { sessionId }).then(
    (ok) => ({ ok }),
    (e: unknown) => ({ error: errorInfo(e) }),
  );
  saveFixture(`${dir}/errors/session-cancel.json`, cancel);
  expect(STEP, 'SDK 协议没有 session/cancel', 'error' in cancel, cancel);

  // 每种通知 / 事件类型留一个样本
  const samples = new Map<string, HarnessNotification>();
  for (const { n } of all) if (!samples.has(eventType(n))) samples.set(eventType(n), n);
  for (const [type, n] of samples) {
    saveFixture(`${dir}/events/${type.replace(/[:/]/g, '_')}.json`, n);
  }
  saveTranscript(
    `${dir}/transcript.jsonl`,
    all.map(({ t, n }) => ({
      t,
      dir: 'a2c',
      msg: { jsonrpc: '2.0', method: n.method, params: n.params },
    })),
  );
  const sessions = new Set(
    all
      .map((x) => x.n.params.sessionId ?? x.n.params.childSessionId)
      .filter((x) => x !== undefined),
  );
  saveFixture(`${dir}/summary.json`, {
    initializeMs,
    sessionsSeen: sessions.size,
    runs: Object.fromEntries(
      Object.entries(runs).map(([k, v]) => [
        k,
        { ms: v.ms, error: v.error, types: countTypes(v.items) },
      ]),
    ),
  });
  record(STEP, 'SDK 看到的会话数（含子 agent）', 'observe', sessions.size);
  subscription.close();
  await client.close();
  await pump;

  // 同一个 todo + subagent 提示在 ACP 上的表现
  const acpWs = makeWorkspace('acp-todo');
  writeFileSync(join(acpWs, 'input.csv'), CSV);
  const run = startAcp({ label: 'acp-todo', overlays: [writeProviderOverlay()] });
  await initialize(run);
  const s = await run.agent.request(methods.agent.session.new, { cwd: acpWs, mcpServers: [] });
  const out = await prompt(run, s.sessionId, prompts.todoSubagent);
  const { counts } = summarizeUpdates(out.updates);
  const toolTitles = out.updates
    .map((u) => u.n.update)
    .filter((u) => u.sessionUpdate === 'tool_call')
    .map((u) => ('title' in u ? u.title : '?'));
  saveFixture(`acp/${t.kind}/scenarios/todo-subagent.json`, {
    prompt: prompts.todoSubagent,
    stopReason: out.response?.stopReason,
    updateCounts: counts,
    toolTitles,
    updates: out.updates.map((u) => ({ dt: u.t - out.sentAt, ...u.n })),
  });
  saveTranscript(`acp/${t.kind}/transcripts/todo-subagent.jsonl`, out.frames);
  record(STEP, 'ACP 上同一 todo+subagent 提示', 'observe', { counts, toolTitles });
  const rows = existsSync(join(acpWs, 'rows.txt'))
    ? readFileSync(join(acpWs, 'rows.txt'), 'utf8').trim()
    : '';
  expect(STEP, 'ACP：todo+subagent 任务完成（rows.txt = 3）', rows === '3', rows);
  const otherSessions = run.updates.filter((u) => u.n.sessionId !== s.sessionId).length;
  record(STEP, 'ACP 是否看到子 agent 会话的 update', 'observe', {
    otherSessionUpdates: otherSessions,
  });
  await run.close();
}
