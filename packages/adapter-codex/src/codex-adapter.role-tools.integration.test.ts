// 角色对引擎自带工具的限制（`SessionConfig.engineTools`，codex-event-mapping.md §4.11）：真实 codex-app-server + 网关 + mock 模型。
// 关掉 shell 时发给模型的工具里没有执行命令的；关掉改文件时沙箱只读，apply_patch 新建文件不成、改文件的审批不报给用户。二进制不在时
// 跳过。

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentEvent, EngineToolLimits } from '@wevir/runtime-adapter';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { CodexAdapter } from './codex-adapter.js';
import {
  codexBinaryOrSkip,
  collectEvents,
  finishTurn,
  newAdapter,
  TempDirs,
} from './test-fixtures/harness.js';
import {
  MOCK_MODEL,
  type MockModel,
  type MockRequestBody,
  mockProvider,
  startMockModel,
} from './test-fixtures/mock-model.js';

const binary = codexBinaryOrSkip('adapter-codex 角色的工具限制');
const dirs = new TempDirs();
let mock: MockModel;
const adapters: CodexAdapter[] = [];

function toolNames(tools: MockRequestBody['tools']): string[] {
  return (tools ?? []).flatMap((tool) =>
    tool.type === 'namespace'
      ? ((tool.tools ?? []) as Array<{ name?: string }>).map((t) => `${tool.name}/${t.name}`)
      : [tool.name ?? tool.type],
  );
}

async function open(engineTools?: EngineToolLimits) {
  const { home, workspace } = dirs.make('role-tools');
  const adapter = newAdapter({ home, providers: [mockProvider(mock)] });
  adapters.push(adapter);
  const { engineSessionId } = await adapter.createSession({
    cwd: workspace,
    providerId: 'mock',
    modelId: MOCK_MODEL,
    ...(engineTools !== undefined && { engineTools }),
  });
  return {
    adapter,
    id: engineSessionId,
    events: collectEvents(adapter, engineSessionId),
    workspace,
  };
}

async function run(adapter: CodexAdapter, id: string, events: AgentEvent[], text: string) {
  const from = events.length;
  const before = mock.requests.length;
  await adapter.send(id, { content: [{ type: 'text', text }] });
  return { turn: await finishTurn(events, from), request: mock.requests[before] };
}

const SHELL_TOOLS = ['exec_command', 'write_stdin', 'shell', 'local_shell'];

describe.skipIf(binary === undefined)(
  'CodexAdapter 角色的工具限制（真实 codex-app-server）',
  { timeout: 90_000 },
  () => {
    beforeAll(async () => {
      mock = await startMockModel();
    });
    afterEach(async () => {
      await Promise.allSettled(adapters.splice(0).map((adapter) => adapter.dispose()));
    });
    afterAll(async () => {
      await mock?.close();
      dirs.cleanup();
    });

    it('关掉 shell：发给模型的工具里没有执行命令的；不限时有', async () => {
      const plain = await open();
      const control = await run(plain.adapter, plain.id, plain.events, '你好');
      expect(toolNames(control.request?.body.tools)).toContain('exec_command');

      const limited = await open({ denied: ['shell'], deniedNames: [] });
      const { request, turn } = await run(limited.adapter, limited.id, limited.events, '你好');
      expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
      const names = toolNames(request?.body.tools);
      expect(names.filter((name) => SHELL_TOOLS.includes(name))).toEqual([]);
      expect(names).toContain('apply_patch');
    });

    it('关掉改文件：只读沙箱，apply_patch 写不出文件，改文件的审批不报给用户', async () => {
      const plain = await open();
      await run(plain.adapter, plain.id, plain.events, '打个补丁');
      expect(existsSync(join(plain.workspace, 'wevir-mock.txt'))).toBe(true);

      const { adapter, id, events, workspace } = await open({ denied: ['edit'], deniedNames: [] });
      const { turn } = await run(adapter, id, events, '打个补丁');
      expect(turn.at(-1)).toMatchObject({ type: 'turn.settled', outcome: 'completed' });
      expect(turn.some((event) => event.type === 'approval.requested')).toBe(false);
      expect(existsSync(join(workspace, 'wevir-mock.txt'))).toBe(false);
    });
  },
);
