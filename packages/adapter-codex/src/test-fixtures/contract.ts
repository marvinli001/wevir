// CodexAdapter 三层契约测试（codex-adapter.contract*.test.ts）共用：引擎退出与资源释放的钩子、提示词与 mock 模型的
// 审批脚本。照 packages/adapter-dsh/src/test-fixtures/contract.ts。

import type { ContractOptions, ContractPrompts } from '@wevir/runtime-adapter/contract';
import type { CodexAdapter } from '../codex-adapter.js';
import { defaultMockScript, type MockScript, type MockToolCall } from './mock-model.js';

/** 适配器拉起过的 codex-app-server 进程（含自动重启的）的 pid。 */
const launched = new WeakMap<CodexAdapter, number[]>();

/** 记下适配器拉起的每个进程，`resourcesReleased` 据此确认它们都已退出。 */
export function trackProcesses(adapter: CodexAdapter): CodexAdapter {
  const pids: number[] = [];
  launched.set(adapter, pids);
  adapter.process.on('ready', ({ pid }) => void pids.push(pid));
  return adapter;
}

/**
 * 契约里“引擎退出”与“资源释放”两条用到的钩子：SIGKILL 当前进程（`CodexProcess` 照常自动重启，会话要 resume）；
 * dispose 之后进程状态为 disposed、网关关了、适配器不再记着会话、拉起过的进程都已退出。
 */
export const CODEX_CONTRACT_HOOKS: Pick<
  ContractOptions<CodexAdapter>,
  'simulateEngineExit' | 'resourcesReleased'
> = {
  simulateEngineExit: async (adapter) => {
    const pid = adapter.process.pid;
    if (pid === undefined) throw new Error('codex-app-server 没有在运行');
    process.kill(pid, 'SIGKILL');
  },
  resourcesReleased: (adapter) =>
    adapter.process.pid === undefined &&
    adapter.process.state === 'disposed' &&
    adapter.gateway === undefined &&
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

/** 审批用例的标记：mock 模型看到它就调一次越出沙箱的命令。 */
export const APPROVAL_MARKER = '[wevir:APPROVAL]';

/**
 * 越出沙箱的命令：`exec_command` 带 `sandbox_permissions: require_escalated` 与理由，Codex 执行之前请求审批
 * （codex-notes §2.3；工作区内的命令与补丁不需要审批）。
 */
export function escalatedCommand(
  cmd: string,
  justification = '需要在工作区之外写文件',
): MockToolCall {
  return {
    kind: 'function',
    name: 'exec_command',
    args: { cmd, sandbox_permissions: 'require_escalated', justification },
  };
}

/** 第 2 层的审批提示词：在工作区外（且不在系统临时目录）`touch` 一个文件。 */
export function approvalPrompt(target: string): string {
  return `${APPROVAL_MARKER} 在工作区之外创建 ${target}`;
}

/**
 * mock 模型的契约脚本：审批提示词先调一次越出沙箱的 `touch`，拿到结果后回一句话；其余交给默认脚本（`Say hello`
 * 一问一答，`Please call a tool` 在工作区里 `ls`）。
 */
export function contractScript(target: string): MockScript {
  return (view) => {
    if (!view.lastUserText.includes(APPROVAL_MARKER)) return defaultMockScript(view);
    if (view.toolOutputs.length > 0) return { text: ['命令已经', '处理完了。'], delayMs: 5 };
    return {
      text: ['这个文件在工作区之外，我申请一下权限。'],
      toolCalls: [escalatedCommand(`touch ${JSON.stringify(target)}`)],
      delayMs: 5,
    };
  };
}

/** 第 2 层（mock 模型）的提示词。plain 与 toolCall 用契约的默认提示词，按默认脚本作答。 */
export function mockContractPrompts(target: string): ContractPrompts {
  return {
    plain: 'Say hello',
    toolCall: 'Please call a tool',
    approval: approvalPrompt(target),
  };
}

/** 第 3 层（真实模型）的提示词。审批用例要一次越出沙箱的命令：工作区外、且不在系统临时目录的写入。 */
export function realContractPrompts(target: string): ContractPrompts {
  return {
    plain: '不要调用任何工具，只回复“你好”两个字。',
    toolCall:
      '用 shell 命令 `ls` 列出当前工作区的文件（不需要申请任何权限），然后用一句话告诉我结果。',
    approval: [
      `用 shell 命令 \`touch ${target}\` 创建这个文件。它在工作区之外，沙箱不允许写，`,
      '所以第一次调用就申请越出沙箱的权限（sandbox_permissions 设为 require_escalated），并写明理由。',
      '不要用 apply_patch，不要改用别的路径。完成后用一句话告诉我结果。',
    ].join(''),
  };
}
