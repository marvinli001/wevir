import { describe, expect, it } from 'vitest';
import { clampSidebarWidth, LAYOUT, type LayoutInput, planLayout } from './layout-rules';

const base: LayoutInput = {
  viewportWidth: 1280,
  sidebarWidth: LAYOUT.sidebarDefault,
  sidebarCollapsed: false,
  sidebarOverlayOpen: false,
  rightPanelOpen: false,
};

describe('clampSidebarWidth', () => {
  it('夹在 220–400 之间，非法值回到默认', () => {
    expect(clampSidebarWidth(100)).toBe(220);
    expect(clampSidebarWidth(999)).toBe(400);
    expect(clampSidebarWidth(301.6)).toBe(302);
    expect(clampSidebarWidth(Number.NaN)).toBe(LAYOUT.sidebarDefault);
  });
});

describe('planLayout', () => {
  it('1280：左栏停靠，右栏默认收起；打开后三栏都停靠', () => {
    expect(planLayout(base)).toEqual({
      sidebar: 'docked',
      sidebarWidth: 260,
      sidebarCanDock: true,
      rightPanel: 'hidden',
    });
    expect(planLayout({ ...base, rightPanelOpen: true }).rightPanel).toBe('docked');
  });

  it('窗口最小宽度 960 与放大后的 900：左栏仍停靠，右栏打开时改为浮层', () => {
    for (const viewportWidth of [960, 900]) {
      const plan = planLayout({ ...base, viewportWidth, rightPanelOpen: true });
      expect(plan).toMatchObject({ sidebar: 'docked', sidebarWidth: 260, rightPanel: 'overlay' });
      expect(viewportWidth - plan.sidebarWidth).toBeGreaterThanOrEqual(LAYOUT.centerMin);
    }
  });

  it('左栏不挤占中栏的 560：放宽到 400 的左栏在 900 下只停靠 340', () => {
    expect(planLayout({ ...base, viewportWidth: 900, sidebarWidth: 400 }).sidebarWidth).toBe(340);
  });

  it('右栏停靠的临界点：左栏 260 + 中栏 560 + 右栏 360 = 1180', () => {
    expect(planLayout({ ...base, viewportWidth: 1180, rightPanelOpen: true }).rightPanel).toBe(
      'docked',
    );
    expect(planLayout({ ...base, viewportWidth: 1179, rightPanelOpen: true }).rightPanel).toBe(
      'overlay',
    );
    // 左栏收起后中栏让出的空间够右栏停靠。
    expect(
      planLayout({ ...base, viewportWidth: 960, sidebarCollapsed: true, rightPanelOpen: true })
        .rightPanel,
    ).toBe('docked');
  });

  it('手动收起的左栏隐藏；放不下（< 780）时自动隐藏，只能以浮层打开', () => {
    expect(planLayout({ ...base, sidebarCollapsed: true }).sidebar).toBe('hidden');
    const narrow = planLayout({ ...base, viewportWidth: 760 });
    expect(narrow).toMatchObject({ sidebar: 'hidden', sidebarCanDock: false });
    expect(planLayout({ ...base, viewportWidth: 760, sidebarOverlayOpen: true }).sidebar).toBe(
      'overlay',
    );
    expect(planLayout({ ...base, viewportWidth: 780 }).sidebar).toBe('docked');
  });
});
