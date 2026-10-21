// 审批规则（0.80.0，domain-model §3.35）：规则存在 Host 的库里（0017_approval_rules），对所有引擎一样由 Host 匹配——引擎发来命令
// 审批时，命令的每一段都以某条对这个项目有效的规则的前缀开头，会话管理器就替用户选“允许”。Codex 也走这条路：它的
// `proposedExecpolicyAmendment` 只用来提议前缀，不回 `acceptWithExecpolicyAmendment`，所以规则删了立即生效、能按项目分，
// 也只放行本来就要审批的命令（不让 Codex 把同一前缀的命令都挪到沙箱外）。

import {
  APPROVAL_RULE_PROPOSALS_MAX,
  APPROVAL_RULE_SUGGESTIONS_MAX,
  type ApprovalDetail,
  type ApprovalId,
  type ApprovalRule,
  type ApprovalRuleId,
  type ApprovalRuleScope,
  type ApprovalRuleSuggestion,
  type SessionId,
  type WorkspaceId,
} from '@wevir/protocol';
import type { ApprovalRuleRecord, Storage } from '@wevir/storage';
import { HostError } from '../errors.js';
import { newId } from '../ids.js';
import {
  formatPrefix,
  isAcceptablePrefix,
  matchCommandPrefixes,
  proposePrefix,
  proposePrefixesForCommand,
  splitShellCommand,
  startsWithPrefix,
} from './command-prefix.js';

const COMMAND_PREFIX = 'command_prefix';
/** 建议规则时最多看最近多少条手动允许的审批。 */
const SUGGEST_SCAN_LIMIT = 2000;
/** 同一前缀至少手动允许过几次才建议。 */
const SUGGEST_MIN_COUNT = 2;

/** 工具调用里能按命令前缀匹配的命令：展示是命令一类且带命令原文时，优先取引擎给的原始输入。 */
export function approvalCommand(
  tool: Pick<ApprovalDetail, 'display' | 'input'> | undefined,
): string | undefined {
  if (tool === undefined) return undefined;
  const { display, input } = tool;
  if (display.command === undefined || !['shell', 'read', 'search'].includes(display.kind))
    return undefined;
  if (input !== null && typeof input === 'object') {
    const command = (input as Record<string, unknown>).command;
    if (typeof command === 'string') return command;
    if (
      Array.isArray(command) &&
      command.length > 0 &&
      command.every((t) => typeof t === 'string')
    ) {
      return formatPrefix(command);
    }
  }
  return display.command;
}

export interface RuleOrigin {
  sessionId: SessionId;
  approvalId: ApprovalId;
}

export class ApprovalRuleService {
  readonly #storage: Storage;
  readonly #now: () => Date;
  readonly #onChange: ((workspaceId: string | undefined) => void) | undefined;

  /** `onChange`：加了或删了规则（调优的档案据此通知 `tuning.changed`）；参数是规则所在的项目，全局规则是 `undefined`。 */
  constructor(options: {
    storage: Storage;
    now?: () => Date;
    onChange?: (workspaceId: string | undefined) => void;
  }) {
    this.#storage = options.storage;
    this.#now = options.now ?? (() => new Date());
    this.#onChange = options.onChange;
  }

  /** 给了项目只列对它有效的（全局的与它的），否则全部。 */
  list(workspaceId?: string): ApprovalRule[] {
    const records =
      workspaceId === undefined
        ? this.#storage.approvalRules.list()
        : this.#storage.approvalRules.listEffective(workspaceId);
    return records.filter((r) => r.kind === COMMAND_PREFIX).map(toRule);
  }

  add(prefix: readonly string[], workspaceId?: string): ApprovalRule {
    if (!isAcceptablePrefix(prefix)) {
      const message = `prefix cannot be an approval rule: ${formatPrefix(prefix)}`;
      throw new HostError('INVALID_PARAMS', message, { issues: [{ path: ['prefix'], message }] });
    }
    if (workspaceId !== undefined && this.#storage.workspaces.get(workspaceId) === undefined) {
      throw new HostError('WORKSPACE_NOT_FOUND', `workspace ${workspaceId} not found`);
    }
    const rule = toRule(this.#insert(prefix, workspaceId, 'suggestion'));
    this.#onChange?.(workspaceId);
    return rule;
  }

  delete(ruleId: string): boolean {
    const workspaceId = this.#storage.approvalRules.get(ruleId)?.workspaceId;
    const deleted = this.#storage.approvalRules.remove(ruleId);
    if (deleted) this.#onChange?.(workspaceId);
    return deleted;
  }

  /** 命令每一段都被对这个项目有效的规则允许时，返回用到的规则；否则 null。 */
  match(command: string, workspaceId: string | undefined): ApprovalRuleId[] | null {
    const rules = this.#effective(workspaceId);
    if (rules.length === 0) return null;
    const used = matchCommandPrefixes(
      command,
      rules.map((r) => r.prefix),
    );
    return used === null
      ? null
      : used.map((i) => (rules[i] as ApprovalRuleRecord).id as ApprovalRuleId);
  }

  recordUse(ruleIds: readonly string[]): void {
    this.#storage.approvalRules.recordUse(ruleIds, this.#now().toISOString());
  }

  /**
   * 给审批提议规则：命令里每一段还没被规则允许的各一个前缀。引擎自己提议了前缀（Codex 模型给的 `prefix_rule`）、命令只有一段、
   * 那个前缀比整条命令短且能作规则时用它，否则按 `proposePrefix`。
   */
  propose(
    command: string,
    workspaceId: string | undefined,
    hint?: readonly string[],
  ): string[][] | null {
    const existing = this.#effective(workspaceId).map((r) => r.prefix);
    if (hint !== undefined) {
      const commands = splitShellCommand(command);
      const [argv] = commands ?? [];
      if (
        commands?.length === 1 &&
        argv !== undefined &&
        hint.length < argv.length &&
        startsWithPrefix(argv, hint) &&
        isAcceptablePrefix(hint) &&
        !existing.some((prefix) => startsWithPrefix(argv, prefix))
      ) {
        return [[...hint]];
      }
    }
    const proposals = proposePrefixesForCommand(command, existing);
    return proposals !== null && proposals.length <= APPROVAL_RULE_PROPOSALS_MAX ? proposals : null;
  }

  /** 审批卡片上选了“总是允许”：按提议的前缀加规则，返回加的（或已有的）规则 ID。 */
  remember(
    prefixes: readonly (readonly string[])[],
    scope: ApprovalRuleScope,
    workspaceId: string | undefined,
    origin: RuleOrigin,
  ): ApprovalRuleId[] {
    const target = scope === 'project' ? workspaceId : undefined;
    const ids = this.#storage.transaction(() =>
      prefixes.map(
        (prefix) => this.#insert(prefix, target, 'approval', origin).id as ApprovalRuleId,
      ),
    );
    this.#onChange?.(target);
    return ids;
  }

  /**
   * 从历史建议规则：最近手动允许过的命令审批，按项目与提议的前缀归在一起，至少允许过两次、还没被规则允许的。按次数从多到少，
   * 次数相同的最近的在前。
   */
  suggest(workspaceId?: string): ApprovalRuleSuggestion[] {
    const approvals = this.#storage.approvals.listUserApproved({
      ...(workspaceId !== undefined && { workspaceId }),
      limit: SUGGEST_SCAN_LIMIT,
    });
    const effective = new Map<string, string[][]>();
    const rulesOf = (ws: string) => {
      let rules = effective.get(ws);
      if (rules === undefined) {
        rules = this.#effective(ws).map((r) => r.prefix);
        effective.set(ws, rules);
      }
      return rules;
    };
    const groups = new Map<string, ApprovalRuleSuggestion>();
    for (const approval of approvals) {
      const command = approvalCommand((approval.detail as ApprovalDetail | null) ?? undefined);
      if (command === undefined) continue;
      const commands = splitShellCommand(command);
      if (commands === null) continue;
      for (const argv of commands) {
        if (rulesOf(approval.workspaceId).some((prefix) => startsWithPrefix(argv, prefix)))
          continue;
        const prefix = proposePrefix(argv);
        if (prefix === null) continue;
        const key = `${approval.workspaceId}\0${JSON.stringify(prefix)}`;
        const group = groups.get(key);
        if (group === undefined) {
          // 最近的在前，第一次见到的就是最近的一次。
          groups.set(key, {
            prefix,
            workspaceId: approval.workspaceId as WorkspaceId,
            count: 1,
            lastApprovedAt: approval.resolvedAt ?? approval.createdAt,
            example: command,
          });
        } else {
          group.count += 1;
        }
      }
    }
    return [...groups.values()]
      .filter((group) => group.count >= SUGGEST_MIN_COUNT)
      .sort((a, b) => b.count - a.count || b.lastApprovedAt.localeCompare(a.lastApprovedAt))
      .slice(0, APPROVAL_RULE_SUGGESTIONS_MAX);
  }

  #effective(workspaceId: string | undefined): ApprovalRuleRecord[] {
    return this.#storage.approvalRules
      .listEffective(workspaceId)
      .filter((r) => r.kind === COMMAND_PREFIX);
  }

  #insert(
    prefix: readonly string[],
    workspaceId: string | undefined,
    source: 'approval' | 'suggestion',
    origin?: RuleOrigin,
  ): ApprovalRuleRecord {
    return this.#storage.approvalRules.insert({
      id: newId('arl'),
      ...(workspaceId !== undefined && { workspaceId }),
      kind: COMMAND_PREFIX,
      prefix: [...prefix],
      source,
      ...(origin !== undefined && {
        sourceSessionId: origin.sessionId,
        sourceApprovalId: origin.approvalId,
      }),
      createdAt: this.#now().toISOString(),
      useCount: 0,
    });
  }
}

function toRule(record: ApprovalRuleRecord): ApprovalRule {
  return {
    id: record.id as ApprovalRuleId,
    ...(record.workspaceId !== undefined && { workspaceId: record.workspaceId as WorkspaceId }),
    kind: record.kind,
    prefix: record.prefix,
    source: record.source,
    ...(record.sourceSessionId !== undefined && {
      sourceSessionId: record.sourceSessionId as SessionId,
    }),
    ...(record.sourceApprovalId !== undefined && {
      sourceApprovalId: record.sourceApprovalId as ApprovalId,
    }),
    createdAt: record.createdAt,
    useCount: record.useCount,
    ...(record.lastUsedAt !== undefined && { lastUsedAt: record.lastUsedAt }),
  };
}
