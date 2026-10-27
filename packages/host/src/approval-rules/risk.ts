// 审批的风险（0.131.0，Host 功能 `approval_risk`）：Host 替客户端判定哪些审批是高风险，手机据此在作答前要求验证本人（Face ID /
// 指纹），不在手机上另造规则。判定与“总是允许”的提议共用一套命令拆分（command-prefix.ts），宁可多判高风险也不漏：
// - 命令里有删改文件、进程或发往别处的程序（不提议作前缀的那一组），或改写历史、推送、删除、发布类的子命令：`destructive_command`；
// - `sudo` / `su` / `doas`：`privileged_command`；
// - 拆不开的命令（展开、重定向、子 shell、环境变量赋值…）：看不出会做什么，`unparsed_command`；
// - 要求在沙箱外执行（Codex 的 `sandbox_permissions: require_escalated`）：`outside_sandbox`。
// 读文件、改文件（补丁在卡片里看得到）与其余工具不判高风险。

import type { ApprovalDetail, ApprovalRisk, ApprovalRiskReason } from '@wevir/protocol';
import { basename, DESTRUCTIVE, RUNS_OTHER_PROGRAMS, splitShellCommand } from './command-prefix.js';
import { approvalCommand } from './service.js';

const PRIVILEGED = new Set(['sudo', 'su', 'doas']);

/** 有子命令的工具里改写历史、推送、删除或发布的子命令（出现在子命令位置上的任何一个词）。 */
const DESTRUCTIVE_SUBCOMMANDS = new Set([
  'push',
  'reset',
  'clean',
  'rebase',
  'restore',
  'filter-branch',
  'filter-repo',
  'update-ref',
  'prune',
  'delete',
  'rm',
  'rmi',
  'destroy',
  'uninstall',
  'publish',
  'unpublish',
  'deploy',
  'apply',
]);

/** 有子命令、子命令决定做什么的工具（与 command-prefix.ts 的 `SUBCOMMAND_TOOLS` 不同：这里只看会删改或发往别处的几个）。 */
const SUBCOMMAND_TOOLS = new Set([
  'git',
  'gh',
  'glab',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'cargo',
  'docker',
  'podman',
  'kubectl',
  'helm',
  'terraform',
  'brew',
  'pip',
  'pip3',
  'uv',
  'poetry',
  'wevir',
]);

/** 子命令位置上的词：工具名之后、第一个选项或路径之前的那几个。 */
function subcommands(argv: readonly string[]): string[] {
  const words: string[] = [];
  for (const token of argv.slice(1)) {
    if (!/^[A-Za-z][A-Za-z0-9._:-]*$/.test(token)) break;
    words.push(token);
    if (words.length === 3) break;
  }
  return words;
}

function commandReasons(argv: readonly string[], reasons: Set<ApprovalRiskReason>): void {
  const program = argv[0];
  if (program === undefined) return;
  const name = basename(program);
  if (PRIVILEGED.has(name)) reasons.add('privileged_command');
  if (DESTRUCTIVE.has(name)) reasons.add('destructive_command');
  if (SUBCOMMAND_TOOLS.has(name) && subcommands(argv).some((w) => DESTRUCTIVE_SUBCOMMANDS.has(w)))
    reasons.add('destructive_command');
  if (name === 'find' && argv.some((t) => t === '-delete' || t === '-exec' || t === '-execdir'))
    reasons.add('destructive_command');
  // 包一层再跑别的程序（`sudo rm`、`xargs rm`、`timeout 5 kill`）：被包的程序按同样的办法看。
  if (RUNS_OTHER_PROGRAMS.has(name) || PRIVILEGED.has(name)) {
    const inner = argv.findIndex(
      (token, i) => i > 0 && !token.startsWith('-') && !/^\d/.test(token) && !token.includes('='),
    );
    if (inner > 0) commandReasons(argv.slice(inner), reasons);
  }
}

/** 一条审批的风险；普通的返回 `undefined`。 */
export function approvalRisk(detail: ApprovalDetail | null | undefined): ApprovalRisk | undefined {
  if (detail === null || detail === undefined) return undefined;
  const reasons = new Set<ApprovalRiskReason>();
  if (detail.sandboxPermissions === 'require_escalated') reasons.add('outside_sandbox');
  const command = approvalCommand(detail);
  if (command !== undefined) {
    const commands = splitShellCommand(command);
    if (commands === null) reasons.add('unparsed_command');
    else for (const argv of commands) commandReasons(argv, reasons);
  }
  return reasons.size === 0 ? undefined : { level: 'high', reasons: [...reasons] };
}
