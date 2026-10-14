// 审批（codex-event-mapping.md §6.6）：真实 codex-app-server + 网关 + mock 模型。命令与补丁的审批请求 → 固定选项的
// approval.requested，请求之前补上理由（tool.updated）；各个决定的结果；本会话同意之后同一命令不再问；“告诉它换个做法”
// 中断回合；审批挂起时取消的 serverRequest/resolved 在回合结算之后才到，不产生多余的事件或告警。二进制不在时跳过。

import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent } from '@wevir/runtime-adapter';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  COMMAND_APPROVAL_OPTIONS,
  type CodexAdapter,
  FILE_CHANGE_APPROVAL_OPTIONS,
} from './codex-adapter.js';
import { escalatedCommand } from './test-fixtures/contract.js';
import {
  codexBinaryOrSkip,
  collectEvents,
  collectingLogger,
  finishTurn,
  newAdapter,
  ofType,
  runTurn,
  TempDirs,
  waitForEvent,
} from './test-fixtures/harness.js';
import {
  MOCK_MODEL,
  MOCK_PATCH,
  type MockModel,
  type MockScript,
  mockProvider,
  startMockModel,
} from './test-fixtures/mock-model.js';
import { makeOutsideDir } from './test-fixtures/outside-dir.js';

const binary = codexBinaryOrSkip('adapter-codex 审批');
const dirs = new TempDirs();
const outside = makeOutsideDir('approval');
let mock: MockModel;
const adapters: CodexAdapter[] = [];
afterAll(() => outside.remove());

/**
 * `[cmd:<名字>]`：越出沙箱 touch 工作区外的文件；`[patch:<名字>]`：apply_patch 新建工作区外的文件；`[inside]`：工作区里
 * 的一条命令与一个补丁。
 */
const script: MockScript = (view) => {
  if (view.toolOutputs.length > 0) return { text: ['好的。'] };
  const cmd = /\[cmd:([\w-]+)\]/.exec(view.lastUserText)?.[1];
  if (cmd !== undefined) {
    return { toolCalls: [escalatedCommand(`touch ${join(outside.dir, cmd)}`, `要写 ${cmd}`)] };
  }
  const patch = /\[patch:([\w.-]+)\]/.exec(view.lastUserText)?.[1];
  if (patch !== undefined) {
    return {
      toolCalls: [
        {
          kind: 'custom',
          name: 'apply_patch',
          input: [
            '*** Begin Patch',
            `*** Add File: ${join(outside.dir, patch)}`,
            '+outside',
            '*** End Patch',
          ].join('\n'),
        },
      ],
    };
  }
  if (view.lastUserText.includes('[inside]')) {
    return {
      toolCalls: [
        { kind: 'function', name: 'exec_command', args: { cmd: 'echo inside > inside.txt' } },
        { kind: 'custom', name: 'apply_patch', input: MOCK_PATCH },
      ],
    };
  }
  return { text: ['你好。'] };
};

async function open(logger = collectingLogger()) {
  const { home, workspace } = dirs.make('approval');
  const adapter = newAdapter({ home, providers: [mockProvider(mock)], logger });
  adapters.push(adapter);
  const { engineSessionId } = await adapter.createSession({
    cwd: workspace,
    providerId: 'mock',
    modelId: MOCK_MODEL,
  });
  return { adapter, id: engineSessionId, events: collectEvents(adapter, engineSessionId), logger };
}

/** 发一条会引起审批的消息，等审批请求。 */
async function requestApproval(
  adapter: CodexAdapter,
  id: string,
  events: AgentEvent[],
  text: string,
) {
  const from = events.length;
  await adapter.send(id, { content: [{ type: 'text', text }] });
  const request = await waitForEvent(events, ofType('approval.requested'), '审批请求', from);
  return { from, request };
}

describe.skipIf(binary === undefined)(
  'CodexAdapter 审批（真实 codex-app-server）',
  { timeout: 60_000 },
  () => {
    beforeAll(async () => {
      mock = await startMockModel(script);
    });
    afterEach(async () => {
      await Promise.allSettled(adapters.splice(0).map((adapter) => adapter.dispose()));
    });
    afterAll(async () => {
      await mock?.close();
      dirs.cleanup();
    });

    it('命令：先有工具与理由，再是四个固定选项；同意后在沙箱外执行，回合正常结束', async () => {
      const { adapter, id, events } = await open();
      const { from, request } = await requestApproval(adapter, id, events, '[cmd:accept]');
      expect(request.options).toEqual(COMMAND_APPROVAL_OPTIONS);
      const before = events.slice(from, events.indexOf(request));
      const started = before.find(ofType('tool.started'));
      expect(started).toMatchObject({
        toolCallId: request.toolCallId,
        toolName: 'commandExecution',
        display: { kind: 'shell' },
      });
      // 审批详情的理由：item/started 之后、请求之前补一条 tool.updated，输入带 justification（Host 从这里取）。
      const updated = before.find(ofType('tool.updated'));
      expect(updated).toMatchObject({
        toolCallId: request.toolCallId,
        input: {
          type: 'commandExecution',
          command: expect.stringContaining('touch'),
          cwd: expect.any(String),
          commandActions: expect.any(Array),
          justification: '要写 accept',
        },
      });
      expect(await adapter.listPendingApprovals(id)).toHaveLength(1);

      await adapter.respondToApproval(id, request.requestId, { optionId: 'accept' });
      const turn = await finishTurn(events, from);
      expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
      expect(
        turn.find((e) => e.type === 'tool.finished' && e.toolCallId === request.toolCallId),
      ).toMatchObject({
        status: 'completed',
      });
      expect(existsSync(join(outside.dir, 'accept'))).toBe(true);
      expect(turn.some((e) => e.type === 'approval.cancelled')).toBe(false);
    });

    it('命令：不运行并继续（decline）→ 工具失败、回合继续；告诉它换个做法（cancel）→ 回合以取消结算', async () => {
      const { adapter, id, events } = await open();
      let { from, request } = await requestApproval(adapter, id, events, '[cmd:decline]');
      await adapter.respondToApproval(id, request.requestId, { optionId: 'decline' });
      let turn = await finishTurn(events, from);
      expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
      expect(turn.find(ofType('tool.finished'))).toMatchObject({ status: 'failed' });
      expect(turn.some((e) => e.type === 'assistant.message')).toBe(true);
      expect(existsSync(join(outside.dir, 'decline'))).toBe(false);

      ({ from, request } = await requestApproval(adapter, id, events, '[cmd:cancel]'));
      await adapter.respondToApproval(id, request.requestId, { optionId: 'cancel' });
      turn = await finishTurn(events, from);
      expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'cancelled' });
      expect(turn.find(ofType('tool.finished'))).toMatchObject({ status: 'failed' });
      expect(turn.some((e) => e.type === 'assistant.message')).toBe(false);
      expect(existsSync(join(outside.dir, 'cancel'))).toBe(false);
    });

    it('命令：本会话同意之后，同一个命令不再请求审批', async () => {
      const { adapter, id, events } = await open();
      const { from, request } = await requestApproval(adapter, id, events, '[cmd:session]');
      await adapter.respondToApproval(id, request.requestId, { optionId: 'acceptForSession' });
      await finishTurn(events, from);
      rmSync(join(outside.dir, 'session'), { force: true });
      const again = await runTurn(adapter, id, '[cmd:session]', events);
      expect(again.some((e) => e.type === 'approval.requested')).toBe(false);
      expect(again.find(ofType('tool.finished'))).toMatchObject({ status: 'completed' });
      expect(existsSync(join(outside.dir, 'session'))).toBe(true);
    });

    it('补丁：详情是同一 item 的 changes，三个选项；“告诉它换个做法”时补丁没有 item/completed，按失败收尾', async () => {
      const { adapter, id, events } = await open();
      let { from, request } = await requestApproval(
        adapter,
        id,
        events,
        '[patch:patch-accept.txt]',
      );
      expect(request.options).toEqual(FILE_CHANGE_APPROVAL_OPTIONS);
      const started = events.slice(from).find(ofType('tool.started'));
      expect(started).toMatchObject({
        toolCallId: request.toolCallId,
        toolName: 'fileChange',
        display: { kind: 'write', paths: [join(outside.dir, 'patch-accept.txt')] },
        input: { changes: [expect.objectContaining({ diff: expect.stringContaining('outside') })] },
      });
      await adapter.respondToApproval(id, request.requestId, { optionId: 'accept' });
      let turn = await finishTurn(events, from);
      expect(turn.find(ofType('tool.finished'))).toMatchObject({ status: 'completed' });
      expect(existsSync(join(outside.dir, 'patch-accept.txt'))).toBe(true);

      ({ from, request } = await requestApproval(adapter, id, events, '[patch:patch-cancel.txt]'));
      await adapter.respondToApproval(id, request.requestId, { optionId: 'cancel' });
      turn = await finishTurn(events, from);
      expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'cancelled' });
      expect(turn.find(ofType('tool.finished'))).toMatchObject({
        toolCallId: request.toolCallId,
        status: 'failed',
      });
      expect(existsSync(join(outside.dir, 'patch-cancel.txt'))).toBe(false);
    });

    it('审批挂起时取消：审批先以 cancelled 结束，回合以取消结算；之后才到的 serverRequest/resolved 不再产生事件与告警', async () => {
      const { adapter, id, events, logger } = await open();
      const { from, request } = await requestApproval(adapter, id, events, '[cmd:pending]');
      await adapter.cancel(id);
      const turn = events.slice(from);
      const cancelled = turn.findIndex((e) => e.type === 'approval.cancelled');
      const settled = turn.findIndex((e) => e.type === 'turn.settled');
      expect(turn[cancelled]).toMatchObject({
        requestId: request.requestId,
        reason: 'turn_cancelled',
      });
      expect(turn[settled]).toMatchObject({ outcome: 'cancelled' });
      expect(cancelled).toBeLessThan(settled);
      expect(turn.find(ofType('tool.finished'))).toMatchObject({ status: 'failed' });
      // serverRequest/resolved 在 turn/completed 之后才到（codex-notes §2.3）。
      const count = events.length;
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(events.slice(count)).toEqual([]);
      expect(logger.warnings).toEqual([]);
      expect(await adapter.listPendingApprovals()).toEqual([]);
      // 会话照常可用。
      const next = await runTurn(adapter, id, '你好', events);
      expect(next.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
    });

    it('工作区内的命令与补丁不需要审批', async () => {
      const { adapter, id, events } = await open();
      const turn = await runTurn(adapter, id, '[inside]', events);
      expect(turn.some((e) => e.type === 'approval.requested')).toBe(false);
      expect(turn.filter(ofType('tool.finished')).map((e) => e.status)).toEqual([
        'completed',
        'completed',
      ]);
    });
  },
);
