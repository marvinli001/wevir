// 插件页对 Host 的操作（0.42.0）：开关、输入项、卸载与删除。结果立即合进列表；改变成员的（删除、输入项）再重读一次，
// 不等 `plugins.changed`。失败原样抛出，由调用方显示。

import type { WevirClient } from '@wevir/client-sdk';
import type { Connector, Plugin, Skill } from '@wevir/protocol';
import { replaceConnector, replacePlugin, replaceSkill } from './plugins-model';
import type { PluginsData } from './use-plugins';

export async function setPluginEnabled(
  client: WevirClient,
  data: PluginsData,
  id: string,
  enabled: boolean,
): Promise<void> {
  const { plugin } = await client.request('plugin.setEnabled', { id, enabled });
  data.apply((list) => replacePlugin(list, plugin));
}

export async function setConnectorEnabled(
  client: WevirClient,
  data: PluginsData,
  id: string,
  enabled: boolean,
): Promise<void> {
  const { connector } = await client.request('connector.setEnabled', { id, enabled });
  data.apply((list) => replaceConnector(list, connector));
}

export async function setSkillEnabled(
  client: WevirClient,
  data: PluginsData,
  id: string,
  enabled: boolean,
): Promise<void> {
  const { skill } = await client.request('skill.setEnabled', { id, enabled });
  data.apply((list) => replaceSkill(list, skill));
}

/** 填写输入项：`values` 里字符串是新值，null（或空字符串）是清除。 */
export async function setPluginInputs(
  client: WevirClient,
  data: PluginsData,
  id: string,
  values: Record<string, string | null>,
): Promise<Plugin> {
  const { plugin } = await client.request('plugin.setInputs', { id, values });
  data.apply((list) => replacePlugin(list, plugin));
  // 缺输入项的连接器随之变化，这里一起重读。
  await data.refresh();
  return plugin;
}

export async function removePlugin(
  client: WevirClient,
  data: PluginsData,
  plugin: Pick<Plugin, 'id'>,
): Promise<void> {
  await client.request('plugin.remove', { id: plugin.id });
  await data.refresh();
}

export async function removeConnector(
  client: WevirClient,
  data: PluginsData,
  connector: Pick<Connector, 'id'>,
): Promise<void> {
  await client.request('connector.remove', { id: connector.id });
  await data.refresh();
}

export async function removeSkill(
  client: WevirClient,
  data: PluginsData,
  skill: Pick<Skill, 'id'>,
): Promise<void> {
  await client.request('skill.remove', { id: skill.id });
  await data.refresh();
}
