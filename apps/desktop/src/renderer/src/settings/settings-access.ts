// 设置页哪些分页对这个外壳与这条连接有用（platform/platform.ts 的能力位，`host.hello` 的权限）。管理类的分页整页隐藏，不在
// 保存时才回 DEVICE_FORBIDDEN；本机连接与桌面端什么都看得到。

import type { Permission } from '@wevir/protocol';
import type { PlatformCapabilities } from '@/platform/platform';
import type { SettingsTab } from '@/routes/paths';

export function settingsTabVisible(
  tab: SettingsTab,
  platform: PlatformCapabilities,
  can: (permission: Permission) => boolean,
): boolean {
  switch (tab) {
    // 存储页是本机数据目录的占用与清理。
    case 'storage':
      return platform.localHost;
    // 设备与配对、联网搜索、导入、个性化、听写、记忆的改动都是 Host 管理（`host.manage`）。
    case 'devices':
    case 'web':
    case 'import':
    case 'personalization':
    case 'dictation':
    case 'memory':
      return can('host.manage');
    case 'computerUse':
      return platform.computerUse && can('host.manage');
    case 'providers':
      return can('provider.read');
    case 'approvalRules':
      return can('policy.write');
    default:
      return true;
  }
}
