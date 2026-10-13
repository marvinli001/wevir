// DshAdapter 三层契约测试（T3.6，dsh-adapter.contract*.test.ts）共用：临时目录、引擎退出与资源释放的钩子、
// 提示词与 mock Provider 的脚本。

import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderConfig } from '@wevir/runtime-adapter';
import type { ContractOptions, ContractPrompts } from '@wevir/runtime-adapter/contract';
import type { DshAdapter } from '../dsh-adapter.js';
import { ESCALATION_MARKER, escalationPrompt, escalationScript } from './escalation.js';
import {
  MOCK_KEY,
  MOCK_MODEL,
  type MockReply,
  type MockRequest,
  textOf,
  turnOf,
} from './mock-model.js';

/** 一个测试文件的临时目录：`dir(label)` 在同一个根下建子目录，`remove()` 在 afterAll 里整个删掉。 */
export function tempRoot(label: string): { dir: (sub: string) => string; remove: () => void } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `wevir-dsh-contract-${label}-`)));
  return {
    dir: (sub) => realpathSync(mkdtempSync(join(root, `${sub}-`))),
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** 适配器拉起过的 dsh 进程（含自动重启的）的 pid。 */
const launched = new WeakMap<DshAdapter, number[]>();

/** 记下适配器拉起的每个 dsh 进程，`resourcesReleased` 据此确认它们都已退出。 */
export function trackProcesses(adapter: DshAdapter): DshAdapter {
  const pids: number[] = [];
  launched.set(adapter, pids);
  adapter.process.on('ready', ({ pid }) => void pids.push(pid));
  return adapter;
}

/**
 * 契约里“引擎退出”与“资源释放”两条用到的钩子：SIGKILL 当前的 dsh 进程（`DshProcess` 照常自动重启，会话要
 * resume）；dispose 之后进程状态为 disposed、适配器不再记着会话、拉起过的进程都已退出。
 */
export const DSH_CONTRACT_HOOKS: Pick<
  ContractOptions<DshAdapter>,
  'simulateEngineExit' | 'resourcesReleased'
> = {
  simulateEngineExit: async (adapter) => {
    const pid = adapter.process.pid;
    if (pid === undefined) throw new Error('dsh 进程没在运行');
    process.kill(pid, 'SIGKILL');
  },
  resourcesReleased: (adapter) =>
    adapter.process.state === 'disposed' &&
    adapter.sessionCount === 0 &&
    (launched.get(adapter) ?? []).every(exited),
};

function exited(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

const PLAIN = '[wevir:PLAIN]';
const TOOL = '[wevir:TOOL]';
/** toolCall 提示让模型在工作区里写的文件（相对路径，workspace-write 下不需要审批）。 */
export const TOOL_FILE = 'contract-tool.txt';

/** 第 2 层（mock Provider）的提示词：带标记，`contractScript` 按标记作答。`outsideTarget` 是审批用例要写的文件。 */
export function mockContractPrompts(outsideTarget: string): ContractPrompts {
  return {
    plain: `${PLAIN} 打个招呼。`,
    toolCall: `${TOOL} 用 write 工具在工作区里创建 ${TOOL_FILE}，内容是 ok。`,
    approval: escalationPrompt(outsideTarget),
  };
}

/** 第 3 层（真实模型）的提示词。审批用例与 T3.3 相同：工作区外、且不在系统临时目录的写入。 */
export function realContractPrompts(outsideTarget: string): ContractPrompts {
  return {
    plain: '不要调用任何工具，只回复“你好”两个字。',
    toolCall: [
      `直接调用 write 工具（不要先读取或检查任何文件），在当前工作区创建文件 ${TOOL_FILE}，`,
      '内容只有一行：ok。写完后用一句话告诉我结果。',
    ].join(''),
    approval: escalationPrompt(outsideTarget),
  };
}

/**
 * mock 模型的契约脚本：最后一条带标记的用户消息决定本回合怎么答。plain 先逐片发思考、再逐片发文本（有间隔，
 * 旁路的增量先于已提交消息到达）；toolCall 先调一次 write，拿到结果后回一句话；审批走 T3.3 的 ESC 脚本。
 */
export function contractScript(request: MockRequest): MockReply {
  const markers = [PLAIN, TOOL, ESCALATION_MARKER];
  const last = request.messages.findLast(
    (m) => m.role === 'user' && markers.some((marker) => textOf(m.content).includes(marker)),
  );
  const prompt = textOf(last?.content);
  if (prompt.includes(ESCALATION_MARKER)) return escalationScript(request);
  if (prompt.includes(TOOL)) {
    return turnOf(request, TOOL).toolResults.length === 0
      ? { toolCall: { name: 'write', arguments: { file_path: TOOL_FILE, content: 'ok\n' } } }
      : { text: ['写好了。'] };
  }
  return {
    reasoning: ['想一想', '怎么回答。'],
    text: ['你好，', '这是', ' mock 的回答。'],
    delayMs: 20,
  };
}

/** 指向本地 mock 的 Provider，经 `DshAdapter` 的 Provider 桥接（T3.4）交给 dsh，与 Host 的路径相同。 */
export function mockProvider(baseURL: string): ProviderConfig {
  return {
    id: 'wevir-test',
    kind: 'openai-compatible',
    displayName: 'Wevir Test',
    api: 'openai-completions',
    baseURL,
    models: [{ id: MOCK_MODEL }],
    defaultModelId: MOCK_MODEL,
    apiKey: MOCK_KEY,
  };
}
