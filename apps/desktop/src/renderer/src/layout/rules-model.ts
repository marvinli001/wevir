// 规则文件（0.68.0，Host 功能 `rule_files`）：会话侧栏“规则文件”卡片与接力预览里的一行一个文件。

import type { RuleFile, SessionRules } from '@wevir/protocol';
import { abbreviateHome } from './rail-model';

export type RuleRowStatus = 'engine' | 'wevir' | 'skipped';

/** 一行：显示的路径、完整路径与谁读的。 */
export interface RuleRow {
  key: string;
  /** 会话目录里的写相对路径，别处的把家目录缩成 `~`。 */
  name: string;
  path: string;
  status: RuleRowStatus;
  /** `skipped` 的原因（Host 给的开放字符串）。 */
  skipReason?: string;
  truncated: boolean;
  /** 由哪个文件 `@` 引入（显示的路径）。 */
  importedFrom?: string;
}

/** 按 Host 给的先后排出的行；不认识的 `delivery` 当作没加载。 */
export function ruleRows(rules: SessionRules, cwd: string): RuleRow[] {
  return rules.files.map((file, index) => ({
    key: `${index}:${file.path}`,
    name: displayRulePath(file.path, cwd),
    path: file.path,
    status: statusOf(file),
    ...(file.skipReason !== undefined && { skipReason: file.skipReason }),
    truncated: file.truncated === true,
    ...(file.importedFrom !== undefined && {
      importedFrom: displayRulePath(file.importedFrom, cwd),
    }),
  }));
}

/** 卡片收起时的摘要：真正加载了的文件数（引擎读的加 Wevir 补的）。 */
export function loadedRuleCount(rules: SessionRules): number {
  return rules.files.filter((file) => file.delivery === 'engine' || file.delivery === 'wevir')
    .length;
}

/** 会话目录里的写相对路径（`docs/rules.md`），别处的缩写家目录（`~/.claude/CLAUDE.md`）。 */
export function displayRulePath(path: string, cwd: string): string {
  const base = cwd.replace(/[/\\]+$/, '');
  if (path.startsWith(`${base}/`) || path.startsWith(`${base}\\`)) {
    return path.slice(base.length + 1);
  }
  return abbreviateHome(path);
}

function statusOf(file: RuleFile): RuleRowStatus {
  return file.delivery === 'engine' || file.delivery === 'wevir' ? file.delivery : 'skipped';
}
