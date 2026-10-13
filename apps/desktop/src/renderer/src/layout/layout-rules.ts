// 三栏布局的尺寸与折叠规则（T5.2）。纯函数，按视口宽度（CSS px）算出每栏怎么摆。
//
// 窗口最小宽度是 960（main/index.ts）：左栏最窄 220 + 中栏最窄 560 之外还留了拖动与边框的余量，右栏
// 收起。界面放大（⌘+）后 CSS 宽度会比窗口更窄，所以这里不假设视口 ≥ 960：
// 1. 中栏至少 560。左栏放得下时停靠，宽度在 220–400 之间、且不挤占中栏的 560；放不下（视口 < 780）
//    时自动隐藏，按钮改为以浮层打开。用户手动收起的状态会记住。
// 2. 右栏默认收起；打开时，左栏（停靠时的实际宽度）+ 中栏 560 + 右栏 360 放得下就停靠，否则以浮层
//    盖在中栏右侧，不挤压中栏。
// 例：视口 1280、左栏 260 → 三栏都停靠，中栏 660；视口 960 或 900 → 左栏停靠，右栏打开时为浮层。

export const LAYOUT = {
  sidebarMin: 220,
  sidebarMax: 400,
  sidebarDefault: 260,
  centerMin: 560,
  rightPanelWidth: 360,
} as const;

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return LAYOUT.sidebarDefault;
  return Math.round(Math.min(LAYOUT.sidebarMax, Math.max(LAYOUT.sidebarMin, width)));
}

export interface LayoutInput {
  viewportWidth: number;
  /** 用户拖出来的左栏宽度（记住的偏好）。 */
  sidebarWidth: number;
  /** 用户手动收起了左栏（记住的偏好）。 */
  sidebarCollapsed: boolean;
  /** 左栏放不下、被自动隐藏时，用户临时以浮层打开了它。 */
  sidebarOverlayOpen: boolean;
  rightPanelOpen: boolean;
}

export type PaneMode = 'docked' | 'overlay' | 'hidden';

export interface LayoutPlan {
  sidebar: PaneMode;
  /** 左栏实际宽度：停靠时可能比偏好窄（给中栏让位），浮层时用偏好宽度。 */
  sidebarWidth: number;
  /** 左栏能否停靠；不能时切换按钮控制浮层，而不是改“收起”偏好。 */
  sidebarCanDock: boolean;
  rightPanel: PaneMode;
}

export function planLayout(input: LayoutInput): LayoutPlan {
  const preferred = clampSidebarWidth(input.sidebarWidth);
  const roomForSidebar = input.viewportWidth - LAYOUT.centerMin;
  const sidebarCanDock = roomForSidebar >= LAYOUT.sidebarMin;

  let sidebar: PaneMode;
  let sidebarWidth = preferred;
  if (!sidebarCanDock) {
    sidebar = input.sidebarOverlayOpen ? 'overlay' : 'hidden';
  } else if (input.sidebarCollapsed) {
    sidebar = 'hidden';
  } else {
    sidebar = 'docked';
    sidebarWidth = Math.min(preferred, roomForSidebar);
  }

  let rightPanel: PaneMode = 'hidden';
  if (input.rightPanelOpen) {
    const occupied = sidebar === 'docked' ? sidebarWidth : 0;
    const fits = input.viewportWidth - occupied - LAYOUT.rightPanelWidth >= LAYOUT.centerMin;
    rightPanel = fits ? 'docked' : 'overlay';
  }

  return { sidebar, sidebarWidth, sidebarCanDock, rightPanel };
}
