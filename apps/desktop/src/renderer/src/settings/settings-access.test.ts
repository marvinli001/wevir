import type { Permission } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { DESKTOP_CAPABILITIES } from '@/platform/platform';
import { SETTINGS_TABS } from '@/routes/paths';
import { settingsTabVisible } from './settings-access';

const web = {
  ...DESKTOP_CAPABILITIES,
  localHost: false,
  localFiles: false,
  browserPane: false,
  computerUse: false,
  updates: false,
  preventSleep: false,
};

describe('settingsTabVisible', () => {
  it('桌面端的本机连接：每一页都在', () => {
    expect(
      SETTINGS_TABS.filter((tab) => settingsTabVisible(tab, DESKTOP_CAPABILITIES, () => true)),
    ).toEqual([...SETTINGS_TABS]);
  });

  it('浏览器里、默认权限的设备：管理类与本机的分页都不在', () => {
    const granted = new Set<Permission>(['session.read', 'session.write', 'workspace.read']);
    const visible = SETTINGS_TABS.filter((tab) =>
      settingsTabVisible(tab, web, (permission) => granted.has(permission)),
    );
    for (const hidden of [
      'storage',
      'devices',
      'providers',
      'web',
      'computerUse',
      'approvalRules',
      'import',
      'memory',
    ] as const) {
      expect(visible).not.toContain(hidden);
    }
    expect(visible).toContain('general');
    expect(visible).toContain('appearance');
    expect(visible).toContain('archived');
  });

  it('有 host.manage 的设备看得到管理页，电脑操作仍要外壳支持', () => {
    expect(settingsTabVisible('devices', web, () => true)).toBe(true);
    expect(settingsTabVisible('computerUse', web, () => true)).toBe(false);
  });
});
