// 触发 dsh 审批的提示词与 mock 模型脚本（T3.3）。dsh 的审批只来自沙箱升级（acp-event-mapping.md §5）：工作区外、
// 且不在系统临时目录的写入先被沙箱拒绝，模型带 sandbox_permissions 重试才请求审批。目标目录用 outside-dir.ts 建。
// 审批的集成测试（dsh-adapter.approval.integration.test.ts）与契约测试（T3.6）共用。

import { type MockReply, type MockRequest, turnOf } from './mock-model.js';

/** 提示词里的标记，mock 模型据此认出本回合（`turnOf`）。 */
export const ESCALATION_MARKER = '[wevir:ESC]';

/** 与 T0.3 的 ESC 提示相同：要求在工作区外的绝对路径写文件，被沙箱拒绝后按提示升级重试。 */
export function escalationPrompt(path: string): string {
  return [
    `${ESCALATION_MARKER} 请用 write 工具在绝对路径 ${path} 创建文件，内容只有一行：hello。`,
    '这个路径在工作区之外，沙箱会先拒绝；被拒绝后请按工具提示带上 sandbox_permissions',
    '（取最窄的更高权限）和一句 justification 重试一次，这会向我申请审批。',
    '无论结果如何，最后用一句话告诉我文件是否已经写入。',
  ].join('');
}

/** mock 模型的 ESC 脚本（照 T0.3 `spikes/dsh-acp/src/scenarios.ts`）：写 → 沙箱拒绝则升级重试 → 汇报。 */
export function escalationScript(request: MockRequest): MockReply {
  const { prompt, toolResults: results } = turnOf(request, ESCALATION_MARKER);
  const path = /绝对路径 (\S+?) 创建/.exec(prompt)?.[1] ?? '';
  const write = { file_path: path, content: 'hello\n' };
  if (results.length === 0) return { toolCall: { name: 'write', arguments: write } };
  if (results.length === 1 && /sandbox/i.test(results[0] ?? '')) {
    return {
      toolCall: {
        name: 'write',
        arguments: {
          ...write,
          sandbox_permissions: 'danger-full-access',
          justification: '用户要求在工作区之外创建这个文件。',
        },
      },
    };
  }
  return { text: [`结果：${(results.at(-1) ?? '').slice(0, 120)}`] };
}
