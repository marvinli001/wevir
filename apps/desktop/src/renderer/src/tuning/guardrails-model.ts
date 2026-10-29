// 档案里护栏层（0.86.0，desktop-layout.md §34）的纯逻辑：种类的名称、规则的参数摘要、编辑框的草稿与规则互转、仓库 hooks 的状态。

import {
  GUARDRAIL_COMMAND_MAX_LENGTH,
  GUARDRAIL_PATTERN_MAX_LENGTH,
  type Guardrail,
  type GuardrailKind,
  type GuardrailRule,
  type Hook,
  type ProfileLayer,
  type RepoHook,
  STOP_CHECK_ATTEMPTS_DEFAULT,
  STOP_CHECK_ATTEMPTS_MAX,
} from '@wevir/protocol';
import { type PlainMessageKey, t } from '@/i18n';

export const GUARDRAIL_KINDS = [
  'forbidden_command',
  'protected_path',
  'stop_check',
  'commit_check',
] as const satisfies readonly GuardrailKind[];

const KIND_KEYS = {
  forbidden_command: 'tuning.guardrails.kind.forbidden_command',
  protected_path: 'tuning.guardrails.kind.protected_path',
  stop_check: 'tuning.guardrails.kind.stop_check',
  commit_check: 'tuning.guardrails.kind.commit_check',
} as const satisfies Record<GuardrailKind, PlainMessageKey>;

/** 种类的名称；认不出的原样。 */
export function guardrailKindName(kind: string): string {
  return Object.hasOwn(KIND_KEYS, kind) ? t(KIND_KEYS[kind as GuardrailKind]) : kind;
}

/** 规则的参数摘要：命令模式（正则写成 `/…/`）、glob 或检查命令。 */
export function ruleSummary(rule: GuardrailRule): string {
  switch (rule.kind) {
    case 'forbidden_command':
      return rule.match === 'regex' ? `/${rule.pattern}/` : rule.pattern;
    case 'protected_path':
      return rule.glob;
    case 'stop_check':
    case 'commit_check':
      return rule.command;
  }
}

/** 行上的名称：有名字用名字，否则参数摘要。 */
export function guardrailLabel(guardrail: Pick<Guardrail, 'name' | 'rule'>): string {
  return guardrail.name ?? ruleSummary(guardrail.rule);
}

/** 编辑框的草稿：四种规则的参数都留着，切换种类不丢已填的。 */
export interface GuardrailDraft {
  /** 编辑时是原规则的 ID。 */
  id?: Guardrail['id'];
  kind: GuardrailKind;
  match: 'prefix' | 'regex';
  pattern: string;
  glob: string;
  command: string;
  maxAttempts: number;
  /** 原规则的时限（界面不改，保存时带回去）。 */
  timeoutSec?: number;
  scope: 'global' | 'project';
}

export function draftOf(guardrail?: Guardrail, scope: 'global' | 'project' = 'global') {
  const draft: GuardrailDraft = {
    kind: 'forbidden_command',
    match: 'prefix',
    pattern: '',
    glob: '',
    command: '',
    maxAttempts: STOP_CHECK_ATTEMPTS_DEFAULT,
    scope,
  };
  if (guardrail === undefined) return draft;
  const rule = guardrail.rule;
  draft.id = guardrail.id;
  draft.kind = rule.kind;
  draft.scope = guardrail.workspaceId === undefined ? 'global' : 'project';
  switch (rule.kind) {
    case 'forbidden_command':
      draft.match = rule.match;
      draft.pattern = rule.pattern;
      break;
    case 'protected_path':
      draft.glob = rule.glob;
      break;
    case 'stop_check':
      draft.command = rule.command;
      draft.maxAttempts = rule.maxAttempts ?? STOP_CHECK_ATTEMPTS_DEFAULT;
      if (rule.timeoutSec !== undefined) draft.timeoutSec = rule.timeoutSec;
      break;
    case 'commit_check':
      draft.command = rule.command;
      if (rule.timeoutSec !== undefined) draft.timeoutSec = rule.timeoutSec;
      break;
  }
  return draft;
}

/** 草稿对应的规则。 */
export function ruleOf(draft: GuardrailDraft): GuardrailRule {
  const timeout = draft.timeoutSec === undefined ? {} : { timeoutSec: draft.timeoutSec };
  switch (draft.kind) {
    case 'forbidden_command':
      return { kind: 'forbidden_command', match: draft.match, pattern: draft.pattern.trim() };
    case 'protected_path':
      return { kind: 'protected_path', glob: draft.glob.trim() };
    case 'stop_check':
      return {
        kind: 'stop_check',
        command: draft.command.trim(),
        maxAttempts: draft.maxAttempts,
        ...timeout,
      };
    case 'commit_check':
      return { kind: 'commit_check', command: draft.command.trim(), ...timeout };
  }
}

/** 正则的错误（不是正则或写对了时 `undefined`）。 */
export function regexError(draft: GuardrailDraft): string | undefined {
  if (draft.kind !== 'forbidden_command' || draft.match !== 'regex') return undefined;
  if (draft.pattern.trim() === '') return undefined;
  try {
    new RegExp(draft.pattern.trim());
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

/** 草稿能不能保存：当前种类的参数非空、不超长，正则写对。 */
export function draftValid(draft: GuardrailDraft): boolean {
  const value =
    draft.kind === 'forbidden_command'
      ? draft.pattern
      : draft.kind === 'protected_path'
        ? draft.glob
        : draft.command;
  const max =
    draft.kind === 'stop_check' || draft.kind === 'commit_check'
      ? GUARDRAIL_COMMAND_MAX_LENGTH
      : GUARDRAIL_PATTERN_MAX_LENGTH;
  const text = value.trim();
  return text !== '' && text.length <= max && regexError(draft) === undefined;
}

/** 结束前检查的次数选项。 */
export const STOP_ATTEMPT_OPTIONS = Array.from(
  { length: STOP_CHECK_ATTEMPTS_MAX },
  (_, i) => i + 1,
);

/**
 * hook 的显示：`来处 · 事件 · 命令`（不是命令 hook 的写处理器种类）。来处是文件；插件的是插件 ID，Wevir 自己的是名字，没有名字时
 * 省略。
 */
export function repoHookLabel(hook: RepoHook | Hook): string {
  const origin =
    hook.file ??
    ('pluginId' in hook && hook.pluginId !== undefined ? hook.pluginId : undefined) ??
    ('name' in hook ? hook.name : undefined);
  return [origin, hook.event, hook.command ?? hook.handler]
    .filter((part) => part !== undefined)
    .join(' · ');
}

/** 行右边的状态：不支持、内容变了；其余不写。 */
export function repoHookStatus(hook: RepoHook | Hook): string | undefined {
  if (hook.status === 'unsupported') return t('tuning.guardrails.hook.unsupported');
  if (hook.status === 'changed') return t('tuning.guardrails.hook.changed');
  return undefined;
}

/** 档案层里的审批规则条目（只读）。 */
export function approvalItems(layer: ProfileLayer) {
  return layer.items.filter((item) => item.detail === 'approval');
}
