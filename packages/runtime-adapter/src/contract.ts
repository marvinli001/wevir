import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRuntimeAdapter } from './adapter.js';
import { type AdapterError, type AdapterErrorCode, isAdapterError } from './errors.js';
import {
  type AgentEvent,
  type ApprovalRequestedEvent,
  isTurnTerminal,
  type SubagentStartedEvent,
  type ToolFinishedEvent,
  type TurnTerminalEvent,
} from './events.js';
import type { AgentInput, ApprovalOption, SessionConfig } from './types.js';

// 与实现无关的 AgentRuntimeAdapter 契约测试。EchoAdapter（本包）、dsh 适配器（T3.6 的录制回放、
// 真实 dsh + mock Provider、真实模型三层）都跑同一套：
//
//   import { runAdapterContract } from '@wevir/runtime-adapter/contract';
//   runAdapterContract(() => createMyAdapter(), { incrementalStream: true, … }, { prompts: … });
//
// 引擎做不到的条款按能力开关跳过（显示为 skipped），不删条款（ADR-0001 §7）。

/** 适配器声明的能力。为 false 的能力对应的条款跳过。 */
export interface AdapterCapabilities {
  /** 先发 `assistant.delta`，再发替换它们的已提交消息。只产出已提交消息的引擎为 false。 */
  incrementalStream: boolean;
  /** 能按 `prompts.toolCall` 发起一次不需要审批的工具调用。 */
  toolCalls: boolean;
  /** 能按 `prompts.approval` 发起审批，且审批在决定之前一直挂起。 */
  approvals: boolean;
  /** `close` 之后能 `resumeSession`。 */
  resume: boolean;
  /** 同一实例上多个会话的回合可以同时进行。 */
  concurrentSessions: boolean;
  /**
   * 子会话（R4，domain-model §3.3.1）：按 `prompts.subagent` 派出子 agent，在父会话的流里报 `subagent.started`，子会话
   * 的事件按它自己的引擎会话 ID 上报。Codex 有，dsh 与其他 ACP 引擎没有。
   */
  subagents: boolean;
  /**
   * 插话（R11，domain-model §4.6）：实现了 `steer`，回合进行中交出去的输入在当前这一步之后进了同一个回合（`turn.steered`），
   * 没有回合时报 `steer_rejected`。Codex 与 echo 有；dsh 与其他 ACP 引擎没有，也不实现 `steer`（Host 据此一律排队）。
   */
  steer: boolean;
}

/** 驱动引擎做出特定行为的提示词。真实模型或 mock Provider 按自己的脚本替换。 */
export interface ContractPrompts {
  /** 普通一问一答：至少一条助手消息，不调工具、不审批。 */
  plain: string;
  /** 引发一次不需要审批的工具调用（`toolCalls`）。 */
  toolCall: string;
  /** 引发一次审批（`approvals`），审批前先有同一 toolCallId 的 `tool.started`。 */
  approval: string;
  /** 派出一个子 agent，子 agent 一问一答，父回合等它结束再回答（`subagents`；没有子会话的引擎不用给）。 */
  subagent?: string;
  /** 同上，但子 agent 先请求一次审批（`subagents` 且 `approvals`）。 */
  subagentApproval?: string;
  /** 一个慢回合：流式输出持续足够久，中途插话来得及（`steer`；不能插话的引擎不用给）。 */
  slow?: string;
  /** 插话的内容，模型据此接着回答（`steer`）。 */
  steer?: string;
}

/** 默认提示词，按 EchoAdapter 的关键词写（echo.ts）。 */
export const DEFAULT_CONTRACT_PROMPTS: Readonly<Required<ContractPrompts>> = Object.freeze({
  plain: 'Say hello',
  toolCall: 'Please call a tool',
  approval: 'Please approve writing a file outside the workspace',
  subagent: 'Please start a subagent',
  subagentApproval: 'Please start a subagent that needs to approve a write',
  slow: 'Please answer slowly',
  steer: 'Also mention the weather',
});

export interface ContractOptions<A extends AgentRuntimeAdapter = AgentRuntimeAdapter> {
  /** describe 名，默认 'AgentRuntimeAdapter 契约'。同一文件跑多组时用来区分。 */
  name?: string;
  /** 建会话用的配置；默认 `{ cwd: process.cwd(), providerId: 'contract', modelId: 'contract' }`。 */
  sessionConfig?: SessionConfig | (() => SessionConfig | Promise<SessionConfig>);
  prompts?: Partial<ContractPrompts>;
  /** 每次等事件的时限，默认 5000 ms。真实模型要调大。 */
  waitTimeoutMs?: number;
  /** 每条用例的时限，默认 20000 ms。 */
  testTimeoutMs?: number;
  /** 让引擎进程退出（dsh：杀子进程）。提供时跑“引擎退出上报”条款，否则跳过。 */
  simulateEngineExit?: (adapter: A) => Promise<void>;
  /** `dispose` 之后判断资源是否已全部释放（子进程、计时器、句柄）。提供时在 dispose 条款里检查。 */
  resourcesReleased?: (adapter: A) => boolean | Promise<boolean>;
}

const UNKNOWN_SESSION = 'contract-unknown-session';

export function runAdapterContract<A extends AgentRuntimeAdapter>(
  createAdapter: () => A | Promise<A>,
  capabilities: AdapterCapabilities,
  options: ContractOptions<A> = {},
): void {
  const caps = capabilities;
  const prompts: Required<ContractPrompts> = { ...DEFAULT_CONTRACT_PROMPTS, ...options.prompts };
  const waitTimeoutMs = options.waitTimeoutMs ?? 5000;
  const simulateEngineExit = options.simulateEngineExit;

  const sessionConfig = async (): Promise<SessionConfig> => {
    const config = options.sessionConfig;
    if (typeof config === 'function') return config();
    return config ?? { cwd: process.cwd(), providerId: 'contract', modelId: 'contract' };
  };

  describe(options.name ?? 'AgentRuntimeAdapter 契约', {
    timeout: options.testTimeoutMs ?? 20_000,
  }, () => {
    let adapters: A[] = [];

    afterEach(async () => {
      const created = adapters;
      adapters = [];
      await Promise.allSettled(created.map((adapter) => adapter.dispose()));
    });

    async function newAdapter(): Promise<A> {
      const adapter = await createAdapter();
      adapters.push(adapter);
      return adapter;
    }

    async function openSession(adapter: A, config?: SessionConfig): Promise<OpenSession> {
      const { engineSessionId } = await adapter.createSession(config ?? (await sessionConfig()));
      return attach(adapter, engineSessionId);
    }

    function attach(adapter: A, engineSessionId: string): OpenSession {
      return {
        id: engineSessionId,
        log: new EventLog(adapter.subscribe(engineSessionId), waitTimeoutMs),
      };
    }

    /** 等第 `from` 条之后的第一个终结事件，并检查这个回合的通用约束。 */
    async function finishTurn(session: OpenSession, from: number): Promise<TurnResult> {
      const { event, index } = await session.log.waitFor(isTurnTerminal, '回合终结事件', from);
      const events = session.log.events.slice(from, index + 1);
      expect(checkTurnEvents(events, session.id)).toEqual([]);
      if (event.type === 'turn.settled') expect(checkDeltaReplacement(events)).toEqual([]);
      return { events, terminal: event };
    }

    async function runTurn(adapter: A, session: OpenSession, prompt: string): Promise<TurnResult> {
      const from = session.log.events.length;
      await adapter.send(session.id, text(prompt));
      return finishTurn(session, from);
    }

    async function startApprovalTurn(
      adapter: A,
      session: OpenSession,
    ): Promise<{ from: number; request: ApprovalRequestedEvent }> {
      const from = session.log.events.length;
      await adapter.send(session.id, text(prompts.approval));
      const { event } = await session.log.waitFor(ofType('approval.requested'), '审批请求', from);
      return { from, request: event };
    }

    it('createSession 返回各不相同的引擎会话 ID，可以订阅', async () => {
      const adapter = await newAdapter();
      const config = await sessionConfig();
      const first = await adapter.createSession(config);
      const second = await adapter.createSession(config);
      expect(first.engineSessionId).toEqual(expect.any(String));
      expect(first.engineSessionId.length).toBeGreaterThan(0);
      expect(first.engineSessionId).not.toBe(second.engineSessionId);

      const stream = adapter.subscribe(first.engineSessionId);
      expect(typeof stream[Symbol.asyncIterator]).toBe('function');
      await expectAdapterError(() => adapter.subscribe(UNKNOWN_SESSION), 'session_not_found');
      await expectAdapterError(
        () => adapter.send(UNKNOWN_SESSION, text(prompts.plain)),
        'session_not_found',
      );
    });

    it('send 之后收到助手输出，回合以完成事件结束；同一会话可以连续多个回合', async () => {
      const adapter = await newAdapter();
      const session = await openSession(adapter);
      for (let round = 0; round < 2; round += 1) {
        const turn = await runTurn(adapter, session, prompts.plain);
        expect(turn.terminal).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
        const messages = turn.events.filter(ofType('assistant.message'));
        expect(messages.length).toBeGreaterThan(0);
        expect(messages.some((message) => message.text.length > 0)).toBe(true);
      }
      await expectAdapterError(() => adapter.send(session.id, { content: [] }), 'invalid_input');
    });

    it.skipIf(!caps.incrementalStream)('增量之后有对应的已提交消息替换它们', async () => {
      const adapter = await newAdapter();
      const session = await openSession(adapter);
      const turn = await runTurn(adapter, session, prompts.plain);
      expect(turn.events.filter(ofType('assistant.delta')).length).toBeGreaterThan(0);
      // finishTurn 已用 checkDeltaReplacement 检查每个增量块都被替换；这里再确认先增量后消息。
      const firstDelta = turn.events.findIndex((event) => event.type === 'assistant.delta');
      const firstMessage = turn.events.findIndex((event) => event.type === 'assistant.message');
      expect(firstDelta).toBeLessThan(firstMessage);
    });

    it.skipIf(!caps.toolCalls)(
      '工具调用先 tool.started，后同一 toolCallId 的 tool.finished',
      async () => {
        const adapter = await newAdapter();
        const session = await openSession(adapter);
        const turn = await runTurn(adapter, session, prompts.toolCall);
        expect(turn.terminal).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
        const startedIndex = turn.events.findIndex((event) => event.type === 'tool.started');
        const started = turn.events[startedIndex];
        if (started?.type !== 'tool.started') throw new Error('回合里没有 tool.started');
        expect(started.toolName.length).toBeGreaterThan(0);
        expect(typeof started.display.kind).toBe('string');
        const finished = toolFinished(turn.events, started.toolCallId);
        expect(finished?.status).toBe('completed');
        expect(turn.events.indexOf(finished as AgentEvent)).toBeGreaterThan(startedIndex);
      },
    );

    it.skipIf(!caps.approvals)('审批：选允许后工具完成，回合正常结束', async () => {
      const adapter = await newAdapter();
      const session = await openSession(adapter);
      const { from, request } = await startApprovalTurn(adapter, session);
      expect(request.engineSessionId).toBe(session.id);
      expect(request.options.length).toBeGreaterThan(0);
      // Host 从同一 toolCallId 的 tool.started 取审批详情（ADR-0001 §5）。
      const before = session.log.events.slice(from);
      expect(
        before.some(
          (event) => event.type === 'tool.started' && event.toolCallId === request.toolCallId,
        ),
      ).toBe(true);

      await adapter.respondToApproval(session.id, request.requestId, {
        optionId: pickOption(request, 'allow').optionId,
      });
      const turn = await finishTurn(session, from);
      expect(turn.terminal).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
      expect(toolFinished(turn.events, request.toolCallId)?.status).toBe('completed');
      expect(turn.events.some((event) => event.type === 'approval.cancelled')).toBe(false);
      expect(await adapter.listPendingApprovals(session.id)).toEqual([]);
    });

    it.skipIf(!caps.approvals)('审批：选拒绝后工具失败，回合仍正常结束', async () => {
      const adapter = await newAdapter();
      const session = await openSession(adapter);
      const { from, request } = await startApprovalTurn(adapter, session);
      await adapter.respondToApproval(session.id, request.requestId, {
        optionId: pickOption(request, 'reject').optionId,
      });
      const turn = await finishTurn(session, from);
      expect(turn.terminal).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
      expect(toolFinished(turn.events, request.toolCallId)?.status).toBe('failed');
      expect(await adapter.listPendingApprovals(session.id)).toEqual([]);
    });

    it.skipIf(!caps.approvals)('审批只接受请求里的选项，一个请求只能决定一次', async () => {
      const adapter = await newAdapter();
      const session = await openSession(adapter);
      const { from, request } = await startApprovalTurn(adapter, session);
      const allow = pickOption(request, 'allow').optionId;

      await expectAdapterError(
        () =>
          adapter.respondToApproval(session.id, request.requestId, {
            optionId: 'contract-no-such-option',
          }),
        'invalid_option',
      );
      expect(await adapter.listPendingApprovals(session.id)).toHaveLength(1);
      await expectAdapterError(
        () =>
          adapter.respondToApproval(session.id, 'contract-no-such-request', { optionId: allow }),
        'approval_not_found',
      );

      await adapter.respondToApproval(session.id, request.requestId, { optionId: allow });
      await expectAdapterError(
        () => adapter.respondToApproval(session.id, request.requestId, { optionId: allow }),
        'approval_not_found',
      );
      const turn = await finishTurn(session, from);
      expect(turn.terminal).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
    });

    it.skipIf(!caps.approvals)(
      '审批挂起时取消：审批以 cancelled 结束，回合以取消结算',
      async () => {
        const adapter = await newAdapter();
        const session = await openSession(adapter);
        const { from, request } = await startApprovalTurn(adapter, session);

        await adapter.cancel(session.id);
        // cancel 返回即回合已停：紧接着就能开始下一个回合，不报 session_busy。
        await adapter.send(session.id, text(prompts.plain));
        expect(await adapter.listPendingApprovals(session.id)).toEqual([]);
        await expectAdapterError(
          () =>
            adapter.respondToApproval(session.id, request.requestId, {
              optionId: pickOption(request, 'allow').optionId,
            }),
          'approval_not_found',
        );

        const cancelled = await finishTurn(session, from);
        expect(cancelled.terminal).toMatchObject({ type: 'turn.settled', outcome: 'cancelled' });
        const approvalEnd = cancelled.events.find(
          (event) => event.type === 'approval.cancelled' && event.requestId === request.requestId,
        );
        expect(approvalEnd).toMatchObject({ reason: 'turn_cancelled' });
        const tool = toolFinished(cancelled.events, request.toolCallId);
        if (tool) expect(tool.status).toBe('failed');

        const next = await finishTurn(session, from + cancelled.events.length);
        expect(next.terminal).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
      },
    );

    it('取消幂等：空闲、不认识的会话、重复取消都成功，一个回合只结算一次', async () => {
      const adapter = await newAdapter();
      const session = await openSession(adapter);
      await adapter.cancel(session.id);
      await adapter.cancel(UNKNOWN_SESSION);

      const from = session.log.events.length;
      if (caps.approvals) await startApprovalTurn(adapter, session);
      else await adapter.send(session.id, text(prompts.plain));
      await Promise.all([adapter.cancel(session.id), adapter.cancel(session.id)]);
      await adapter.cancel(session.id);

      const first = await finishTurn(session, from);
      // 没有审批时回合可能在取消送达前就自然结束了，两种结算都合法。
      if (caps.approvals) {
        expect(first.terminal).toMatchObject({ type: 'turn.settled', outcome: 'cancelled' });
      } else {
        expect(first.terminal.type).toBe('turn.settled');
      }
      const second = await runTurn(adapter, session, prompts.plain);
      expect(second.terminal).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
      expect(session.log.events.filter(isTurnTerminal)).toHaveLength(2);
    });

    it.skipIf(!caps.approvals)('回合进行中再 send 报 session_busy，不打断当前回合', async () => {
      const adapter = await newAdapter();
      const session = await openSession(adapter);
      const { from, request } = await startApprovalTurn(adapter, session);
      await expectAdapterError(() => adapter.send(session.id, text(prompts.plain)), 'session_busy');
      expect(await adapter.listPendingApprovals(session.id)).toHaveLength(1);
      await adapter.respondToApproval(session.id, request.requestId, {
        optionId: pickOption(request, 'allow').optionId,
      });
      const turn = await finishTurn(session, from);
      expect(turn.terminal).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
    });

    it('关闭后再发送报错，订阅随之结束，重复关闭成功', async () => {
      const adapter = await newAdapter();
      const session = await openSession(adapter);
      await runTurn(adapter, session, prompts.plain);

      await adapter.close(session.id);
      await session.log.waitForEnd();
      await expectAdapterError(
        () => adapter.send(session.id, text(prompts.plain)),
        'session_closed',
      );
      await expectAdapterError(() => adapter.subscribe(session.id), 'session_closed');
      await adapter.close(session.id);
      await adapter.cancel(session.id);
      await expectAdapterError(() => adapter.close(UNKNOWN_SESSION), 'session_not_found');
    });

    it.skipIf(!caps.approvals)('回合进行中关闭：先取消，审批以 cancelled 结束', async () => {
      const adapter = await newAdapter();
      const session = await openSession(adapter);
      const { request } = await startApprovalTurn(adapter, session);

      await adapter.close(session.id);
      await session.log.waitForEnd();
      expect(
        session.log.events.find(
          (event) => event.type === 'approval.cancelled' && event.requestId === request.requestId,
        ),
      ).toMatchObject({ reason: 'turn_cancelled' });
      expect(await adapter.listPendingApprovals()).toEqual([]);
      await expectAdapterError(
        () => adapter.send(session.id, text(prompts.plain)),
        'session_closed',
      );
    });

    it.skipIf(!caps.approvals)('列出未决审批，供 Host 对账', async () => {
      const adapter = await newAdapter();
      const session = await openSession(adapter);
      const other = await openSession(adapter);
      expect(await adapter.listPendingApprovals()).toEqual([]);

      const { from, request } = await startApprovalTurn(adapter, session);
      const { type: _type, ...pending } = request;
      expect(await adapter.listPendingApprovals(session.id)).toEqual([pending]);
      expect(await adapter.listPendingApprovals()).toEqual([pending]);
      expect(await adapter.listPendingApprovals(other.id)).toEqual([]);
      expect(await adapter.listPendingApprovals(UNKNOWN_SESSION)).toEqual([]);

      await adapter.respondToApproval(session.id, request.requestId, {
        optionId: pickOption(request, 'allow').optionId,
      });
      expect(await adapter.listPendingApprovals()).toEqual([]);
      await finishTurn(session, from);
    });

    it('dispose 释放资源：订阅结束，之后的调用报 disposed，可以重复 dispose', async () => {
      const adapter = await newAdapter();
      const session = await openSession(adapter);
      if (caps.approvals) await startApprovalTurn(adapter, session);
      else await adapter.send(session.id, text(prompts.plain));

      await adapter.dispose();
      await session.log.waitForEnd();
      const config = await sessionConfig();
      await expectAdapterError(() => adapter.createSession(config), 'disposed');
      await expectAdapterError(() => adapter.send(session.id, text(prompts.plain)), 'disposed');
      await expectAdapterError(() => adapter.subscribe(session.id), 'disposed');
      await expectAdapterError(() => adapter.listPendingApprovals(), 'disposed');
      await adapter.cancel(session.id);
      await adapter.dispose();
      if (options.resourcesReleased) {
        expect(await options.resourcesReleased(adapter)).toBe(true);
      }
    });

    it.skipIf(!caps.concurrentSessions)('两个会话并发互不干扰', async () => {
      const adapter = await newAdapter();
      const a = await openSession(adapter);
      const b = await openSession(adapter);
      expect(a.id).not.toBe(b.id);

      const [turnA, turnB] = await Promise.all([
        runTurn(adapter, a, prompts.plain),
        runTurn(adapter, b, prompts.plain),
      ]);
      expect(turnA.terminal).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
      expect(turnB.terminal).toMatchObject({ type: 'turn.settled', outcome: 'completed' });

      if (caps.approvals) {
        // A 挂着审批时，B 照常完成回合；取消 A 不影响 B。
        const { from } = await startApprovalTurn(adapter, a);
        const whileAWaits = await runTurn(adapter, b, prompts.plain);
        expect(whileAWaits.terminal).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
        expect(await adapter.listPendingApprovals(b.id)).toEqual([]);
        await adapter.cancel(a.id);
        const cancelled = await finishTurn(a, from);
        expect(cancelled.terminal).toMatchObject({ type: 'turn.settled', outcome: 'cancelled' });
        const afterCancel = await runTurn(adapter, b, prompts.plain);
        expect(afterCancel.terminal).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
        expect(b.log.events.some((event) => event.type.startsWith('approval.'))).toBe(false);
      }
      expect(a.log.events.every((event) => event.engineSessionId === a.id)).toBe(true);
      expect(b.log.events.every((event) => event.engineSessionId === b.id)).toBe(true);
    });

    /** `steer` 能力声明了就必须实现。 */
    function steerOf(adapter: A): NonNullable<AgentRuntimeAdapter['steer']> {
      if (!adapter.steer) throw new Error('声明了 steer 能力，却没有实现 steer');
      return adapter.steer.bind(adapter);
    }

    it.skipIf(!caps.steer)(
      '插话：回合进行中 steer 被接受，turn.steered 在终结事件之前，之后模型接着输出',
      async () => {
        const adapter = await newAdapter();
        const session = await openSession(adapter);
        const steer = steerOf(adapter);
        const from = session.log.events.length;
        await adapter.send(session.id, text(prompts.slow));
        // 看到这一步已经在输出再插话，插话应当在这一步之后进回合。没有增量时看不到“正在输出”，send 返回（引擎已接受
        // 回合）就插话：引擎可能在第一步之前就用上它（Codex 在第一次采样开始之前收到的插话会并进第一次请求）。
        if (caps.incrementalStream) {
          await session.log.waitFor(ofType('assistant.delta'), '慢回合开始输出', from);
        }
        await steer(session.id, 'contract-steer-1', text(prompts.steer));
        const turn = await finishTurn(session, from);
        expect(turn.terminal).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
        const steeredAt = turn.events.findIndex(
          (event) => event.type === 'turn.steered' && event.steerId === 'contract-steer-1',
        );
        expect(steeredAt).toBeGreaterThanOrEqual(0);
        // 插话之前是这一步的输出，之后模型接着输出（同一个回合）。
        const before = turn.events.slice(0, steeredAt);
        const after = turn.events.slice(steeredAt + 1);
        if (caps.incrementalStream) {
          expect(before.some((event) => event.type === 'assistant.message')).toBe(true);
        }
        expect(after.some((event) => event.type === 'assistant.message')).toBe(true);
        expect(turn.events.filter(ofType('turn.steered'))).toHaveLength(1);
      },
    );

    it.skipIf(!caps.steer)(
      '插话：没有进行中的回合时报 steer_rejected，之后照常 send（Host 据此改为排队）',
      async () => {
        const adapter = await newAdapter();
        const session = await openSession(adapter);
        const steer = steerOf(adapter);
        await expectAdapterError(
          () => steer(session.id, 'contract-steer-2', text(prompts.steer)),
          'steer_rejected',
        );
        await runTurn(adapter, session, prompts.plain);
        // 回合结束之后同样被拒；排队的消息作为下一个回合发出。
        await expectAdapterError(
          () => steer(session.id, 'contract-steer-3', text(prompts.steer)),
          'steer_rejected',
        );
        const queued = await runTurn(adapter, session, prompts.steer);
        expect(queued.terminal).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
        expect(queued.events.some((event) => event.type === 'turn.steered')).toBe(false);
        await expectAdapterError(
          () => steer(UNKNOWN_SESSION, 'contract-steer-4', text(prompts.steer)),
          'session_not_found',
        );
      },
    );

    /** 父会话发 `prompt`，等到父会话流里的 `subagent.started`，订阅子会话。 */
    async function startSubagent(
      adapter: A,
      prompt: string,
    ): Promise<{
      parent: OpenSession;
      from: number;
      started: SubagentStartedEvent;
      child: OpenSession;
    }> {
      const parent = await openSession(adapter);
      const from = parent.log.events.length;
      await adapter.send(parent.id, text(prompt));
      const { event: started } = await parent.log.waitFor(
        ofType('subagent.started'),
        'subagent.started',
        from,
      );
      return { parent, from, started, child: attach(adapter, started.childEngineSessionId) };
    }

    /** 子会话的一个回合：`turn.started` 开头、终结事件结尾，事件都属于子会话。 */
    async function finishChildTurn(child: OpenSession, from = 0): Promise<TurnResult> {
      const { index } = await child.log.waitFor(
        ofType('turn.started'),
        '子会话的 turn.started',
        from,
      );
      const turn = await finishTurn(child, index);
      expect(turn.events[0]?.type).toBe('turn.started');
      return turn;
    }

    it.skipIf(!caps.subagents)(
      '子会话：父会话的流里报 subagent.started，子会话的事件按它自己的 ID 上报，回合由引擎开始',
      async () => {
        const adapter = await newAdapter();
        const { parent, from, started, child } = await startSubagent(adapter, prompts.subagent);
        expect(started.engineSessionId).toBe(parent.id);
        expect(started.childEngineSessionId).not.toBe(parent.id);
        expect(typeof started.title).toBe('string');
        // 派出它的工具调用在父会话的流里，且在 subagent.started 之前开始。
        const startedAt = parent.log.events.indexOf(started);
        expect(
          parent.log.events
            .slice(from, startedAt)
            .some(
              (event) =>
                event.type === 'tool.started' && event.toolCallId === started.parentToolCallId,
            ),
        ).toBe(true);

        // 子会话的事件早于订阅也不会丢：回合从 turn.started 开始。
        const childTurn = await finishChildTurn(child);
        expect(childTurn.terminal).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
        const childStart = childTurn.events[0];
        if (childStart?.type === 'turn.started' && childStart.input !== undefined) {
          expect(childStart.input.length).toBeGreaterThan(0);
        }
        expect(childTurn.events.filter(ofType('assistant.message')).length).toBeGreaterThan(0);

        const parentTurn = await finishTurn(parent, from);
        expect(parentTurn.terminal).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
        expect(parent.log.events.some((event) => event.engineSessionId !== parent.id)).toBe(false);

        // 子会话由父 agent 驱动，不接受 send。
        await expectAdapterError(
          () => adapter.send(child.id, text(prompts.plain)),
          'invalid_input',
        );
      },
    );

    it.skipIf(!caps.subagents || !caps.approvals)(
      '子会话的审批：请求在子会话的流里，用子会话的 ID 回复',
      async () => {
        const adapter = await newAdapter();
        const { parent, from, child } = await startSubagent(adapter, prompts.subagentApproval);
        const { event: request } = await child.log.waitFor(
          ofType('approval.requested'),
          '子会话的审批请求',
        );
        expect(request.engineSessionId).toBe(child.id);
        expect(await adapter.listPendingApprovals(child.id)).toHaveLength(1);
        expect(await adapter.listPendingApprovals(parent.id)).toEqual([]);
        expect(parent.log.events.some((event) => event.type === 'approval.requested')).toBe(false);

        await adapter.respondToApproval(child.id, request.requestId, {
          optionId: pickOption(request, 'allow').optionId,
        });
        const childTurn = await finishChildTurn(child);
        expect(childTurn.terminal).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
        expect(toolFinished(childTurn.events, request.toolCallId)?.status).toBe('completed');
        const parentTurn = await finishTurn(parent, from);
        expect(parentTurn.terminal).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
      },
    );

    it.skipIf(!caps.subagents || !caps.approvals)(
      '取消子会话的回合（Host 取消父会话时级联用）：审批以 cancelled 结束，子回合以取消结算',
      async () => {
        const adapter = await newAdapter();
        const { parent, from, child } = await startSubagent(adapter, prompts.subagentApproval);
        const { event: request } = await child.log.waitFor(
          ofType('approval.requested'),
          '子会话的审批请求',
        );
        await adapter.cancel(child.id);
        const childTurn = await finishChildTurn(child);
        expect(childTurn.terminal).toMatchObject({ type: 'turn.settled', outcome: 'cancelled' });
        expect(
          childTurn.events.find(
            (event) => event.type === 'approval.cancelled' && event.requestId === request.requestId,
          ),
        ).toMatchObject({ reason: 'turn_cancelled' });
        expect(await adapter.listPendingApprovals()).toEqual([]);

        // 父回合可能还在等子 agent（Codex 的 wait 不因子回合被中断而结束），取消它收尾。
        await adapter.cancel(parent.id);
        const parentTurn = await finishTurn(parent, from);
        expect(parentTurn.terminal.type).toBe('turn.settled');
      },
    );

    it.skipIf(!caps.resume)('close 之后 resumeSession 可以继续对话', async () => {
      const adapter = await newAdapter();
      const config = await sessionConfig();
      const session = await openSession(adapter, config);
      await runTurn(adapter, session, prompts.plain);
      await adapter.close(session.id);
      await session.log.waitForEnd();

      const resumed = await adapter.resumeSession(session.id, config);
      expect(resumed.engineSessionId).toBe(session.id);
      const reattached = attach(adapter, session.id);
      const turn = await runTurn(adapter, reattached, prompts.plain);
      expect(turn.terminal).toMatchObject({ type: 'turn.settled', outcome: 'completed' });

      // 已挂上时直接成功，现有订阅不受影响。
      expect((await adapter.resumeSession(session.id, config)).engineSessionId).toBe(session.id);
      expect(reattached.log.ended).toBe(false);
      // 引擎里没有的会话恢复不了（T3.5）：Host 据此把会话标为只读。
      const lost = await expectAdapterError(
        () => adapter.resumeSession(UNKNOWN_SESSION, config),
        'session_lost',
      );
      expect(lost.lostReason).toBe('not_found');
    });

    it.skipIf(!simulateEngineExit)('引擎进程在回合之间退出：以 engine.exited 上报', async () => {
      const adapter = await newAdapter();
      const config = await sessionConfig();
      const session = await openSession(adapter, config);
      await runTurn(adapter, session, prompts.plain);

      const from = session.log.events.length;
      await simulateEngineExit?.(adapter);
      const { event } = await session.log.waitFor(ofType('engine.exited'), 'engine.exited', from);
      expect(event.engineSessionId).toBe(session.id);
      await session.log.waitForEnd();
      expect(session.log.events.at(-1)?.type).toBe('engine.exited');
      await expectAdapterError(
        () => adapter.send(session.id, text(prompts.plain)),
        'session_closed',
      );

      if (caps.resume) {
        await adapter.resumeSession(session.id, config);
        const turn = await runTurn(adapter, attach(adapter, session.id), prompts.plain);
        expect(turn.terminal).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
      }
    });

    it.skipIf(!simulateEngineExit || !caps.approvals)(
      '引擎进程在审批挂起时退出：审批结束，engine.exited 是该回合的终结事件',
      async () => {
        const adapter = await newAdapter();
        const session = await openSession(adapter);
        const { from, request } = await startApprovalTurn(adapter, session);

        await simulateEngineExit?.(adapter);
        const turn = await finishTurn(session, from);
        expect(turn.terminal.type).toBe('engine.exited');
        expect(
          turn.events.find(
            (event) => event.type === 'approval.cancelled' && event.requestId === request.requestId,
          ),
        ).toMatchObject({ reason: 'engine_exited' });
        await session.log.waitForEnd();
        expect(await adapter.listPendingApprovals()).toEqual([]);
      },
    );
  });
}

// ── 检查函数（纯函数，单独导出供适配器调试与自测） ─────────────────────────────────────────

/**
 * 检查一个回合的事件（`send` 之后到终结事件，含终结事件）：都属于该会话；恰好一个终结事件且在最后。
 * 返回违规描述，空数组表示通过。
 */
export function checkTurnEvents(events: readonly AgentEvent[], engineSessionId: string): string[] {
  const problems: string[] = [];
  events.forEach((event, index) => {
    if (event.engineSessionId !== engineSessionId) {
      problems.push(`#${index} ${event.type} 属于会话 ${event.engineSessionId}`);
    }
  });
  const terminals = events.flatMap((event, index) => (isTurnTerminal(event) ? [index] : []));
  if (terminals.length !== 1) {
    problems.push(`终结事件应恰好一个，实际 ${terminals.length} 个`);
  } else if (terminals[0] !== events.length - 1) {
    problems.push(`终结事件 #${terminals[0]} 之后还有事件`);
  }
  return problems;
}

/**
 * 检查增量与已提交消息的替换关系（domain-model.md §6.3）：
 * - 每个增量块（没有以 abandoned 结束的 attempt）在它最后一个增量之后、终结事件之前，被一条同类
 *   已提交事件（text → `assistant.message`，reasoning → `assistant.thought`）的 `replaces` 指到；
 * - `replaces` 只指向此前出现过的、同类的增量块。
 * 返回违规描述，空数组表示通过。
 */
export function checkDeltaReplacement(events: readonly AgentEvent[]): string[] {
  const problems: string[] = [];
  const terminal = events.findIndex(isTurnTerminal);
  const limit = terminal === -1 ? events.length : terminal;
  const abandoned = new Set<string>();
  const blocks = new Map<string, { kind: 'text' | 'reasoning'; lastIndex: number }>();
  const replacedAt = new Map<string, number[]>();

  events.forEach((event, index) => {
    if (event.type === 'assistant.stream_ended' && event.outcome === 'abandoned') {
      abandoned.add(event.attemptId);
    } else if (event.type === 'assistant.delta') {
      const key = blockKey(event);
      const known = blocks.get(key);
      if (known && known.kind !== event.kind) {
        problems.push(`增量块 ${key} 混用了 ${known.kind} 与 ${event.kind}`);
      }
      blocks.set(key, { kind: event.kind, lastIndex: index });
    } else if (event.type === 'assistant.message' || event.type === 'assistant.thought') {
      const kind = event.type === 'assistant.message' ? 'text' : 'reasoning';
      for (const ref of event.replaces) {
        const key = blockKey(ref);
        const block = blocks.get(key);
        if (!block) problems.push(`#${index} ${event.type} 替换了此前没有出现过的增量块 ${key}`);
        else if (block.kind !== kind) {
          problems.push(`#${index} ${event.type} 替换了 ${block.kind} 增量块 ${key}`);
        }
        replacedAt.set(key, [...(replacedAt.get(key) ?? []), index]);
      }
    }
  });

  for (const [key, block] of blocks) {
    if (abandoned.has(key.slice(0, key.lastIndexOf('#')))) continue;
    const replaced = (replacedAt.get(key) ?? []).some(
      (index) => index > block.lastIndex && index < limit,
    );
    if (!replaced) problems.push(`增量块 ${key}（${block.kind}）在回合结束前没有被已提交消息替换`);
  }
  return problems;
}

// ── 内部工具 ──────────────────────────────────────────────────────────────────────

interface OpenSession {
  id: string;
  log: EventLog;
}

interface TurnResult {
  /** 从 send 之后到终结事件（含）。 */
  events: AgentEvent[];
  terminal: TurnTerminalEvent;
}

function text(prompt: string): AgentInput {
  return { content: [{ type: 'text', text: prompt }] };
}

function blockKey(ref: { attemptId: string; blockIndex: number }): string {
  return `${ref.attemptId}#${ref.blockIndex}`;
}

function ofType<K extends AgentEvent['type']>(type: K) {
  return (event: AgentEvent): event is Extract<AgentEvent, { type: K }> => event.type === type;
}

function toolFinished(
  events: readonly AgentEvent[],
  toolCallId: string,
): ToolFinishedEvent | undefined {
  return events.find(
    (event): event is ToolFinishedEvent =>
      event.type === 'tool.finished' && event.toolCallId === toolCallId,
  );
}

/** 按 kind 取选项：`allow` 开头算允许，其余算拒绝（与 protocol 的 category 推导一致）。 */
function pickOption(request: ApprovalRequestedEvent, category: 'allow' | 'reject'): ApprovalOption {
  const option = request.options.find(
    (candidate) => candidate.kind.startsWith('allow') === (category === 'allow'),
  );
  if (!option)
    throw new Error(`审批请求没有 ${category} 类选项：${JSON.stringify(request.options)}`);
  return option;
}

/** 同步抛出与返回 rejected Promise 都算失败；断言失败的是指定错误码的 AdapterError。 */
async function expectAdapterError(
  action: () => unknown,
  code: AdapterErrorCode,
): Promise<AdapterError> {
  let caught: unknown;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  expect(isAdapterError(caught) ? caught.code : caught, `应以 AdapterError(${code}) 失败`).toBe(
    code,
  );
  return caught as AdapterError;
}

/** 把一个订阅收进数组，提供“等到某个事件”的能力；超时或订阅结束时报出已收到的事件类型。 */
class EventLog {
  readonly events: AgentEvent[] = [];
  readonly #listeners = new Set<() => void>();
  readonly #timeoutMs: number;
  #ended = false;
  #failure: unknown;

  constructor(stream: AsyncIterable<AgentEvent>, timeoutMs: number) {
    this.#timeoutMs = timeoutMs;
    void this.#consume(stream);
  }

  get ended(): boolean {
    return this.#ended;
  }

  /** 第 `from` 条（含）之后第一个满足条件的事件。 */
  waitFor<T extends AgentEvent>(
    match: (event: AgentEvent) => event is T,
    what: string,
    from = 0,
  ): Promise<{ event: T; index: number }> {
    return this.#until(() => {
      const index = this.events.findIndex((event, i) => i >= from && match(event));
      const event = this.events[index];
      return event === undefined ? undefined : { event: event as T, index };
    }, what);
  }

  waitForEnd(): Promise<true> {
    return this.#until(() => (this.#ended ? true : undefined), '订阅结束');
  }

  async #consume(stream: AsyncIterable<AgentEvent>): Promise<void> {
    try {
      for await (const event of stream) {
        this.events.push(event);
        this.#notify();
      }
    } catch (error) {
      this.#failure = error;
    } finally {
      this.#ended = true;
      this.#notify();
    }
  }

  #notify(): void {
    for (const listener of [...this.#listeners]) listener();
  }

  #until<R>(probe: () => R | undefined, what: string): Promise<R> {
    return new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        this.#listeners.delete(check);
      };
      const check = () => {
        const result = probe();
        if (result !== undefined) {
          finish();
          resolve(result);
        } else if (this.#ended) {
          finish();
          reject(new Error(`订阅已结束，没等到${what}${this.#seen()}`));
        }
      };
      const timer = setTimeout(() => {
        finish();
        reject(new Error(`${this.#timeoutMs} ms 内没等到${what}${this.#seen()}`));
      }, this.#timeoutMs);
      this.#listeners.add(check);
      check();
    });
  }

  #seen(): string {
    const types = this.events.map((event) => event.type).join(', ') || '无';
    const failure = this.#failure === undefined ? '' : `；订阅出错：${String(this.#failure)}`;
    return `（已收到：${types}${failure}）`;
  }
}
