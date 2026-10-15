// 输入框的斜杠命令（U33，照 T3 Code 的 ComposerCommandMenu 与 composerSlashCommandSearch，MIT，ec1313c；外形照 Codex 桌面端）：
// 命令由所在的页面给出（会话页、草稿页、首页各有各的），这里是纯逻辑——输入框里 `/查询` 的菜单状态、按名字与中文名搜、
// 二级菜单（`/model 查询` 在模型里搜）。排序用 @wevir/protocol 的 scoreQueryMatch（移植自 T3）。

import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  type RankedSearchResult,
  scoreQueryMatch,
} from '@wevir/protocol';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/** 二级菜单里的一项（某个模型、某种权限模式）。 */
export interface ComposerCommandItem {
  id: string;
  label: string;
  /** 右边说明文字色的补充（模型所属的服务）。 */
  detail?: string;
  /** 左边的图标；省略时留空位。 */
  icon?: ReactNode;
  /** 当前选中的那项，右边打勾。 */
  checked?: boolean;
  disabled?: boolean;
  run: () => void;
}

/** 一条斜杠命令。 */
export interface ComposerCommand {
  /** 斜杠后面的名字（`model` → `/model`），只用小写字母与 `-`。 */
  name: string;
  /** 界面语言里的名称（“模型”）。 */
  label: string;
  icon: LucideIcon;
  /** 右边说明文字色的当前值（模型名、权限模式）。 */
  detail?: string;
  /**
   * 选中后做什么：`run` 执行（输入框里的 `/命令` 去掉）；`insert` 把 `/命令` 换成这段文字（光标在末尾，例如 `/btw `）；
   * `items` 打开二级菜单。
   */
  run?: () => void;
  insert?: string;
  items?: () => readonly ComposerCommandItem[];
  /** 也放进输入框左下角的“+”菜单。 */
  plus?: boolean;
}

export interface SlashMenuState {
  /** 一级：命令；二级：某条命令的选项。 */
  level: 'commands' | 'items';
  command?: ComposerCommand;
  query: string;
  /** `/…` 在文字里的范围，选中后替换它。 */
  rangeStart: number;
  rangeEnd: number;
}

/**
 * 输入框里的斜杠菜单：光标前面只有 `/查询`（前面可以有空白）时是一级菜单；`/命令 查询`、而这条命令有二级菜单时是二级菜单。
 * 光标后面还有文字、或不是这两种形状时 `undefined`。
 */
export function slashMenuState(
  text: string,
  cursor: number,
  commands: readonly ComposerCommand[],
): SlashMenuState | undefined {
  const before = text.slice(0, cursor);
  if (text.slice(cursor).trim() !== '') return undefined;
  const top = /^(\s*)\/(\S*)$/.exec(before);
  if (top) {
    const start = top[1]?.length ?? 0;
    return { level: 'commands', query: top[2] ?? '', rangeStart: start, rangeEnd: cursor };
  }
  const nested = /^(\s*)\/(\S+)[ \t]+([^\n]*)$/.exec(before);
  if (nested) {
    const command = commands.find((candidate) => candidate.name === nested[2]?.toLowerCase());
    if (!command?.items) return undefined;
    return {
      level: 'items',
      command,
      query: nested[3] ?? '',
      rangeStart: nested[1]?.length ?? 0,
      rangeEnd: cursor,
    };
  }
  return undefined;
}

function scoreName(value: string, query: string, base: number): number | null {
  return scoreQueryMatch({
    value: value.toLowerCase(),
    query,
    exactBase: base,
    prefixBase: base + 2,
    boundaryBase: base + 4,
    includesBase: base + 6,
    fuzzyBase: base + 100,
    boundaryMarkers: ['-', '_', '/', ' '],
  });
}

function rank<T>(
  items: readonly T[],
  query: string,
  score: (item: T, query: string) => number | null,
  tieBreaker: (item: T, index: number) => string,
): T[] {
  const normalized = normalizeSearchQuery(query, { trimLeadingPattern: /^\/+/ });
  if (normalized === '') return [...items];
  const ranked: RankedSearchResult<T>[] = [];
  items.forEach((item, index) => {
    const value = score(item, normalized);
    if (value === null) return;
    insertRankedSearchResult(
      ranked,
      { item, score: value, tieBreaker: tieBreaker(item, index) },
      Number.POSITIVE_INFINITY,
    );
  });
  return ranked.map((entry) => entry.item);
}

/** 按命令名与名称搜：名字的匹配优先；查询为空时按给出的顺序。 */
export function searchCommands(
  commands: readonly ComposerCommand[],
  query: string,
): ComposerCommand[] {
  return rank(
    commands,
    query,
    (command, normalized) => {
      const scores = [
        scoreName(command.name, normalized, 0),
        scoreName(command.label, normalized, 1),
      ];
      const valid = scores.filter((score): score is number => score !== null);
      return valid.length === 0 ? null : Math.min(...valid);
    },
    (_command, index) => String(index).padStart(4, '0'),
  );
}

/** 二级菜单按名称与补充搜，保持给出的顺序作同分的次序。 */
export function searchItems(
  items: readonly ComposerCommandItem[],
  query: string,
): ComposerCommandItem[] {
  return rank(
    items,
    query,
    (item, normalized) => {
      const scores = [
        scoreName(item.label, normalized, 0),
        scoreName(item.id, normalized, 1),
        item.detail === undefined ? null : scoreName(item.detail, normalized, 20),
      ];
      const valid = scores.filter((score): score is number => score !== null);
      return valid.length === 0 ? null : Math.min(...valid);
    },
    (_item, index) => String(index).padStart(4, '0'),
  );
}

/** 菜单里高亮的项：上下键移动时首尾相接。 */
export function nudge(index: number, delta: number, length: number): number {
  if (length === 0) return 0;
  return (((index + delta) % length) + length) % length;
}
