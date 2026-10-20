// 设置 → 导入（0.74.0）的纯逻辑：候选能不能勾、默认勾选与目标、改名校验、`import.apply` 的参数、结果汇总。界面在
// import-settings.tsx。

import {
  ConnectorNameSchema,
  type ImportApp,
  type ImportApplyItem,
  type ImportApplyResult,
  type ImportConnectorCandidate,
  type ImportKind,
  type ImportMemoryCandidate,
  type ImportScanResult,
  type ImportSkillCandidate,
  MemoryNameSchema,
  type WorkspaceId,
} from '@wevir/protocol';
import type { PlainMessageKey } from '@/i18n';

export const IMPORT_APPS = [
  'claude',
  'codex',
  'grok',
  'antigravity',
] as const satisfies readonly ImportApp[];

/** 应用名的文案 key（照原样写：Claude Code、Codex、Grok、Antigravity）。 */
export const IMPORT_APP_LABEL: Record<ImportApp, PlainMessageKey> = {
  claude: 'import.app.claude',
  codex: 'import.app.codex',
  grok: 'import.app.grok',
  antigravity: 'import.app.antigravity',
};

export const IMPORT_KINDS = [
  'memory',
  'connector',
  'skill',
] as const satisfies readonly ImportKind[];

export type ImportCandidate =
  | ImportMemoryCandidate
  | ImportConnectorCandidate
  | ImportSkillCandidate;

/** 目标：`global` 或某个工作区的 ID。Skills 没有目标。 */
export type ImportTarget = 'global' | (string & {});

export interface ImportRowState {
  checked: boolean;
  target: ImportTarget;
  /** 换的新名字（`exists` 时要填）；原样保存输入，校验与提交时去掉首尾空白。 */
  rename: string;
}

/** 按候选的 `key` 记的勾选、目标与新名字。 */
export type ImportSelection = Readonly<Record<string, ImportRowState>>;

export function candidatesOf(scan: ImportScanResult, kind: 'memory'): ImportMemoryCandidate[];
export function candidatesOf(scan: ImportScanResult, kind: 'connector'): ImportConnectorCandidate[];
export function candidatesOf(scan: ImportScanResult, kind: ImportKind): ImportCandidate[];
export function candidatesOf(scan: ImportScanResult, kind: ImportKind): ImportCandidate[] {
  switch (kind) {
    case 'memory':
      return scan.memories;
    case 'connector':
      return scan.connectors;
    case 'skill':
      return scan.skills;
  }
}

/** 每个候选与它的种类（按 key 查）。 */
export function candidateIndex(
  scan: ImportScanResult,
): Map<string, { kind: ImportKind; candidate: ImportCandidate }> {
  const index = new Map<string, { kind: ImportKind; candidate: ImportCandidate }>();
  for (const kind of IMPORT_KINDS) {
    for (const candidate of candidatesOf(scan, kind)) index.set(candidate.key, { kind, candidate });
  }
  return index;
}

/** 能勾：没有问题、不是“已导入”；Skills 不能改名，“已存在”的也不能勾。 */
export function selectable(kind: ImportKind, candidate: ImportCandidate): boolean {
  if (candidate.problem !== undefined || candidate.status === 'same') return false;
  return !(kind === 'skill' && candidate.status === 'exists');
}

/** 扫描建议的目标：记忆是项目范围且带项目时是那个项目；连接器带项目时是那个项目；其余全局。 */
export function suggestedTarget(kind: ImportKind, candidate: ImportCandidate): ImportTarget {
  if (kind === 'memory') {
    const memory = candidate as ImportMemoryCandidate;
    return memory.scope === 'project' && memory.workspaceId !== undefined
      ? memory.workspaceId
      : 'global';
  }
  if (kind === 'connector') return (candidate as ImportConnectorCandidate).workspaceId ?? 'global';
  return 'global';
}

/** 扫描后的初始状态：建议的、能勾、不用改名的默认勾上；目标取扫描的建议。 */
export function initialSelection(scan: ImportScanResult): ImportSelection {
  const selection: Record<string, ImportRowState> = {};
  for (const kind of IMPORT_KINDS) {
    for (const candidate of candidatesOf(scan, kind)) {
      selection[candidate.key] = {
        checked: candidate.recommended && selectable(kind, candidate) && candidate.status === 'new',
        target: suggestedTarget(kind, candidate),
        rename: '',
      };
    }
  }
  return selection;
}

export function rowState(selection: ImportSelection, key: string): ImportRowState {
  return selection[key] ?? { checked: false, target: 'global', rename: '' };
}

export function updateRow(
  selection: ImportSelection,
  key: string,
  patch: Partial<ImportRowState>,
): ImportSelection {
  return { ...selection, [key]: { ...rowState(selection, key), ...patch } };
}

/** 一组的全选框：全勾、部分、没勾；没有能勾的为 `none`。 */
export type GroupCheck = 'all' | 'some' | 'none';

export function groupCheck(
  kind: ImportKind,
  candidates: readonly ImportCandidate[],
  selection: ImportSelection,
): GroupCheck {
  const pickable = candidates.filter((candidate) => selectable(kind, candidate));
  const checked = pickable.filter((candidate) => rowState(selection, candidate.key).checked);
  if (checked.length === 0) return 'none';
  return checked.length === pickable.length ? 'all' : 'some';
}

/** 全选或全不选一组里能勾的。 */
export function setGroup(
  kind: ImportKind,
  candidates: readonly ImportCandidate[],
  selection: ImportSelection,
  checked: boolean,
): ImportSelection {
  let next = selection;
  for (const candidate of candidates) {
    if (selectable(kind, candidate)) next = updateRow(next, candidate.key, { checked });
  }
  return next;
}

export type RenameError = 'required' | 'invalid' | 'reserved' | 'unchanged';

/**
 * 新名字的问题：“已存在”的勾上时要填；填了就按种类的命名规则校验（记忆 `MemoryNameSchema`，连接器 `ConnectorNameSchema`、不以
 * wevir 开头），不能与原名相同。Skills 不能改名。
 */
export function renameError(
  kind: ImportKind,
  candidate: ImportCandidate,
  state: ImportRowState,
): RenameError | undefined {
  if (kind === 'skill' || !state.checked) return undefined;
  const name = state.rename.trim();
  if (name === '') return candidate.status === 'exists' ? 'required' : undefined;
  if (name === candidate.name) return 'unchanged';
  if (kind === 'connector') {
    if (name.toLowerCase().startsWith('wevir')) return 'reserved';
    return ConnectorNameSchema.safeParse(name).success ? undefined : 'invalid';
  }
  return MemoryNameSchema.safeParse(name).success ? undefined : 'invalid';
}

/** 勾上且能导入的候选。 */
function checkedEntries(scan: ImportScanResult, selection: ImportSelection) {
  return IMPORT_KINDS.flatMap((kind) =>
    candidatesOf(scan, kind)
      .filter(
        (candidate) => selectable(kind, candidate) && rowState(selection, candidate.key).checked,
      )
      .map((candidate) => ({ kind, candidate, state: rowState(selection, candidate.key) })),
  );
}

export function checkedCount(scan: ImportScanResult, selection: ImportSelection): number {
  return checkedEntries(scan, selection).length;
}

/** 勾上的条目里有没有新名字不合规的（有就不能提交）。 */
export function hasRenameErrors(scan: ImportScanResult, selection: ImportSelection): boolean {
  return checkedEntries(scan, selection).some(
    ({ kind, candidate, state }) => renameError(kind, candidate, state) !== undefined,
  );
}

/**
 * `import.apply` 的条目：记忆写明范围（项目范围带 `workspaceId`）；连接器全局写 `scope: 'global'`、项目只带 `workspaceId`；
 * Skills 只有 key。填了新名字才带 `name`。
 */
export function applyItems(scan: ImportScanResult, selection: ImportSelection): ImportApplyItem[] {
  return checkedEntries(scan, selection).map(({ kind, candidate, state }) => {
    const name = state.rename.trim();
    return {
      key: candidate.key,
      ...targetFields(kind, state.target),
      ...(kind !== 'skill' && name !== '' && { name }),
    };
  });
}

function targetFields(kind: ImportKind, target: ImportTarget): Omit<ImportApplyItem, 'key'> {
  if (kind === 'skill') return {};
  if (target === 'global') return { scope: 'global' };
  const workspaceId = target as WorkspaceId;
  return kind === 'memory' ? { scope: 'project', workspaceId } : { workspaceId };
}

/** 失败原因的文案 key；不认识的原因原样显示。 */
const REASON_LABEL: Record<string, PlainMessageKey> = {
  not_found: 'settings.import.reason.notFound',
  exists: 'settings.import.reason.exists',
  invalid_name: 'settings.import.reason.invalidName',
  limit: 'settings.import.reason.limit',
  no_workspace: 'settings.import.reason.noWorkspace',
  too_large: 'settings.import.reason.tooLarge',
  looks_secret: 'settings.import.reason.looksSecret',
  invalid: 'settings.import.reason.invalid',
  unsupported_transport: 'settings.import.reason.unsupportedTransport',
};

export function reasonLabel(reason: string): PlainMessageKey | undefined {
  return Object.hasOwn(REASON_LABEL, reason) ? REASON_LABEL[reason] : undefined;
}

export interface ImportFailure {
  key: string;
  kind?: ImportKind;
  name: string;
  reason?: string;
}

export interface ImportSummary {
  imported: number;
  skipped: number;
  failed: ImportFailure[];
}

/** 结果按结局计数；失败的逐条带名字（结果没给就取扫描里的原名，再没有就用 key）与原因。 */
export function summarize(result: ImportApplyResult, scan: ImportScanResult): ImportSummary {
  const index = candidateIndex(scan);
  const summary: ImportSummary = { imported: 0, skipped: 0, failed: [] };
  for (const item of result.results) {
    if (item.outcome === 'imported') summary.imported++;
    else if (item.outcome === 'skipped') summary.skipped++;
    else {
      const found = index.get(item.key);
      const kind = item.kind ?? found?.kind;
      summary.failed.push({
        key: item.key,
        name: item.name ?? found?.candidate.name ?? item.key,
        ...(kind !== undefined && { kind }),
        ...(item.reason !== undefined && { reason: item.reason }),
      });
    }
  }
  return summary;
}

/** 连接器候选有要填值的环境变量或请求头键。 */
export function needsValues(candidate: ImportConnectorCandidate): boolean {
  const config = candidate.config;
  if (config === undefined) return false;
  const keys = config.transport === 'stdio' ? config.env : config.headers;
  return keys !== undefined && Object.keys(keys).length > 0;
}
