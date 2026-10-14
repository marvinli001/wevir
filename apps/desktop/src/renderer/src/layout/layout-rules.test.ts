import { describe, expect, it } from 'vitest';
import { clampSidebarWidth, LAYOUT, planSidebar, type SidebarInput } from './layout-rules';

const base: SidebarInput = {
  viewportWidth: 1280,
  sidebarWidth: LAYOUT.sidebarDefault,
  sidebarCollapsed: false,
  sidebarOverlayOpen: false,
};

describe('clampSidebarWidth', () => {
  it('夹在 220–400 之间，非法值回到默认', () => {
    expect(clampSidebarWidth(100)).toBe(220);
    expect(clampSidebarWidth(999)).toBe(400);
    expect(clampSidebarWidth(301.6)).toBe(302);
    expect(clampSidebarWidth(Number.NaN)).toBe(LAYOUT.sidebarDefault);
  });
});

describe('planSidebar', () => {
  it('1280：侧栏停靠', () => {
    expect(planSidebar(base)).toEqual({
      sidebar: 'docked',
      sidebarWidth: 260,
      sidebarCanDock: true,
    });
  });

  it('窗口最小宽度 960 与放大后的 900：侧栏仍停靠，主窗格留得出 560', () => {
    for (const viewportWidth of [960, 900]) {
      const plan = planSidebar({ ...base, viewportWidth });
      expect(plan).toMatchObject({ sidebar: 'docked', sidebarWidth: 260 });
      expect(viewportWidth - plan.sidebarWidth).toBeGreaterThanOrEqual(LAYOUT.primaryComfortWidth);
    }
  });

  it('侧栏不挤占主窗格的 560：放宽到 400 的侧栏在 900 下只停靠 340', () => {
    expect(planSidebar({ ...base, viewportWidth: 900, sidebarWidth: 400 }).sidebarWidth).toBe(340);
  });

  it('手动收起的侧栏隐藏；放不下（< 780）时自动隐藏，只能以浮层打开', () => {
    expect(planSidebar({ ...base, sidebarCollapsed: true }).sidebar).toBe('hidden');
    const narrow = planSidebar({ ...base, viewportWidth: 760 });
    expect(narrow).toMatchObject({ sidebar: 'hidden', sidebarCanDock: false });
    expect(planSidebar({ ...base, viewportWidth: 760, sidebarOverlayOpen: true }).sidebar).toBe(
      'overlay',
    );
    expect(planSidebar({ ...base, viewportWidth: 780 }).sidebar).toBe('docked');
  });
});
