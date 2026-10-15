// 会话侧栏（U18，desktop-layout.md §12）的纯逻辑：停靠还是浮层、上下文的用量、路径与 token 数的写法。

import type { ProviderProfile, Session, Usage } from '@wevir/protocol';
import { PANE_LAYOUT } from './arrange';

/** 侧栏停靠时占内容区的宽：侧栏本身加它右边的间距。 */
export const RAIL_DOCKED_WIDTH = PANE_LAYOUT.railWidth + PANE_LAYOUT.gap;

/** 停靠会话侧栏后主窗格还有这么宽，侧栏才默认显示（§12）。 */
export const RAIL_ROOMY_PRIMARY_WIDTH = 640;

/**
 * 会话侧栏有多少地方（§12）：`roomy` 停靠后主窗格仍不窄于 640，默认显示，开关记进偏好；`tight` 停靠后主窗格在 440–640
 * 之间，能停靠但默认收起，点按钮才停靠出来，不记住；`none` 停靠后主窗格窄于最小宽、或窗格区得改浮层，侧栏改浮层，窗格区
 * 按整宽排。`fitsWith(width)` 是按这个宽排窗格区的结果。例：侧栏 300 时窗口约 1240 以上 `roomy`。
 */
export type RailRoom = 'roomy' | 'tight' | 'none';

export function railRoom(
  contentWidth: number,
  fitsWith: (width: number) => { mode: string; primaryWidth: number },
): RailRoom {
  const width = contentWidth - RAIL_DOCKED_WIDTH;
  if (width < PANE_LAYOUT.primaryMinWidth) return 'none';
  const plan = fitsWith(width);
  if (plan.mode === 'overlay' || plan.primaryWidth < PANE_LAYOUT.primaryMinWidth) return 'none';
  return plan.primaryWidth >= RAIL_ROOMY_PRIMARY_WIDTH ? 'roomy' : 'tight';
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
