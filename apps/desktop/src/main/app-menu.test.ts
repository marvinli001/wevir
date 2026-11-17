import { describe, expect, it } from 'vitest';
import { APP_MENU_LABEL_KEYS } from '../shared/desktop-api.js';
import {
  appMenuTemplate,
  DEFAULT_APP_MENU_LABELS,
  parseAppMenuLabels,
  parseAppMenuShortcuts,
} from './app-menu.js';

describe('app menu', () => {
  it('原生恢复菜单采用已校验的自定义组合键', () => {
    const shortcuts = { settings: 'CommandOrControl+,', restoreDefaultTheme: 'Control+Alt+L' };
    expect(parseAppMenuShortcuts(shortcuts)).toEqual(shortcuts);
    expect(
      parseAppMenuShortcuts({ settings: 'CommandOrControl+', restoreDefaultTheme: 'bad' }),
    ).toBeUndefined();
    const items = appMenuTemplate(
      DEFAULT_APP_MENU_LABELS,
      { openSettings() {}, checkForUpdates() {}, restoreDefaultTheme() {} },
      'darwin',
      shortcuts,
    );
    const view = items.find((item) => item.role === 'viewMenu');
    if (!view) throw new Error('view menu missing');
    const recovery = (view.submenu as Electron.MenuItemConstructorOptions[]).find(
      (item) => item.id === 'restore-default-theme',
    );
    expect(recovery?.accelerator).toBe('Control+Alt+L');
  });
  it.each(['darwin', 'win32', 'linux'] as const)(
    'has a native theme recovery action on %s',
    (platform) => {
      let restored = false;
      const items = appMenuTemplate(
        DEFAULT_APP_MENU_LABELS,
        {
          openSettings() {},
          checkForUpdates() {},
          restoreDefaultTheme() {
            restored = true;
          },
        },
        platform,
      );
      const view = items.find(
        (item) => item.role === 'viewMenu',
      ) as Electron.MenuItemConstructorOptions;
      const recovery = (view.submenu as Electron.MenuItemConstructorOptions[]).find(
        (item) => item.id === 'restore-default-theme',
      ) as Electron.MenuItemConstructorOptions;
      expect(recovery.label).toBe(DEFAULT_APP_MENU_LABELS.restoreDefaultTheme);
      expect(recovery.accelerator).toBe('CommandOrControl+Alt+Shift+0');
      expect(recovery.registerAccelerator).not.toBe(false);
      (recovery.click as () => void)();
      expect(restored).toBe(true);
      expect(items.some((item) => item.role === 'appMenu')).toBe(platform === 'darwin');
    },
  );
  it('收齐全部文字才接受，多余的键丢掉', () => {
    expect(parseAppMenuLabels(DEFAULT_APP_MENU_LABELS)).toEqual(DEFAULT_APP_MENU_LABELS);
    expect(parseAppMenuLabels({ ...DEFAULT_APP_MENU_LABELS, extra: 'x' })).toEqual(
      DEFAULT_APP_MENU_LABELS,
    );
    expect(parseAppMenuLabels({ ...DEFAULT_APP_MENU_LABELS, settings: ' ' })).toBeUndefined();
    expect(
      parseAppMenuLabels({ ...DEFAULT_APP_MENU_LABELS, quit: 'x'.repeat(101) }),
    ).toBeUndefined();
    const { about: _about, ...missing } = DEFAULT_APP_MENU_LABELS;
    expect(parseAppMenuLabels(missing)).toBeUndefined();
    expect(parseAppMenuLabels(null)).toBeUndefined();
    expect(Object.keys(DEFAULT_APP_MENU_LABELS).sort()).toEqual([...APP_MENU_LABEL_KEYS].sort());
  });

  it('应用菜单：关于、设置…（⌘, 只显示）、检查更新…，再是服务、隐藏、退出', () => {
    const calls: string[] = [];
    const [app] = appMenuTemplate(
      DEFAULT_APP_MENU_LABELS,
      {
        openSettings: () => calls.push('settings'),
        checkForUpdates: () => calls.push('check'),
        restoreDefaultTheme: () => calls.push('restore'),
      },
      'darwin',
    );
    const items = app?.submenu as Electron.MenuItemConstructorOptions[];
    expect(items.map((item) => item.role ?? item.label ?? item.type)).toEqual([
      'about',
      'separator',
      'Settings…',
      'Check for Updates…',
      'separator',
      'services',
      'separator',
      'hide',
      'hideOthers',
      'unhide',
      'separator',
      'quit',
    ]);
    const settings = items[2] as Electron.MenuItemConstructorOptions;
    const check = items[3] as Electron.MenuItemConstructorOptions;
    expect(settings).toMatchObject({ accelerator: 'Command+,', registerAccelerator: false });
    (settings.click as () => void)();
    (check.click as () => void)();
    expect(calls).toEqual(['settings', 'check']);
  });
});
