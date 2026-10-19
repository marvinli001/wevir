// SPDX-License-Identifier: MIT
// 应用级工具（0.30.0，domain-model §3.15，opencode-event-mapping.md §4.4）。opencode 1.x 一个服务器服务所有会话，MCP 服务按服务器
// 与目录登记，挂不到单个会话上，所以没法像别的引擎那样每个会话一个令牌。照 Paseo 的 OpenCode 桥：给 Wevir 起的服务器挂一个插件
// （`OPENCODE_CONFIG_CONTENT` 的 `plugin`，选项里是地址与引擎令牌，app-tools-plugin.ts），插件的工具执行时拿到 opencode 的会话 ID
// （`context.sessionID`），写进请求头调 Host；Host 把它映射回 Wevir 会话，再按那个会话套用工具与权限的规则。这里是插件文件的
// 生成、配置里的那一项与工具名的换算。

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  APP_TOOLS_NO_APPROVAL,
  APP_TOOLS_SERVER,
  type AppToolsEndpoint,
} from '@wevir/runtime-adapter';
import { appToolsPluginSource } from './app-tools-plugin.js';
import type { PermissionRuleset } from './sdk.js';

/** 插件文件所在的目录（`<数据目录>/engines/opencode/plugins`）。 */
export const PLUGIN_DIRECTORY = 'plugins';
/** 插件文件名的前缀；后面是内容的摘要。 */
export const PLUGIN_FILE_PREFIX = 'wevir-app-tools-';

/** opencode 配置 `plugin` 里的一项：插件地址与交给它的选项。 */
export type OpenCodePluginEntry = [string, Record<string, unknown>];

/** 交给插件的选项。 */
export interface AppToolsPluginOptions {
  /** Host 的 `/mcp`。 */
  url: string;
  /** 引擎令牌。 */
  token: string;
  /** 不经 opencode 权限系统的工具。 */
  noApproval: readonly string[];
}

/** Wevir 装的 zod 的 ESM 入口（绝对的 `file:` 地址）。 */
export function zodModuleUrl(): string {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve('zod/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    exports?: { '.'?: { import?: unknown } };
  };
  const entry = manifest.exports?.['.']?.import;
  if (typeof entry !== 'string') throw new Error('could not find the ESM entry of zod');
  return pathToFileURL(path.join(path.dirname(manifestPath), entry)).href;
}

/**
 * 把插件写进 `<engineDir>/plugins/wevir-app-tools-<摘要>.mjs`（内容不变就不重写），返回它的 `file:` 地址。文件里没有令牌：令牌经
 * 配置里的插件选项给。
 */
export function writeAppToolsPlugin(engineDir: string, zodUrl: string = zodModuleUrl()): string {
  const source = appToolsPluginSource(zodUrl);
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 16);
  const dir = path.join(engineDir, PLUGIN_DIRECTORY);
  const file = path.join(dir, `${PLUGIN_FILE_PREFIX}${hash}.mjs`);
  let current: string | undefined;
  try {
    current = readFileSync(file, 'utf8');
  } catch {
    current = undefined;
  }
  if (current !== source) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, source, { mode: 0o600 });
    renameSync(temp, file);
  }
  return pathToFileURL(file).href;
}

/** 配置 `plugin` 里的那一项。 */
export function appToolsPluginEntry(
  pluginUrl: string,
  endpoint: AppToolsEndpoint,
): OpenCodePluginEntry {
  const options: AppToolsPluginOptions = {
    url: endpoint.url,
    token: endpoint.token,
    noApproval: APP_TOOLS_NO_APPROVAL,
  };
  return [pluginUrl, { ...options }];
}

/** 是不是 Wevir 生成的插件（合并用户的 `plugin` 时去掉旧的）。 */
export function isAppToolsPlugin(entry: unknown): boolean {
  const spec = Array.isArray(entry) ? entry[0] : entry;
  return (
    typeof spec === 'string' && spec.includes(`/${PLUGIN_FILE_PREFIX}`) && spec.endsWith('.mjs')
  );
}

const APP_TOOL_PREFIX = `${APP_TOOLS_SERVER}_`;

/**
 * 工具名：插件的工具在 opencode 里叫 `wevir_session_list` 这样，报给 Host 时照别的引擎的 MCP 工具写成 `mcp__wevir__wevir_session_list`
 * （domain-model §7；桌面端按它认出应用级工具的审批）。别的工具名原样。
 */
export function engineToolName(tool: string): string {
  return tool.startsWith(APP_TOOL_PREFIX) ? `mcp__${APP_TOOLS_SERVER}__${tool}` : tool;
}

/** 列应用级工具最多等多久：Host 在同一台机器上，列不出来就当这次不藏（调用仍由 Host 按会话拒绝）。 */
export const APP_TOOLS_LIST_TIMEOUT_MS = 5000;

/**
 * Host 的 `tools/list`：这个令牌看得到的应用级工具名。会话自己的令牌按那个会话过滤（角色、工具预设、记忆开关）；引擎令牌不带会话
 * 头时是插件在服务器上挂的全部。
 */
export async function listAppToolNames(endpoint: AppToolsEndpoint): Promise<string[]> {
  const response = await fetch(endpoint.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${endpoint.token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    signal: AbortSignal.timeout(APP_TOOLS_LIST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Wevir app tools: HTTP ${response.status}`);
  const reply = (await response.json()) as { result?: { tools?: Array<{ name?: unknown }> } };
  return (reply.result?.tools ?? []).flatMap((tool) =>
    typeof tool.name === 'string' ? [tool.name] : [],
  );
}

/**
 * 这个会话看不到的应用级工具：插件挂的是一个服务器上所有会话共用的一份（引擎令牌列出的），Host 按会话过滤后的（会话令牌列出的）
 * 少掉的那些。会话的规则末尾给它们各写一条 `deny *`：opencode 按规则把整条 deny 的工具从这个会话发给模型的工具里去掉
 * （v1.19.3 `Permission.disabled`，`session/llm/request.ts` 的 `resolveTools`），子会话继承父会话的 deny。
 */
export function hiddenToolRules(hidden: readonly string[]): PermissionRuleset {
  return hidden.map((permission) => ({ permission, pattern: '*', action: 'deny' as const }));
}
