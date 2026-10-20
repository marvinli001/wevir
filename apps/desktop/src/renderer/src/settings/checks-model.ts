// 设置 → 项目 → 检查（0.65.0）的表单逻辑：草稿与 `checks.save` 的输入互转、候选命令转成检查。

import type {
  CheckCandidate,
  CheckDefinition,
  CheckInput,
  CheckKind,
  CheckTrigger,
} from '@wevir/protocol';
import {
  CHECK_COMMAND_MAX_LENGTH,
  CHECK_NAME_MAX_LENGTH,
  CHECK_PATHS_MAX,
  CHECK_TIMEOUT_DEFAULT_MS,
  CHECK_TIMEOUT_MAX_MS,
  CHECK_TIMEOUT_MIN_MS,
} from '@wevir/protocol';
import type { PlainMessageKey } from '@/i18n';

export const KIND_LABELS: Record<CheckKind, PlainMessageKey> = {
  test: 'settings.checks.kind.test',
  build: 'settings.checks.kind.build',
  typecheck: 'settings.checks.kind.typecheck',
  lint: 'settings.checks.kind.lint',
  other: 'settings.checks.kind.other',
};

export const TRIGGER_LABELS: Record<CheckTrigger, PlainMessageKey> = {
  manual: 'settings.checks.trigger.manual',
  after_turn: 'settings.checks.trigger.after_turn',
};

export interface CheckDraft {
  id?: CheckDefinition['id'];
  name: string;
  command: string;
  cwd: string;
  kind: CheckKind;
  trigger: CheckTrigger;
  /** 逗号或换行分隔。 */
  paths: string;
  /** 分钟，文本框里的原样。 */
  timeout: string;
  expectOutput: string;
  source: CheckInput['source'];
}

export function draftOf(check?: CheckDefinition): CheckDraft {
  if (check === undefined) {
    return {
      name: '',
      command: '',
      cwd: '',
      kind: 'test',
      trigger: 'manual',
      paths: '',
      timeout: String(CHECK_TIMEOUT_DEFAULT_MS / 60_000),
      expectOutput: '',
      source: { kind: 'user' },
    };
  }
  const { source } = check;
  return {
    id: check.id,
    name: check.name,
    command: check.command,
    cwd: check.cwd,
    kind: check.kind,
    trigger: check.trigger,
    paths: (check.paths ?? []).join(', '),
    timeout: String(Math.round((check.timeoutMs / 60_000) * 100) / 100),
    expectOutput: check.expectOutput ?? '',
    // 保存时 Host 重新读脚本正文、记下散列（等于重新认可）。
    source:
      source.kind === 'package_script'
        ? { kind: 'package_script', file: source.file, script: source.script }
        : source,
  };
}

/** 候选命令 → 草稿（还要用户保存才算检查）。 */
export function draftOfCandidate(candidate: CheckCandidate): CheckDraft {
  const { source } = candidate;
  return {
    ...draftOf(),
    name: candidate.name,
    command: candidate.command,
    cwd: candidate.cwd,
    kind: candidate.kind,
    source:
      source.kind === 'package_script'
        ? { kind: 'package_script', file: source.file, script: source.script }
        : { kind: 'instructions', file: source.file },
  };
}

export function parsePaths(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function timeoutMs(text: string): number | undefined {
  const minutes = Number(text.trim());
  if (text.trim() === '' || !Number.isFinite(minutes)) return undefined;
  const ms = Math.round(minutes * 60_000);
  return ms >= CHECK_TIMEOUT_MIN_MS && ms <= CHECK_TIMEOUT_MAX_MS ? ms : undefined;
}

export function draftValid(draft: CheckDraft): boolean {
  const paths = parsePaths(draft.paths);
  return (
    draft.name.trim() !== '' &&
    draft.name.trim().length <= CHECK_NAME_MAX_LENGTH &&
    draft.command.trim() !== '' &&
    draft.command.trim().length <= CHECK_COMMAND_MAX_LENGTH &&
    paths.length <= CHECK_PATHS_MAX &&
    timeoutMs(draft.timeout) !== undefined
  );
}

export function inputOf(draft: CheckDraft): CheckInput {
  const paths = parsePaths(draft.paths);
  const expect = draft.expectOutput.trim();
  return {
    ...(draft.id !== undefined && { id: draft.id }),
    name: draft.name.trim(),
    command: draft.command.trim(),
    cwd: draft.cwd.trim(),
    kind: draft.kind,
    trigger: draft.trigger,
    timeoutMs: timeoutMs(draft.timeout) ?? CHECK_TIMEOUT_DEFAULT_MS,
    ...(paths.length > 0 && { paths }),
    ...(expect !== '' && { expectOutput: expect }),
    ...(draft.source !== undefined && { source: draft.source }),
  };
}

/** 检查的来源（列表里命令下面那一行）：用户写的没有。 */
export function sourceText(check: Pick<CheckDefinition, 'source'>): string | undefined {
  const { source } = check;
  if (source.kind === 'package_script') return `${source.file} · ${source.script}`;
  if (source.kind === 'instructions') return source.file;
  return undefined;
}

/** 候选是不是已经保存成检查了（同目录、同命令）。 */
export function candidateSaved(
  candidate: CheckCandidate,
  checks: readonly CheckDefinition[],
): boolean {
  return checks.some((check) => check.cwd === candidate.cwd && check.command === candidate.command);
}
