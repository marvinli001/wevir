// 会话侧栏（U18，desktop-layout.md §12）的纯逻辑：停靠还是浮层、上下文的用量、路径与 token 数的写法。

import type { ProviderProfile, Session, Usage } from '@wevir/protocol';
import { PANE_LAYOUT } from './arrange';

/** 侧栏停靠时占内容区的宽：侧栏本身加它右边的间距。 */
export const RAIL_DOCKED_WIDTH = PANE_LAYOUT.railWidth + PANE_LAYOUT.gap;

/**
 * 侧栏停靠还是浮层（§12）：侧栏停靠后，主窗格仍不窄于最小宽、窗格区也不用改浮层才停靠，否则侧栏让位改浮层，窗格区按
 * 整宽排。`fitsWith(width)` 是按这个宽排窗格区的结果。
 */
export function railDocks(
  contentWidth: number,
  fitsWith: (width: number) => { mode: string; primaryWidth: number },
): boolean {
  const width = contentWidth - RAIL_DOCKED_WIDTH;
  if (width < PANE_LAYOUT.primaryMinWidth) return false;
  const plan = fitsWith(width);
  return plan.mode !== 'overlay' && plan.primaryWidth >= PANE_LAYOUT.primaryMinWidth;
}

export interface ContextUsage {
  used: number;
  size: number;
  /** 0–100，取整。 */
  percent: number;
  /** 会话的模型没有声明上下文长度，总量是引擎的估计。 */
  estimated: boolean;
}

export function contextUsage(
  usage: Usage | undefined,
  session: Pick<Session, 'providerId' | 'modelId'>,
  providers: readonly ProviderProfile[],
): ContextUsage | undefined {
  if (!usage || usage.contextSize <= 0) return undefined;
  const model = providers
    .find((provider) => provider.id === session.providerId)
    ?.models.find((candidate) => candidate.id === session.modelId);
  const percent = Math.min(100, Math.round((usage.contextUsed / usage.contextSize) * 100));
  return {
    used: usage.contextUsed,
    size: usage.contextSize,
    percent,
    estimated: model?.contextWindow === undefined,
  };
}

/** token 数：不到一千照写，再往上是 182.4k、1M（一位小数，去掉 .0）。 */
export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${trim(count / 1000)}k`;
  return `${trim(count / 1_000_000)}M`;
}

function trim(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}

/** 家目录写成 `~`（macOS 的 /Users/名字、Linux 的 /home/名字、Windows 的 C:\Users\名字）。 */
export function abbreviateHome(path: string): string {
  return path.replace(/^(?:\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=$|[/\\])/, '~');
}

/** 路径的上一级目录（“wevir · ~/Developer” 里的后半段）。 */
export function parentDirectory(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (index < 0) return trimmed;
  return index === 0 ? trimmed.slice(0, 1) : trimmed.slice(0, index);
}
