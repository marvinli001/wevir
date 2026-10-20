// 插件页各个组件共用的东西（0.42.0）：当前列表、客户端、忙状态与通知。页面（plugins-page.tsx）提供，列表与详情取用，免得
// 一层层传 props。

import type { WevirClient } from '@wevir/client-sdk';
import type { Connector, Plugin, PluginsList } from '@wevir/protocol';
import { createContext, useContext } from 'react';
import type { Notice } from '@/settings/settings-ui';
import type { PluginsData } from './use-plugins';

export interface PluginsContextValue {
  client: WevirClient;
  /** 读到的列表（页面只在读到之后才渲染列表）。 */
  list: PluginsList;
  plugins: ReadonlyMap<string, Plugin>;
  /** 增删与方法结果合进列表的入口。 */
  data: PluginsData;
  /** 正在进行操作的项（开关等），控件在它进行期间不可用。 */
  busy: ReadonlySet<string>;
  /** 带忙状态地做一件事；失败时在列表上方出通知（`failure` 给出说法）。 */
  run(id: string, task: () => Promise<void>, failure: (error: string) => string): void;
  notify(notice: Notice | undefined): void;
  /** 回到“插件”分段并展开这个插件（连接器、Skills 详情里的“前往插件”）。 */
  openPlugin(pluginId: string): void;
  /** 打开连接器的编辑对话框。 */
  editConnector(connector: Connector): void;
  /** Host 支持只给某个项目的连接器（0.71.0 的 `external_import`）。 */
  scoped: boolean;
  /** 可选的项目（范围选择用），项目在前，“对话”在最后。 */
  workspaces: readonly { id: string; label: string }[];
}

export const PluginsContext = createContext<PluginsContextValue | undefined>(undefined);

export function usePluginsContext(): PluginsContextValue {
  const value = useContext(PluginsContext);
  if (!value) throw new Error('usePluginsContext 必须在插件页之内使用');
  return value;
}
