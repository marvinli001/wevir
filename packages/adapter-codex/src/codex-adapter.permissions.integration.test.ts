// 权限模式（0.11.0，codex-event-mapping.md §4.7）：真实 codex-app-server + 网关 + mock 模型。完全访问下越界的命令不请求
// 审批直接执行；自动批准下由 Codex 的审查子 agent 用会话的模型（mock）判断，允许的执行、拒绝的失败，都不问用户；换回请求
// 批准后照常请求审批。二进制不在时跳过。

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent, PermissionMode } from '@wevir/runtime-adapter';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CodexAdapter } from './codex-adapter.js';
import { escalatedCommand } from './test-fixtures/contract.js';
import {
  codexBinaryOrSkip,
  collectEvents,
  collectingLogger,
  finishTurn,
  newAdapter,
  ofType,
  TempDirs,
  waitForEvent,
} from './test-fixtures/harness.js';
import {
  MOCK_MODEL,
  type MockModel,
  type MockScript,
  mockProvider,
  startMockModel,
} from './test-fixtures/mock-model.js';
import { makeOutsideDir } from './test-fixtures/outside-dir.js';

const binary = codexBinaryOrSkip('adapter-codex 权限模式');
const dirs = new TempDirs();
const outside = makeOutsideDir('permissions');
/** 环境会话的额外目录（0.15.0，§4.8）。 */
const extra = makeOutsideDir('extra-root');
let mock: MockModel;
const adapters: CodexAdapter[] = [];
afterAll(() => {
  outside.remove();
  extra.remove();
});

/** Codex 审查子 agent 的说明的第一句（codex-rs prompts/templates/guardian/policy_template.md）。 */
const REVIEW_PROMPT = 'You are judging one planned coding-agent action';

/**
 * `[cmd:<名字>]`：申请越出沙箱 touch 工作区外的文件；`[plain:<名字>]`：不申请，直接 touch（完全访问下模型知道没有沙箱，
 * Codex 在审批策略为 never 时拒绝越权申请）。审查请求：要写的文件名是 `deny-me` 的判为高风险拒绝，其余低风险允许。
 */
const script: MockScript = (view) => {
  if (JSON.stringify(view.body).includes(REVIEW_PROMPT)) {
    const deny = JSON.stringify(view.body.input).includes('deny-me');
    return {
      text: [
        JSON.stringify(
          deny
            ? {
                risk_level: 'high',
                user_authorization: 'low',
                outcome: 'deny',
                rationale: '会删数据',
              }
            : {
                risk_level: 'low',
                user_authorization: 'high',
                outcome: 'allow',
                rationale: '只建文件',
              },
        ),
      ],
    };
  }
  if (view.toolOutputs.length > 0) return { text: ['好的。'] };
  const plain = /\[plain:([\w-]+)\]/.exec(view.lastUserText)?.[1];
  if (plain !== undefined) {
    return {
      toolCalls: [
        {
          kind: 'function',
          name: 'exec_command',
          args: { cmd: `touch ${join(outside.dir, plain)}` },
        },
      ],
    };
  }
  const root = /\[extra:([\w-]+)\]/.exec(view.lastUserText)?.[1];
  if (root !== undefined) {
    return {
      toolCalls: [
        { kind: 'function', name: 'exec_command', args: { cmd: `touch ${join(extra.dir, root)}` } },
      ],
    };
  }
  const cmd = /\[cmd:([\w-]+)\]/.exec(view.lastUserText)?.[1];
  if (cmd !== undefined) {
    return { toolCalls: [escalatedCommand(`touch ${join(outside.dir, cmd)}`, `要写 ${cmd}`)] };
  }
  return { text: ['你好。'] };
};

function reviewRequests(): number {
  return mock.requests.filter((request) => JSON.stringify(request.body).includes(REVIEW_PROMPT))
    .length;
}

async function open(permissionMode: PermissionMode, additionalRoots?: string[]) {
  const { home, workspace } = dirs.make('permissions');
  const logger = collectingLogger();
  const adapter = newAdapter({ home, providers: [mockProvider(mock)], logger });
  adapters.push(adapter);
  const { engineSessionId } = await adapter.createSession({
    cwd: workspace,
    providerId: 'mock',
    modelId: MOCK_MODEL,
    permissionMode,
    ...(additionalRoots && { additionalRoots }),
  });
  return { adapter, id: engineSessionId, events: collectEvents(adapter, engineSessionId), logger };
}

async function run(adapter: CodexAdapter, id: string, events: AgentEvent[], text: string) {
  const from = events.length;
  await adapter.send(id, { content: [{ type: 'text', text }] });
  return finishTurn(events, from);
}

describe.skipIf(binary === undefined)(
  'CodexAdapter 权限模式（真实 codex-app-server）',
  { timeout: 90_000 },
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

    it('完全访问：越界的命令不请求审批，直接在沙箱外执行', async () => {
      const { adapter, id, events } = await open('full_access');
      const turn = await run(adapter, id, events, '[plain:full]');
      expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
      expect(turn.some((e) => e.type === 'approval.requested')).toBe(false);
      expect(turn.find(ofType('tool.finished'))).toMatchObject({ status: 'completed' });
      expect(existsSync(join(outside.dir, 'full'))).toBe(true);
      // 模型从 Codex 的权限说明里知道没有沙箱、不审批（经网关的模型也有，Wevir 的 base.md 只是在它之前）。
      const sent = JSON.stringify(mock.requests.at(-1)?.body.input);
      expect(sent).toContain('`sandbox_mode` is `danger-full-access`');
      expect(sent).toContain('Approval policy is currently never');
    });

    it('环境会话的额外目录（0.15.0）：沙箱里可写、不问用户，模型从 developer instructions 知道它；没有时写不了', async () => {
      const plain = await open('on_request');
      const denied = await run(plain.adapter, plain.id, plain.events, '[extra:without]');
      expect(denied.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
      // 沙箱拦下了：命令输出是 Operation not permitted，文件没写出来。
      expect(JSON.stringify(mock.requests.at(-1)?.body.input)).toContain('Operation not permitted');
      expect(existsSync(join(extra.dir, 'without'))).toBe(false);

      const { adapter, id, events } = await open('on_request', [extra.dir]);
      const turn = await run(adapter, id, events, '[extra:with]');
      expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
      expect(turn.some((e) => e.type === 'approval.requested')).toBe(false);
      expect(existsSync(join(extra.dir, 'with'))).toBe(true);
      expect(JSON.stringify(mock.requests.at(-1)?.body)).toContain(extra.dir);
    });

    it('自动批准：会话的模型审查，允许的执行、拒绝的失败，都不问用户', async () => {
      const { adapter, id, events } = await open('auto_review');
      const before = reviewRequests();
      let turn = await run(adapter, id, events, '[cmd:reviewed]');
      console.log(
        'DEBUG',
        JSON.stringify(
          turn.map((e) => [e.type, 'status' in e ? e.status : '', 'output' in e ? e.output : '']),
        ),
        JSON.stringify(
          mock.requests.map((r) => [
            r.body.model,
            JSON.stringify(r.body).includes(REVIEW_PROMPT),
            JSON.stringify(r.body.input.at(-1)).slice(0, 300),
          ]),
        ),
      );
      expect(reviewRequests()).toBeGreaterThan(before);
      // 审查用的是会话自己的模型：经网关的模型目录里没有 Codex 偏好的审查模型。
      const review = mock.requests.findLast((r) => JSON.stringify(r.body).includes(REVIEW_PROMPT));
      expect(review?.body.model).toBe(MOCK_MODEL);
      expect(turn.some((e) => e.type === 'approval.requested')).toBe(false);
      expect(turn.find(ofType('tool.finished'))).toMatchObject({ status: 'completed' });
      expect(existsSync(join(outside.dir, 'reviewed'))).toBe(true);
      // 审查的过程与结论（item/autoApprovalReview/*、guardianWarning）不另出事件。
      expect(turn.some((e) => e.type === 'engine.raw')).toBe(false);

      turn = await run(adapter, id, events, '[cmd:deny-me]');
      expect(turn.some((e) => e.type === 'approval.requested')).toBe(false);
      expect(turn.find(ofType('tool.finished'))).toMatchObject({ status: 'failed' });
      expect(existsSync(join(outside.dir, 'deny-me'))).toBe(false);
      expect(turn.at(-1)).toMatchObject({ type: 'turn.settled' });
    });

    it('换回请求批准：下一个回合起越界的命令照常请求审批', async () => {
      const { adapter, id, events } = await open('full_access');
      await adapter.configureSession(id, { modelId: MOCK_MODEL, permissionMode: 'on_request' });
      const from = events.length;
      await adapter.send(id, { content: [{ type: 'text', text: '[cmd:asked]' }] });
      const request = await waitForEvent(events, ofType('approval.requested'), '审批请求', from);
      await adapter.respondToApproval(id, request.requestId, { optionId: 'cancel' });
      await finishTurn(events, from);
      expect(existsSync(join(outside.dir, 'asked'))).toBe(false);
    });
  },
);
