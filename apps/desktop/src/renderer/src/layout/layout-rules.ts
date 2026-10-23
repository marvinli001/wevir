// 侧栏的尺寸与折叠规则（T5.2）。纯函数，按视口宽度（CSS px）算出侧栏怎么摆；主窗格与窗格区的排布在
// arrange.ts（R12）。
//
// 窗口最小宽度是 960（main/index.ts）。界面放大（⌘+）后 CSS 宽度会比窗口更窄，所以这里不假设视口 ≥ 960：
// 主窗格要留出舒适宽度 560。侧栏放得下时停靠，宽度在 220–480 之间、且不挤占主窗格的 560；放不下（视口 < 780）
// 时自动隐藏，按钮改为以浮层打开。用户手动收起的状态会记住。默认 300，照 Claude Code 与 Codex 桌面端左栏的宽度（约 280
// 与 310）。
// 例：视口 1280、侧栏 300 → 停靠；视口 900、侧栏偏好 400 → 只停靠 340；视口 760 → 浮层。
//
// 设置页的左栏与这里的侧栏共用一个宽度偏好（settingsNavWidth），从对话进设置左栏的宽不变；视口 < 632 时设置页左栏也改成
// 浮层（settingsNavDocks）。

export const LAYOUT = {
  sidebarMin: 220,
  sidebarMax: 480,
  sidebarDefault: 300,
  /** 2026-10-15 以前的默认宽度；旧偏好里还是它的，当作没拖过，换成新的默认。 */
  legacySidebarDefault: 260,
  /** 侧栏能否停靠按主窗格的这个宽度算；窗格区停靠时主窗格可以更窄（arrange.ts 的 primaryMinWidth）。 */
  primaryComfortWidth: 560,
  /** 设置页左栏最窄的宽：视口窄到侧栏停靠不下时缩到这里为止。 */
  settingsNavMin: 192,
  /** 设置页内容列最窄的宽：左栏缩到最窄也留不出它时（手机、窄的浏览器窗口），左栏改成浮层。 */
  settingsContentMin: 440,
} as const;

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return LAYOUT.sidebarDefault;
  return Math.round(Math.min(LAYOUT.sidebarMax, Math.max(LAYOUT.sidebarMin, width)));
}

export interface SidebarInput {
  viewportWidth: number;
  /** 用户拖出来的侧栏宽度（记住的偏好）。 */
  sidebarWidth: number;
  /** 用户手动收起了侧栏（记住的偏好）。 */
  sidebarCollapsed: boolean;
  /** 侧栏放不下、被自动隐藏时，用户临时以浮层打开了它。 */
  sidebarOverlayOpen: boolean;
}

export type PaneMode = 'docked' | 'overlay' | 'hidden';

export interface SidebarPlan {
  sidebar: PaneMode;
  /** 侧栏实际宽度：停靠时可能比偏好窄（给主窗格让位），浮层时用偏好宽度。 */
  sidebarWidth: number;
  /** 侧栏能否停靠；不能时切换按钮控制浮层，而不是改“收起”偏好。 */
  sidebarCanDock: boolean;
}

export function planSidebar(input: SidebarInput): SidebarPlan {
  const preferred = clampSidebarWidth(input.sidebarWidth);
  const roomForSidebar = input.viewportWidth - LAYOUT.primaryComfortWidth;
  const sidebarCanDock = roomForSidebar >= LAYOUT.sidebarMin;

  if (!sidebarCanDock) {
    return {
      sidebar: input.sidebarOverlayOpen ? 'overlay' : 'hidden',
      sidebarWidth: preferred,
      sidebarCanDock,
    };
  }
  if (input.sidebarCollapsed) return { sidebar: 'hidden', sidebarWidth: preferred, sidebarCanDock };
  return { sidebar: 'docked', sidebarWidth: Math.min(preferred, roomForSidebar), sidebarCanDock };
}

/** 设置页左栏的宽：侧栏停靠得下时与停靠的侧栏一样宽；更窄的视口里最窄 settingsNavMin。 */
export function settingsNavWidth(viewportWidth: number, sidebarWidth: number): number {
  return Math.max(
    LAYOUT.settingsNavMin,
    Math.min(clampSidebarWidth(sidebarWidth), viewportWidth - LAYOUT.primaryComfortWidth),
  );
}

/** 设置页左栏能否停靠：左栏最窄时内容列还有 settingsContentMin；不能时左栏以浮层打开。 */
export function settingsNavDocks(viewportWidth: number): boolean {
  return viewportWidth >= LAYOUT.settingsNavMin + LAYOUT.settingsContentMin;
}
