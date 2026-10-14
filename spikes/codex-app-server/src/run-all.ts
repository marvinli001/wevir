// spike 入口：同一组场景分别走直连（Codex → Responses mock）和网关（Codex → 网关 → Chat mock）。
//
// 用法：node src/run-all.ts [--only=stream,patch,...] [--transport=direct|gateway] [--trace] [--keep]
// 先 bash scripts/fetch-binary.sh 下载锁定版本的 codex-app-server。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerRequest } from './app-server.ts';
import { SPIKE_ROOT } from './codex-home.ts';
import { Harness, MOCK_UPSTREAM_KEY, PRODUCT_GATEWAY, type Transport } from './harness.ts';
import type { ChatRequest } from './mock-chat.ts';
import type { RecordedRequest } from './mock-responses.ts';
import type { ModelView, Reply } from './model-script.ts';

interface Check {
  ok: boolean;
  label: string;
  detail?: string;
}
interface Result {
  scenario: string;
  transport: Transport;
  checks: Check[];
  notes: string[];
  error?: string;
  ms: number;
}

const results: Result[] = [];
const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const only = arg('only')?.split(',');
const transports = (arg('transport')?.split(',') ?? [
  'direct',
  'gateway',
  'passthrough',
]) as Transport[];
const trace = process.argv.includes('--trace');

/** 审批用例的“工作区外”目标：Codex 的 workspace-write 把 $TMPDIR 与 /tmp 也列为可写，所以放在 spike 目录下（gitignore）。 */
const OUTSIDE = join(SPIKE_ROOT, '.run', 'outside');

type Body = (h: Harness, r: Result) => Promise<void>;
interface Scenario {
  name: string;
  run: (transport: Transport) => Promise<void>;
}
const scenarios: Scenario[] = [];

function scenario(
  name: string,
  setup: (transport: Transport) => Parameters<typeof Harness.start>[1],
  body: Body,
): void {
  scenarios.push({
    name,
    run: async (transport) => {
      const result: Result = { scenario: name, transport, checks: [], notes: [], ms: 0 };
      results.push(result);
      const started = performance.now();
      let h: Harness | undefined;
      try {
        h = await Harness.start(name, { ...setup(transport), trace });
        await body(h, result);
      } catch (error) {
        result.error = (error as Error).stack ?? String(error);
        if (h) result.notes.push(`stderr 末尾：${h.server.stderr.slice(-5).join(' | ')}`);
      } finally {
        await h?.dispose();
        result.ms = Math.round(performance.now() - started);
      }
    },
  });
}

const check = (r: Result, ok: boolean, label: string, detail?: unknown) =>
  r.checks.push({
    ok,
    label,
    detail:
      detail === undefined
        ? undefined
        : typeof detail === 'string'
          ? detail
          : JSON.stringify(detail),
  });

/** 按提示里的标记分派脚本。 */
const has = (v: ModelView, marker: string) => v.lastUserText.includes(marker);
const say = (...text: string[]): Reply => ({ text });
const last = (items: string[]): string => items.at(-1) ?? '';

// ---------------------------------------------------------------- 1. 流式与推理增量

scenario(
  'stream',
  (transport) => ({
    transport,
    extraTop: ['show_raw_agent_reasoning = true'],
    script: () => ({
      reasoning: ['先想', '一想', '。'],
      text: ['逐', '字', '流', '式', '。'],
      delayMs: 40,
    }),
  }),
  async (h, r) => {
    await h.startThread();
    const t0 = performance.now();
    const turnId = await h.startTurn('[stream] 你好');
    const done = await h.server.waitTurnCompleted(h.threadId, turnId);
    const ns = h.notificationsFor(turnId);
    const deltas = ns.filter((n) => n.method === 'item/agentMessage/delta');
    const reasoningDeltas = ns.filter((n) => n.method === 'item/reasoning/textDelta');
    check(r, (done.params.turn as { status: string }).status === 'completed', '回合 completed');
    check(r, deltas.length === 5, 'item/agentMessage/delta 逐片到达（5 片）', deltas.length);
    check(
      r,
      reasoningDeltas.length === 3,
      'item/reasoning/textDelta 逐片到达（3 片，show_raw_agent_reasoning=true）',
      reasoningDeltas.length,
    );
    const first = deltas[0];
    if (first)
      r.notes.push(
        `首个文本增量距 turn/start ${Math.round(first.at - t0)} ms（mock 每片间隔 40 ms，先发 3 片推理）`,
      );
    const message = h.itemsCompleted(turnId, 'agentMessage')[0];
    check(r, message?.text === '逐字流式。', 'agentMessage 已提交文本与增量一致', message?.text);
    const reasoning = h.itemsCompleted(turnId, 'reasoning')[0];
    r.notes.push(`reasoning item：${JSON.stringify(reasoning)}`);
    check(
      r,
      ns.some((n) => n.method === 'thread/tokenUsage/updated'),
      'thread/tokenUsage/updated',
    );
    r.notes.push(`通知序列：${[...new Set(ns.map((n) => n.method))].join(' ')}`);
    if (h.responses && h.gateway) {
      const req = h.responses.requests[0] as RecordedRequest;
      const leaked = Object.keys(req.headers).filter((k) =>
        /^x-codex|^session-id|^thread-id|^originator|^x-client-request-id|^x-openai/.test(k),
      );
      check(
        r,
        leaked.length === 0 && req.body.client_metadata === undefined,
        '透传：上游看不到 x-codex-* 等头与 client_metadata',
        { leaked, headers: Object.keys(req.headers) },
      );
      // mock 上游没有 Key，所以上游请求里应当完全没有 authorization：Codex 的一次性令牌止于网关。
      // 产品网关总带上游 Key（假的），这时核对上游收到的是它，不是令牌（mock 只记方案与长度）。
      check(
        r,
        PRODUCT_GATEWAY
          ? req.headers.authorization ===
              `<Bearer …${'Bearer '.length + MOCK_UPSTREAM_KEY.length} chars>`
          : req.headers.authorization === undefined,
        '透传：Codex 的令牌不转发给上游',
        req.headers.authorization,
      );
    } else if (h.responses) {
      const req = h.responses.requests[0] as RecordedRequest;
      r.notes.push(`请求头：${Object.keys(req.headers).join(', ')}`);
      const { input: _i, tools: _t, ...rest } = req.body;
      r.notes.push(
        `请求体字段：${JSON.stringify(Object.keys(rest))} store=${rest.store} include=${JSON.stringify(rest.include)} reasoning=${JSON.stringify(rest.reasoning)}`,
      );
    }
  },
);

scenario(
  'stream-hidden-reasoning',
  (transport) => ({
    transport,
    script: () => ({ reasoning: ['藏起来', '的推理'], text: ['好'] }),
  }),
  async (h, r) => {
    await h.startThread();
    const turnId = await h.startTurn('[stream] 默认配置');
    await h.server.waitTurnCompleted(h.threadId, turnId);
    const ns = h.notificationsFor(turnId);
    const raw = ns.filter((n) => n.method === 'item/reasoning/textDelta').length;
    const summary = ns.filter((n) => n.method === 'item/reasoning/summaryTextDelta').length;
    r.notes.push(
      `默认配置（show_raw_agent_reasoning 未设）：textDelta ${raw} 条，summaryTextDelta ${summary} 条`,
    );
    check(r, true, '记录默认配置下原始推理是否透出', { raw, summary });
  },
);

// ---------------------------------------------------------------- 2. apply_patch 与文件审批

const PATCH_INSIDE = [
  '*** Begin Patch',
  '*** Add File: hello.txt',
  '+你好，Wevir',
  '*** End Patch',
].join('\n');
const patchOutside = (name: string) =>
  ['*** Begin Patch', `*** Add File: ${join(OUTSIDE, name)}`, '+outside', '*** End Patch'].join(
    '\n',
  );

scenario(
  'apply-patch',
  (transport) => ({
    transport,
    decide: (req: ServerRequest) => {
      if (req.method !== 'item/fileChange/requestApproval') return { decision: 'decline' };
      // 第一次（accept.txt）同意，第二次（decline.txt）拒绝：靠请求顺序区分。
      const n = approvalsSeen++;
      return { decision: n === 0 ? 'accept' : 'decline' };
    },
    script: (v) => {
      if (v.toolOutputs.length > 0) return say('补丁结果：', last(v.toolOutputs).slice(0, 60));
      if (has(v, '[patch-inside]'))
        return { toolCalls: [{ kind: 'custom', name: 'apply_patch', input: PATCH_INSIDE }] };
      if (has(v, '[patch-accept]'))
        return {
          toolCalls: [{ kind: 'custom', name: 'apply_patch', input: patchOutside('accept.txt') }],
        };
      if (has(v, '[patch-decline]'))
        return {
          toolCalls: [{ kind: 'custom', name: 'apply_patch', input: patchOutside('decline.txt') }],
        };
      return say('?');
    },
  }),
  async (h, r) => {
    approvalsSeen = 0;
    rmSync(OUTSIDE, { recursive: true, force: true });
    mkdirSync(OUTSIDE, { recursive: true });
    await h.startThread();
    let turn = await h.turn('[patch-inside] 新建 hello.txt');
    const file = join(h.sandbox.workspace, 'hello.txt');
    check(r, turn.status === 'completed', '工作区内补丁：回合 completed', turn);
    check(
      r,
      existsSync(file) && readFileSync(file, 'utf8') === '你好，Wevir\n',
      '工作区内补丁：文件已写入',
    );
    const fc = h.itemsCompleted(turn.id, 'fileChange')[0];
    check(
      r,
      fc?.status === 'completed',
      '工作区内补丁：fileChange item completed',
      fc && { status: fc.status, changes: fc.changes },
    );
    const approvalsInside = h.server.serverRequests.length;
    check(r, approvalsInside === 0, '工作区内补丁：不需要审批', approvalsInside);

    // 第一个请求里的 apply_patch 工具定义。
    if (h.responses) {
      const tools = h.responses.requests[0]?.body.tools ?? [];
      const ap = tools.find((t) => t.name === 'apply_patch') as Record<string, unknown> | undefined;
      check(
        r,
        ap?.type === 'custom',
        'Responses 请求里 apply_patch 是 custom 工具',
        ap && {
          type: ap.type,
          format: (ap.format as Record<string, unknown>)?.type,
          syntax: (ap.format as Record<string, unknown>)?.syntax,
        },
      );
      const out = h.responses.requests[1]?.body.input.find(
        (i) => i.type === 'custom_tool_call_output',
      );
      r.notes.push(`custom_tool_call_output：${JSON.stringify(out).slice(0, 300)}`);
    } else {
      const fn = h.chat?.requests[0]?.body.tools?.find((t) => t.function.name === 'apply_patch');
      check(
        r,
        fn !== undefined && JSON.stringify(fn.function.parameters).includes('"input"'),
        '网关把 apply_patch 摊平成带 input 参数的函数',
        fn?.function.parameters,
      );
      check(
        r,
        fn?.function.description?.includes('*** Begin Patch') === true ||
          fn?.function.description?.includes('begin_patch') === true,
        '网关把 Lark 语法写进函数描述',
        fn?.function.description?.slice(-200),
      );
      const tool = h.chat?.requests[1]?.body.messages.find((m) => m.role === 'tool');
      r.notes.push(`网关送给上游的工具结果：${JSON.stringify(tool).slice(0, 300)}`);
    }

    turn = await h.turn('[patch-accept] 写到工作区外');
    const acceptReq = h.server.serverRequests.find(
      (q) => q.method === 'item/fileChange/requestApproval',
    );
    check(
      r,
      acceptReq !== undefined,
      '工作区外补丁：收到 item/fileChange/requestApproval',
      acceptReq?.params,
    );
    check(r, existsSync(join(OUTSIDE, 'accept.txt')), '工作区外补丁 accept：文件已写入');
    check(r, turn.status === 'completed', '工作区外补丁 accept：回合 completed');

    turn = await h.turn('[patch-decline] 再写一个');
    check(r, !existsSync(join(OUTSIDE, 'decline.txt')), '工作区外补丁 decline：文件没有写入');
    const declined = h.itemsCompleted(turn.id, 'fileChange')[0];
    check(
      r,
      declined?.status === 'declined',
      '工作区外补丁 decline：fileChange status=declined',
      declined?.status,
    );
    const resolved = h.server.notifications.filter(
      (n) => n.method === 'serverRequest/resolved',
    ).length;
    r.notes.push(
      `serverRequest/resolved 通知：${resolved} 条；审批请求参数键：${Object.keys(acceptReq?.params ?? {}).join(',')}`,
    );
    rmSync(OUTSIDE, { recursive: true, force: true });
  },
);
let approvalsSeen = 0;

// ---------------------------------------------------------------- 3. 命令执行与审批

const escalate = (cmd: string) => ({
  kind: 'function' as const,
  name: 'exec_command',
  args: { cmd, sandbox_permissions: 'require_escalated', justification: '需要写到工作区外' },
});

scenario(
  'exec-approval',
  (transport) => ({
    transport,
    decide: (req: ServerRequest) => {
      const cmd = String(req.params.command ?? '');
      if (cmd.includes('decline')) return { decision: 'decline' };
      if (cmd.includes('session')) return { decision: 'acceptForSession' };
      return { decision: 'accept' };
    },
    script: (v) => {
      if (v.toolOutputs.length > 0) return say('命令结果：', last(v.toolOutputs).slice(0, 80));
      if (has(v, '[exec-inside]'))
        return {
          toolCalls: [
            {
              kind: 'function',
              name: 'exec_command',
              args: { cmd: 'echo inside > in.txt && echo ok' },
            },
          ],
        };
      if (has(v, '[exec-accept]'))
        return { toolCalls: [escalate(`touch ${join(OUTSIDE, 'accept')}`)] };
      if (has(v, '[exec-decline]'))
        return { toolCalls: [escalate(`touch ${join(OUTSIDE, 'decline')}`)] };
      if (has(v, '[exec-session]'))
        return { toolCalls: [escalate(`touch ${join(OUTSIDE, 'session')}`)] };
      return say('?');
    },
  }),
  async (h, r) => {
    rmSync(OUTSIDE, { recursive: true, force: true });
    mkdirSync(OUTSIDE, { recursive: true });
    await h.startThread();
    let turn = await h.turn('[exec-inside] 写个文件');
    const cmd = h.itemsCompleted(turn.id, 'commandExecution')[0];
    check(r, existsSync(join(h.sandbox.workspace, 'in.txt')), '沙箱内命令：文件已写入、不需审批');
    check(
      r,
      cmd?.status === 'completed' && cmd.exitCode === 0,
      '沙箱内命令：commandExecution completed，exit 0',
      cmd && { status: cmd.status, exitCode: cmd.exitCode, out: cmd.aggregatedOutput },
    );
    const deltas = h
      .notificationsFor(turn.id)
      .filter((n) => n.method === 'item/commandExecution/outputDelta').length;
    r.notes.push(
      `commandExecution/outputDelta：${deltas} 条；item 键：${Object.keys(cmd ?? {}).join(',')}`,
    );
    check(
      r,
      h.server.serverRequests.length === 0,
      '沙箱内命令：没有审批请求',
      h.server.serverRequests.length,
    );

    turn = await h.turn('[exec-decline] 越权写');
    const declineReq = h.server.serverRequests.at(-1);
    check(
      r,
      declineReq?.method === 'item/commandExecution/requestApproval',
      '越权命令：收到 item/commandExecution/requestApproval',
      declineReq && {
        method: declineReq.method,
        reason: declineReq.params.reason,
        command: declineReq.params.command,
      },
    );
    check(r, !existsSync(join(OUTSIDE, 'decline')), '越权命令 decline：没有执行');
    const declinedItem = h.itemsCompleted(turn.id, 'commandExecution')[0];
    r.notes.push(`decline 后的 commandExecution：status=${declinedItem?.status}`);

    turn = await h.turn('[exec-accept] 越权写');
    check(r, existsSync(join(OUTSIDE, 'accept')), '越权命令 accept：已在沙箱外执行');

    const before = h.server.serverRequests.length;
    await h.turn('[exec-session] 第一次');
    await h.turn('[exec-session] 第二次');
    const asked = h.server.serverRequests.length - before;
    check(r, asked === 1, 'acceptForSession：同一命令第二次不再审批', asked);
    rmSync(OUTSIDE, { recursive: true, force: true });
  },
);

// ---------------------------------------------------------------- 4. 跨回合的推理上下文

for (const encrypted of [false, true]) {
  scenario(
    encrypted ? 'reasoning-carry-encrypted' : 'reasoning-carry',
    (transport) => ({
      transport,
      script: (v) => {
        if (has(v, '[reason-1]') && v.toolOutputs.length === 0) {
          return {
            reasoning: ['第一回合的推理：', '暗号是 R1'],
            encryptedReasoning: encrypted ? 'ENC-R1' : undefined,
            toolCalls: [{ kind: 'function', name: 'exec_command', args: { cmd: 'echo step' } }],
          };
        }
        if (has(v, '[reason-1]'))
          return { reasoning: ['工具之后的推理 R2'], text: ['第一回合结束'] };
        return say('第二回合');
      },
    }),
    async (h, r) => {
      await h.startThread();
      await h.turn('[reason-1] 想一想再做');
      await h.turn('[reason-2] 继续');
      if (h.responses) {
        const reqs = h.responses.requests;
        const reasoningIn = (i: number) =>
          reqs[i]?.body.input
            .filter((x) => x.type === 'reasoning')
            .map((x) => ({
              content: x.content !== undefined,
              encrypted_content: x.encrypted_content ?? null,
              summary: x.summary,
            }));
        r.notes.push(
          `同一回合工具调用后的请求（#1）带回的推理项：${JSON.stringify(reasoningIn(1))}`,
        );
        r.notes.push(`下一回合首个请求（#2）带回的推理项：${JSON.stringify(reasoningIn(2))}`);
        const carried = (reasoningIn(2) ?? []).length;
        check(r, (reasoningIn(1) ?? []).length >= 1, '同一回合内：推理项随工具结果带回');
        check(r, carried >= 1, '跨回合：上一回合的推理项仍在输入里', carried);
      } else {
        const msgs = (i: number) =>
          (h.chat?.requests[i]?.body as ChatRequest | undefined)?.messages ?? [];
        const rc = (i: number) =>
          msgs(i)
            .filter((m) => m.role === 'assistant')
            .map((m) => m.reasoning_content ?? null);
        r.notes.push(`网关 → 上游 #1 的 assistant.reasoning_content：${JSON.stringify(rc(1))}`);
        r.notes.push(`网关 → 上游 #2 的 assistant.reasoning_content：${JSON.stringify(rc(2))}`);
        check(
          r,
          rc(1).some((x) => x?.includes('R1')),
          '同一回合内：reasoning_content 回传给上游（DeepSeek 工具调用要求）',
        );
        check(
          r,
          rc(2).some((x) => x?.includes('R1')),
          '跨回合：上一回合的 reasoning_content 仍回传',
          rc(2),
        );
      }
    },
  );
}

// ---------------------------------------------------------------- 5. 子 agent

scenario(
  'subagent',
  (transport) => ({
    transport,
    script: (v) => {
      if (v.lastUserText.includes('[child]')) return say('子 agent 完成：', '42');
      if (has(v, '[spawn]')) {
        const outputs = v.toolOutputs;
        if (outputs.length === 0) {
          return {
            toolCalls: [
              {
                kind: 'function',
                namespace: 'multi_agent_v1',
                name: 'spawn_agent',
                args: { message: '[child] 数到 42' },
              },
            ],
          };
        }
        if (outputs.length === 1) {
          const first = outputs[0] ?? '';
          const id = /"(?:agent_id|id)"\s*:\s*"([^"]+)"/.exec(first)?.[1] ?? first;
          return {
            toolCalls: [
              {
                kind: 'function',
                namespace: 'multi_agent_v1',
                name: 'wait_agent',
                args: { targets: [id], timeout_ms: 10000 },
              },
            ],
          };
        }
        return say('父 agent 收到：', last(outputs).slice(0, 80));
      }
      return say('?');
    },
  }),
  async (h, r) => {
    await h.startThread();
    const turn = await h.turn('[spawn] 派一个子 agent', 90_000);
    check(r, turn.status === 'completed', '父回合 completed', turn);
    const collab = h.itemsCompleted(turn.id).filter((i) => i.type === 'collabAgentToolCall');
    check(
      r,
      collab.length === 2,
      '父 thread 有 collabAgentToolCall item（spawnAgent、wait）',
      collab.map((c) => ({
        tool: c.tool,
        status: c.status,
        receiverThreadIds: c.receiverThreadIds,
        agentsStates: c.agentsStates,
      })),
    );
    const childId = (collab[0]?.receiverThreadIds as string[] | undefined)?.[0];
    const childEvents = h.server.notifications.filter(
      (n) => childId !== undefined && n.params.threadId === childId,
    );
    r.notes.push(`子 thread 上的通知：${[...new Set(childEvents.map((n) => n.method))].join(' ')}`);
    const spawnedStarted = h.server.notifications.some(
      (n) => n.method === 'thread/started' && (n.params.thread as { id: string }).id === childId,
    );
    r.notes.push(
      `子 thread 有没有 thread/started：${spawnedStarted}（新 thread 自动挂到所有已初始化连接，upstream/codex/codex-rs/app-server/src/lib.rs:1291-1310）`,
    );
    check(
      r,
      childEvents.some((n) => n.method === 'item/agentMessage/delta'),
      '父连接自动收到子 thread 的逐字增量',
    );
    const childTurn = childEvents.find((n) => n.method === 'turn/started')?.params.turn as
      | { rootTurnId?: string }
      | undefined;
    check(
      r,
      childTurn?.rootTurnId === turn.id,
      '子回合的 rootTurnId 指向父回合',
      childTurn?.rootTurnId,
    );
    if (childId) {
      const list = await h.server
        .request<{ data: Array<{ id: string }> }>('thread/list', { parentThreadId: h.threadId })
        .then((l) => JSON.stringify(l.data.map((t) => t.id)))
        .catch((e: Error) => `报错：${e.message}`);
      r.notes.push(`thread/list {parentThreadId}（experimentalApi=false）：${list}`);
      const read = await h.server.request<{ thread: Record<string, unknown> }>('thread/read', {
        threadId: childId,
      });
      check(
        r,
        read.thread.parentThreadId === h.threadId,
        'thread/read 子 thread：parentThreadId 指向父 thread',
        {
          parentThreadId: read.thread.parentThreadId,
          agentNickname: read.thread.agentNickname,
          agentRole: read.thread.agentRole,
          source: read.thread.source,
        },
      );
    }
    const final = h.itemsCompleted(turn.id, 'agentMessage').at(-1);
    check(r, String(final?.text ?? '').includes('42'), '父 agent 拿到子 agent 的结果', final?.text);
  },
);

// ---------------------------------------------------------------- 6. 取消

scenario(
  'cancel',
  (transport) => ({
    transport,
    decide: () => new Promise(() => {}), // 审批永远不回，用来测“审批挂起时取消”
    script: (v) => {
      if (has(v, '[slow]'))
        return { text: Array.from({ length: 40 }, (_, i) => `${i} `), delayMs: 100 };
      if (has(v, '[pending]') && v.toolOutputs.length === 0)
        return { toolCalls: [escalate('touch /wevir-never')] };
      return say('取消之后的新回合正常');
    },
  }),
  async (h, r) => {
    await h.startThread();
    const turnId = await h.startTurn('[slow] 说很长的话');
    await h.server.waitFor(
      (n) => n.method === 'item/agentMessage/delta' && n.params.turnId === turnId,
      20_000,
      '首个增量',
    );
    await h.server.waitFor(
      (n) =>
        n.method === 'item/agentMessage/delta' &&
        n.params.turnId === turnId &&
        n.params.delta === '2 ',
      20_000,
      '第 3 个增量',
    );
    const t0 = performance.now();
    await h.server.request('turn/interrupt', { threadId: h.threadId, turnId });
    const done = await h.server.waitTurnCompleted(h.threadId, turnId, 10_000);
    const ms = Math.round(performance.now() - t0);
    const turn = done.params.turn as { status: string; items: unknown[] };
    check(
      r,
      turn.status === 'interrupted',
      '流式中取消：turn/completed status=interrupted',
      turn.status,
    );
    r.notes.push(`流式中取消：turn/interrupt → turn/completed ${ms} ms`);
    const deltas = h
      .notificationsFor(turnId)
      .filter((n) => n.method === 'item/agentMessage/delta').length;
    const partial = h.itemsCompleted(turnId, 'agentMessage')[0];
    r.notes.push(
      `取消前收到 ${deltas} 个增量；取消后 agentMessage item：${JSON.stringify(partial?.text ?? null)}`,
    );
    await new Promise((res) => setTimeout(res, 300));
    const upstream = h.responses?.requests[0] ?? h.chat?.requests[0];
    check(
      r,
      upstream?.aborted === true,
      '模型请求被中断（直连：Codex 断开；网关：网关跟着断开上游）',
      upstream?.aborted,
    );

    const pendingTurn = await h.startTurn('[pending] 需要审批的命令');
    await h.server.waitForRequest(
      (q) => q.method === 'item/commandExecution/requestApproval',
      20_000,
    );
    const pendingRequests = h.server.serverRequests.length;
    check(r, pendingRequests === 1, '审批挂起：收到审批请求', pendingRequests);
    const t1 = performance.now();
    await h.server.request('turn/interrupt', { threadId: h.threadId, turnId: pendingTurn });
    const done2 = await h.server.waitTurnCompleted(h.threadId, pendingTurn, 10_000);
    check(
      r,
      (done2.params.turn as { status: string }).status === 'interrupted',
      '审批挂起时取消：status=interrupted',
      (done2.params.turn as { status: string }).status,
    );
    r.notes.push(`审批挂起时取消：${Math.round(performance.now() - t1)} ms`);
    const resolved = await h.server
      .waitFor((n) => n.method === 'serverRequest/resolved', 3000, 'serverRequest/resolved')
      .catch(() => undefined);
    check(
      r,
      resolved !== undefined,
      '审批挂起时取消：服务端发 serverRequest/resolved 收回审批',
      resolved?.params,
    );
    if (resolved) {
      const order =
        h.server.notifications.indexOf(resolved) - h.server.notifications.indexOf(done2);
      r.notes.push(`serverRequest/resolved 在 turn/completed ${order > 0 ? '之后' : '之前'}到达`);
    }

    const after = await h.turn('[after] 再来');
    check(r, after.status === 'completed', '取消后同一 thread 的新回合正常', after.status);
  },
);

// ---------------------------------------------------------------- 7. resume

scenario(
  'resume',
  (transport) => ({
    transport,
    script: (v) => {
      if (has(v, '[remember]')) return say('记住了');
      if (has(v, '[recall]')) return say(v.allText.includes('青鸟') ? '暗号是青鸟' : '不记得');
      return say('?');
    },
  }),
  async (h, r) => {
    await h.startThread();
    await h.turn('[remember] 我的暗号是 青鸟');
    const threadId = h.threadId;
    const t0 = performance.now();
    const exit = await h.server.close();
    r.notes.push(
      `关 stdin 后 app-server 退出：${Math.round(performance.now() - t0)} ms，${JSON.stringify(exit)}`,
    );
    check(r, exit.code === 0 || exit.signal === null, 'stdin EOF 后自行退出');

    const server = h.spawn();
    await server.initialize(false);
    const list = await server.request<{ data: Array<{ id: string }> }>('thread/list', {});
    check(
      r,
      list.data.some((t) => t.id === threadId),
      '新进程 thread/list 能看到旧 thread',
      list.data.length,
    );
    const resumed = await server.request<{ thread: { id: string; turns: unknown[] } }>(
      'thread/resume',
      { threadId },
    );
    check(r, resumed.thread.id === threadId, 'thread/resume 成功', {
      turns: resumed.thread.turns?.length,
    });
    const turn = await h.turn('[recall] 我的暗号是什么？');
    const answer = h.itemsCompleted(turn.id, 'agentMessage')[0];
    check(r, answer?.text === '暗号是青鸟', 'resume 后模型请求带着完整历史', answer?.text);

    const bogus = await server
      .request('thread/resume', { threadId: '019a0000-0000-7000-8000-000000000000' })
      .then(() => 'ok')
      .catch((e: Error & { rpc?: unknown }) => JSON.stringify(e.rpc ?? e.message));
    r.notes.push(`resume 不存在的 thread：${bogus}`);
    check(r, bogus !== 'ok', 'resume 不存在的 thread 报错（给 session_lost 映射）', bogus);
  },
);

// ---------------------------------------------------------------- 8. 计划（update_plan 默认关闭）

scenario(
  'plan',
  (transport) => ({
    transport,
    extraTop: ['tools.update_plan.enabled = true'],
    script: (v) =>
      v.toolOutputs.length === 0
        ? {
            toolCalls: [
              {
                kind: 'function',
                name: 'update_plan',
                args: {
                  explanation: '分两步',
                  plan: [
                    { step: '读代码', status: 'completed' },
                    { step: '改代码', status: 'in_progress' },
                  ],
                },
              },
            ],
          }
        : say('计划已更新'),
  }),
  async (h, r) => {
    await h.startThread();
    const turn = await h.turn('[plan] 先列计划');
    const plan = h.notificationsFor(turn.id).find((n) => n.method === 'turn/plan/updated');
    check(
      r,
      plan !== undefined,
      'tools.update_plan.enabled=true 时收到 turn/plan/updated',
      plan?.params,
    );
    const tools =
      h.responses?.requests[0]?.body.tools?.map((t) => t.name) ??
      h.chat?.requests[0]?.body.tools?.map((t) => t.function.name);
    r.notes.push(`工具列表：${JSON.stringify(tools)}`);
  },
);

// ---------------------------------------------------------------- 9. 上游报错

scenario(
  'upstream-error',
  (transport) => ({
    transport,
    script: (v) => {
      if (has(v, '[http400]'))
        return { httpError: { status: 400, message: 'mock: model not found' } };
      if (has(v, '[failed]'))
        return { failed: { code: 'server_error', message: 'mock: stream failed' } };
      return say('恢复正常');
    },
  }),
  async (h, r) => {
    await h.startThread();
    const t1 = await h.turn('[http400] 坏请求');
    const err = h.notificationsFor(t1.id).filter((n) => n.method === 'error');
    check(r, t1.status === 'failed', 'HTTP 400：回合 failed', {
      status: t1.status,
      error: t1.error,
    });
    r.notes.push(
      `HTTP 400 的 error 通知：${JSON.stringify(err.map((n) => n.params)).slice(0, 400)}`,
    );
    if (h.responses) {
      const t2 = await h.turn('[failed] 流里失败');
      check(r, t2.status === 'failed', 'response.failed：回合 failed', {
        status: t2.status,
        error: t2.error,
      });
    }
    const t3 = await h.turn('[ok] 再来');
    check(r, t3.status === 'completed', '报错之后同一 thread 继续可用', t3.status);
    r.notes.push(`模型请求次数：${h.modelRequests}（request_max_retries=0）`);
  },
);

// ---------------------------------------------------------------- 10. 密钥：不落盘、工具读不到

scenario(
  'secrets',
  (transport) => ({
    transport,
    script: (v) =>
      v.toolOutputs.length === 0
        ? {
            toolCalls: [
              {
                kind: 'function',
                name: 'exec_command',
                args: { cmd: 'env | grep -c "^WEVIR_" || true' },
              },
            ],
          }
        : say('env 里 WEVIR_ 开头的变量数：', last((v.toolOutputs[0] ?? '').trim().split('\n'))),
  }),
  async (h, r) => {
    await h.startThread();
    const turn = await h.turn('[secrets] 看看环境变量');
    const answer = String(h.itemsCompleted(turn.id, 'agentMessage')[0]?.text ?? '');
    check(
      r,
      answer.endsWith('0'),
      '模型跑的命令看不到 WEVIR_* 环境变量（shell_environment_policy）',
      answer,
    );
    await h.server.close();
    const token = h.envValue();
    let hits = '';
    try {
      hits = execFileSync('grep', ['-rl', '-a', token, h.sandbox.root], {
        encoding: 'utf8',
      }).trim();
    } catch {
      hits = '';
    }
    check(
      r,
      hits === '',
      'Key / 令牌没有写进 CODEX_HOME 与工作区（含 SQLite 日志库、rollout）',
      hits,
    );
    check(r, !h.server.stderr.some((l) => l.includes(token)), 'Key / 令牌没有出现在 stderr 日志');
  },
);

// ---------------------------------------------------------------- 运行

const fixturesDir = join(SPIKE_ROOT, 'fixtures');
for (const s of scenarios) {
  if (only && !only.includes(s.name)) continue;
  for (const t of transports) {
    process.stdout.write(`▶ ${s.name} [${t}] … `);
    await s.run(t);
    const r = results.at(-1) as Result;
    const failed = r.checks.filter((c) => !c.ok).length;
    console.log(
      r.error ? '出错' : failed ? `${failed} 项不通过` : `通过 ${r.checks.length} 项`,
      `(${r.ms} ms)`,
    );
  }
}

console.log('\n================ 结果 ================');
let total = 0;
let bad = 0;
for (const r of results) {
  console.log(`\n## ${r.scenario} [${r.transport}] ${r.ms} ms`);
  for (const c of r.checks) {
    total += 1;
    if (!c.ok) bad += 1;
    console.log(
      `  ${c.ok ? '✓' : '✗'} ${c.label}${c.detail && (!c.ok || trace) ? `  ← ${c.detail.slice(0, 400)}` : ''}`,
    );
  }
  for (const n of r.notes) console.log(`  · ${n.slice(0, 600)}`);
  if (r.error) {
    bad += 1;
    console.log(`  ✗ 出错：${r.error.split('\n').slice(0, 4).join(' | ')}`);
  }
}
console.log(`\n共 ${total} 项检查，${bad} 项不通过或出错。`);
if (!only && transports.length === 3 && !PRODUCT_GATEWAY) {
  // 本机路径换成占位符；耗时与 id 每次都不同，不进 fixture。
  const scrub = (text: string) =>
    text
      .replaceAll(realpathSync(tmpdir()), '<TMPDIR>')
      .replaceAll(tmpdir(), '<TMPDIR>')
      .replaceAll(SPIKE_ROOT, '<SPIKE>')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>');
  writeFileSync(
    join(fixturesDir, 'results.json'),
    `${scrub(
      JSON.stringify(
        results.map(({ ms: _ms, ...r }) => r),
        null,
        2,
      ),
    )}\n`,
  );
}
rmSync(join(SPIKE_ROOT, '.run'), { recursive: true, force: true });
process.exit(bad > 0 ? 1 : 0);
