// 步骤 4/5：ACP 全流程。
// initialize → session/new → 读写文件 → 权限 allow / deny / 审批中取消 → 长任务 cancel
// → 流式粒度 → session/close → session/list → session/resume（同进程、跨进程）→ 追问确认上下文。

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  methods,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import {
  type AcpRun,
  allowAll,
  errorInfo,
  initialize,
  type PromptOutcome,
  prompt,
  rejectAll,
  saveFixture,
  saveTranscript,
  startAcp,
  summarizeUpdates,
} from '../acp.ts';
import { makeOutsideDir, makeWorkspace, target } from '../env.ts';
import { activeMock, textOf } from '../mock-llm.ts';
import { writeProviderOverlay } from '../overlays.ts';
import { expect, record } from '../report.ts';
import { CSV, prompts } from '../scenarios.ts';

const STEP = 'acp-flow';

/** 每种 update 保留首个样本；tool_call_update 按状态区分。 */
const samples = new Map<string, SessionNotification>();
function collectSamples(outcome: PromptOutcome): void {
  for (const { n } of outcome.updates) {
    const u = n.update;
    const key =
      u.sessionUpdate === 'tool_call_update'
        ? `tool_call_update.${u.status ?? 'none'}`
        : u.sessionUpdate;
    if (!samples.has(key)) samples.set(key, n);
  }
}

function brief(outcome: PromptOutcome) {
  const { counts, assistantText } = summarizeUpdates(outcome.updates);
  return {
    stopReason: outcome.response?.stopReason,
    error: errorInfo(outcome.error),
    durationMs: outcome.settledAt - outcome.sentAt,
    firstUpdateAfterMs:
      outcome.firstUpdateAt === undefined ? undefined : outcome.firstUpdateAt - outcome.sentAt,
    updateCounts: counts,
    permissions: outcome.permissions.length,
    assistantText: assistantText.slice(0, 400),
  };
}

/** 工具调用的最终状态（按 toolCallId 合并 tool_call 与后续 tool_call_update）。 */
function toolLifecycles(outcome: PromptOutcome) {
  const calls = new Map<string, Array<SessionNotification['update']>>();
  for (const { n } of outcome.updates) {
    const u = n.update;
    if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
      calls.set(u.toolCallId, [...(calls.get(u.toolCallId) ?? []), u]);
    }
  }
  return [...calls.entries()].map(([toolCallId, updates]) => ({ toolCallId, updates }));
}

export async function acpFlow(): Promise<void> {
  const t = target();
  console.log(`\n▶ ACP 全流程（${t.kind}）`);
  const dir = (name: string) => `acp/${t.kind}/${name}`;
  const mock = activeMock();
  const overlay = writeProviderOverlay();
  const ws = makeWorkspace('flow');
  const outside = makeOutsideDir('flow');
  const codeword = `wevir-${randomBytes(3).toString('hex')}`;
  writeFileSync(join(ws, 'input.csv'), CSV);

  let run: AcpRun = startAcp({ label: 'flow', overlays: [overlay] });
  const scenario = async (name: string, text: string, opts: Parameters<typeof prompt>[3] = {}) => {
    const outcome = await prompt(run, sessionId, text, opts);
    collectSamples(outcome);
    saveFixture(`${dir('scenarios')}/${name}.json`, {
      prompt: text,
      ...brief(outcome),
      cancelSentAfterMs:
        outcome.cancelSentAt === undefined ? undefined : outcome.cancelSentAt - outcome.sentAt,
      updates: outcome.updates.map((u) => ({ dt: u.t - outcome.sentAt, ...u.n })),
      permissions: outcome.permissions,
    });
    saveTranscript(`${dir('transcripts')}/${name}.jsonl`, outcome.frames);
    record(STEP, `场景 ${name}`, 'observe', brief(outcome));
    return outcome;
  };
  await initialize(run);
  const { sessionId } = await run.agent.request(methods.agent.session.new, {
    cwd: ws,
    mcpServers: [],
  });

  // A：读取 + 写入工作区内文件（workspace-write 模式下预期不触发审批）
  run.policy = allowAll;
  const a = await scenario('A-read-write', prompts.readWrite(codeword));
  const summary = existsSync(join(ws, 'summary.md'))
    ? readFileSync(join(ws, 'summary.md'), 'utf8')
    : '';
  expect(STEP, 'A：summary.md 写入正确（total=15）', summary.includes('15'), summary.trim());
  expect(
    STEP,
    'A：工作区内写入不触发 request_permission',
    a.permissions.length === 0,
    a.permissions.length,
  );
  expect(
    STEP,
    'A：出现 tool_call 与 tool_call_update',
    a.updates.some((u) => u.n.update.sessionUpdate === 'tool_call') &&
      a.updates.some((u) => u.n.update.sessionUpdate === 'tool_call_update'),
  );

  // B0：工作区外、但在系统临时目录下的写入（workspace-write 把平台临时区也视为可写）
  run.policy = rejectAll;
  const tmpTarget = join(makeWorkspace('tmp-outside'), 'tmp.txt');
  const b0 = await scenario('B0-tmp-area-write', prompts.escalation(tmpTarget));
  expect(
    STEP,
    'B0：写系统临时目录不需要审批且直接成功',
    b0.permissions.length === 0 && existsSync(tmpTarget),
    {
      permissions: b0.permissions.length,
      written: existsSync(tmpTarget),
    },
  );

  // B：工作区外写入 → 沙箱拒绝 → 升级 → request_permission → allow
  run.policy = allowAll;
  const bTarget = join(outside, 'allowed.txt');
  const b = await scenario('B-permission-allow', prompts.escalation(bTarget));
  expect(STEP, 'B：触发 request_permission', b.permissions.length > 0, b.permissions.length);
  expect(STEP, 'B：allow 后文件写入', existsSync(bTarget));
  if (b.permissions[0] !== undefined) {
    saveFixture(`${dir('permission')}/request.json`, b.permissions[0].params);
  }
  saveFixture(`${dir('permission')}/after-allow.tool-lifecycle.json`, toolLifecycles(b));

  // C：同上 → reject
  run.policy = rejectAll;
  const cTarget = join(outside, 'denied.txt');
  const c = await scenario('C-permission-deny', prompts.escalation(cTarget));
  expect(STEP, 'C：触发 request_permission', c.permissions.length > 0, c.permissions.length);
  expect(STEP, 'C：reject 后文件未写入', !existsSync(cTarget));
  saveFixture(`${dir('permission')}/after-deny.tool-lifecycle.json`, toolLifecycles(c));

  // D：审批挂起时客户端发 session/cancel，并按协议以 cancelled 回复挂起的审批
  const dTarget = join(outside, 'cancelled.txt');
  run.policy = async (params) => {
    await run.agent.notify(methods.agent.session.cancel, { sessionId: params.sessionId });
    return { outcome: { outcome: 'cancelled' } } satisfies RequestPermissionResponse;
  };
  const d = await scenario('D-permission-cancel', prompts.escalation(dTarget));
  expect(
    STEP,
    'D：审批中取消 → stopReason cancelled',
    d.response?.stopReason === 'cancelled',
    d.response,
  );
  expect(STEP, 'D：文件未写入', !existsSync(dTarget));
  saveFixture(`${dir('permission')}/after-cancel.tool-lifecycle.json`, toolLifecycles(d));
  saveFixture(`${dir('permission')}/responses.json`, {
    allow: b.permissions[0]?.response,
    deny: c.permissions[0]?.response,
    cancelled: d.permissions[0]?.response,
  });
  run.policy = rejectAll;

  // E1：长工具调用中取消（bash sleep）：等 sleep 真正跑起来 1.5 秒后再取消
  const sleeping = () => spawnSync('pgrep', ['-f', 'sleep 45'], { encoding: 'utf8' }).stdout.trim();
  let runningBeforeCancel = '';
  const e1 = await scenario('E1-cancel-during-tool', prompts.longTool, {
    cancelWhen: (n) => n.update.sessionUpdate === 'tool_call',
    cancelDelayMs: 1500,
    beforeCancel: () => {
      runningBeforeCancel = sleeping();
    },
    cancelAfterMs: 60_000,
  });
  expect(STEP, 'E1：工具执行中取消 → cancelled', e1.response?.stopReason === 'cancelled', {
    stopReason: e1.response?.stopReason,
    settleAfterCancelMs: e1.cancelSentAt === undefined ? undefined : e1.settledAt - e1.cancelSentAt,
  });
  await new Promise((r) => setTimeout(r, 500));
  expect(STEP, 'E1：取消前 sleep 45 确实在运行', runningBeforeCancel !== '');
  expect(STEP, 'E1：取消后 bash 子进程（sleep 45）已结束', sleeping() === '', sleeping());

  // E2：长文本生成中取消
  const r0 = mock?.requests.length ?? 0;
  const e2 = await scenario('E2-cancel-during-generation', prompts.longText, {
    cancelAfterMs: 4000,
  });
  expect(STEP, 'E2：生成中取消 → cancelled', e2.response?.stopReason === 'cancelled', {
    stopReason: e2.response?.stopReason,
    settleAfterCancelMs: e2.cancelSentAt === undefined ? undefined : e2.settledAt - e2.cancelSentAt,
    agentMessageChunks: e2.updates.filter((u) => u.n.update.sessionUpdate === 'agent_message_chunk')
      .length,
  });
  if (mock !== undefined) {
    expect(
      STEP,
      'E2：取消会中断发往 Provider 的流式请求',
      mock.requests.slice(r0).some((r) => r.aborted),
    );
  }

  // F：流式粒度（不取消的一段中等长度生成；mock 下分 30 片、每片间隔 100ms 发出）
  const f = await scenario('F-stream-granularity', prompts.stream);
  const chunks = f.updates.filter((u) => u.n.update.sessionUpdate === 'agent_message_chunk');
  const granularity = {
    agentMessageChunks: chunks.length,
    firstChunkAfterMs: chunks[0] === undefined ? undefined : chunks[0].t - f.sentAt,
    chunkSpanMs: chunks.length > 0 ? (chunks.at(-1)?.t ?? 0) - (chunks[0]?.t ?? 0) : 0,
    turnMs: f.settledAt - f.sentAt,
  };
  record(STEP, 'F：agent_message_chunk 的数量与时间跨度', 'observe', granularity);
  saveFixture(`${dir('scenarios')}/F-stream-granularity.summary.json`, granularity);

  // G：close → list → resume（同进程）→ 追问暗号
  await run.agent.request(methods.agent.session.close, { sessionId });
  const listed = await run.agent.request(methods.agent.session.list, { cwd: ws });
  expect(
    STEP,
    'G：close 后 session/list 可见',
    listed.sessions.some((s) => s.sessionId === sessionId),
  );
  const u0 = run.updates.length;
  await run.agent.request(methods.agent.session.resume, { sessionId, cwd: ws, mcpServers: [] });
  expect(STEP, 'G：resume 不回放历史 update', run.updates.length === u0, run.updates.length - u0);
  const g = await scenario('G-recall-same-process', prompts.recall);
  expect(
    STEP,
    'G：同进程 resume 后记得暗号',
    summarizeUpdates(g.updates).assistantText.includes(codeword),
    {
      expected: codeword,
    },
  );
  await run.close();
  saveTranscript(`${dir('transcripts')}/flow-process-1.jsonl`, run.frames);

  // H：新进程 → list → resume → 追问暗号与之前写入的文件
  run = startAcp({ label: 'flow-2', overlays: [overlay] });
  await initialize(run);
  const listed2 = await run.agent.request(methods.agent.session.list, {});
  expect(
    STEP,
    'H：新进程 session/list 可见旧会话',
    listed2.sessions.some((s) => s.sessionId === sessionId),
  );
  await run.agent.request(methods.agent.session.resume, { sessionId, cwd: ws, mcpServers: [] });
  const h0 = mock?.requests.length ?? 0;
  const h = await scenario('H-recall-new-process', prompts.recallAll);
  const hText = summarizeUpdates(h.updates).assistantText;
  expect(STEP, 'H：跨进程 resume 后记得暗号', hText.includes(codeword), { expected: codeword });
  expect(STEP, 'H：跨进程 resume 后记得 summary.md 内容', hText.includes('15'));
  const afterResume = mock?.requests[h0];
  if (afterResume !== undefined) {
    // resume 后第一个模型请求里到底带了什么：角色序列 + 每条的开头
    saveFixture(`${dir('scenarios')}/H-first-request-after-resume.json`, {
      messageCount: afterResume.body.messages.length,
      messages: afterResume.body.messages.map((m) => ({
        role: m.role,
        head: textOf(m.content).slice(0, 160),
        toolCalls: m.tool_calls?.map(
          (tc) => `${tc.function.name}(${tc.function.arguments.slice(0, 80)})`,
        ),
      })),
    });
  }
  await run.agent.request(methods.agent.session.close, { sessionId });
  await run.close();
  saveTranscript(`${dir('transcripts')}/flow-process-2.jsonl`, run.frames);

  for (const [kind, n] of samples) saveFixture(`${dir('updates')}/${kind}.json`, n);
  record(STEP, '出现过的 session/update 类型', 'observe', [...samples.keys()]);
}
