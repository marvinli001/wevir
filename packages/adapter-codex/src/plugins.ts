// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 OpenAI
// 改写自 openai/codex（092d3acd6bec3e3a14bdc7e7a2810ab628ab759d）codex-rs/config/src/{mcp_types,skills_config}.rs 与
// app-server-protocol/src/protocol/v2/{plugin,mcp,config}.rs。
// 修改：只取 Host 的配置子集，默认禁用外部 skills，保留内置 MCP；状态只投影非敏感字段。

import { dirname } from 'node:path';
import type {
  EngineConnectorStatus,
  EngineMcpConfig,
  EnginePluginConfig,
  EnginePluginSource,
} from '@wevir/runtime-adapter';
import type { CodexProcess } from './codex-process.js';
import { tomlString, tomlValue } from './config.js';

export function connectorConfig(
  config: EngineMcpConfig,
  enabled: boolean,
): Record<string, unknown> {
  return {
    ...(config.transport === 'stdio'
      ? {
          command: config.command,
          ...(config.args !== undefined && { args: config.args }),
          ...(config.env !== undefined && { env: config.env }),
          ...(config.cwd !== undefined && { cwd: config.cwd }),
        }
      : { url: config.url, ...(config.headers !== undefined && { http_headers: config.headers }) }),
    enabled,
    ...(config.toolTimeoutSec !== undefined && { tool_timeout_sec: config.toolTimeoutSec }),
    // prompt 让用户工具默认请求审批；full_access 的 approval_policy=never 时仍按会话模式放行。
    default_tools_approval_mode: 'prompt',
  };
}

/**
 * 只给一个 thread 的连接器（0.74.0，项目范围）：`thread/start` / `thread/resume` / `thread/fork` 的 `config` 覆盖里的
 * `mcp_servers.<名字>`，和应用级工具的挂法一样；环境变量与请求头的值交给 `secret` 打码。
 */
export function threadConnectorsConfig(
  connectors: EnginePluginConfig['connectors'],
  secret: (value: string) => void,
): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  for (const item of connectors) {
    for (const value of Object.values(
      item.config.transport === 'stdio' ? (item.config.env ?? {}) : (item.config.headers ?? {}),
    ))
      if (value !== '') secret(value);
    config[`mcp_servers.${item.name}`] = connectorConfig(item.config, item.enabled);
  }
  return config;
}

export function pluginsToml(toml: string, config: EnginePluginConfig | undefined): string {
  if (config === undefined) return toml;
  return [
    toml.replace('include_instructions = false', 'include_instructions = true'),
    ...config.skills.flatMap((skill) => [
      '',
      '[[skills.config]]',
      `path = ${tomlString(skill.path)}`,
      `enabled = ${skill.enabled}`,
    ]),
    ...config.connectors.flatMap((item) => [
      '',
      `[mcp_servers.${item.name}]`,
      ...Object.entries(connectorConfig(item.config, item.enabled)).map(
        ([key, value]) => `${key} = ${pluginTomlValue(value)}`,
      ),
    ]),
    '',
  ].join('\n');
}

function pluginTomlValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(pluginTomlValue).join(', ')}]`;
  if (value !== null && typeof value === 'object')
    return `{ ${Object.entries(value)
      .map(([key, item]) => `${tomlString(key)} = ${pluginTomlValue(item)}`)
      .join(', ')} }`;
  return tomlValue(value);
}

interface SkillsList {
  data: Array<{ skills: Array<{ path: string; name: string; enabled: boolean }> }>;
}
interface StatusList {
  data: Array<{
    name: string;
    runtimeStatus: string | null;
    authStatus?: string;
    tools: Record<string, { name: string; description?: string }>;
  }>;
  nextCursor?: string | null;
}

export class CodexPlugins {
  source: EnginePluginSource | undefined;
  readonly #process: CodexProcess;
  readonly #threads: () => Array<{ id: string; cwd: string }>;
  readonly #secret: (value: string) => void;
  #queue: Promise<unknown> = Promise.resolve();
  #applied = '';
  #generation = 0;
  #names = new Set<string>();
  #roots = '';
  #enabledNames = new Set<string>();
  /**
   * 上次应用成功时的配置与列过 skill 的目录。Codex 报 `skills/changed`、进程换代时清掉。见 `#sync`。
   */
  #listed: { config: string; cwds: Set<string> } | undefined;
  /** 收到过几次 `skills/changed`：列的时候收到的，这次列的结果不记。 */
  #skillsChanges = 0;

  constructor(
    process: CodexProcess,
    threads: () => Array<{ id: string; cwd: string }>,
    secret: (value: string) => void,
  ) {
    this.#process = process;
    this.#threads = threads;
    this.#secret = secret;
  }

  notification(method: string): void {
    if (method === 'skills/changed') {
      this.#listed = undefined;
      this.#skillsChanges += 1;
    }
    if (method === 'skills/changed' || method === 'mcpServer/startupStatus/updated')
      this.source?.changed();
  }

  hasConnector(name: string): boolean {
    return this.#enabledNames.has(name);
  }

  sync(cwd?: string): Promise<void> {
    const result = this.#queue.then(() => this.#sync(cwd));
    this.#queue = result.catch(() => {});
    return result;
  }

  async #sync(cwd?: string): Promise<void> {
    if (!this.source || this.#process.state !== 'ready') return;
    if (this.#generation !== this.#process.generation) {
      this.#generation = this.#process.generation;
      this.#applied = '';
      this.#names.clear();
      this.#enabledNames.clear();
      this.#roots = '';
      this.#listed = undefined;
    }
    const config = await this.source.read(cwd);
    const configKey = JSON.stringify(config);
    const extraRoots = [
      ...new Set([
        config.skillsRoot,
        ...config.skills.filter((skill) => skill.enabled).map((skill) => dirname(skill.path)),
      ]),
    ];
    const rootsKey = JSON.stringify(extraRoots);
    if (this.#roots !== rootsKey) {
      await this.#process.request('skills/extraRoots/set', { extraRoots });
      this.#roots = rootsKey;
    }
    const open = new Set(this.#threads().map((thread) => thread.cwd));
    const cwds = [...new Set([...(cwd === undefined ? [] : [cwd]), ...open])];
    // 不再列一遍 skill（Codex 那边 forceReload 要重读全部 SKILL.md）：配置没变、上次列过这些目录、之后 Codex 没报
    // skills/changed，而且这些目录都开着 thread。Codex 只盯着开着的 thread 的 skill 目录，没开 thread 的目录里新加的 skill
    // 不会通知，要重列，免得没登记的外部 skill 在新 thread 里按默认开着。
    const listed = this.#listed;
    if (
      listed !== undefined &&
      listed.config === configKey &&
      cwds.every((dir) => open.has(dir) && listed.cwds.has(dir))
    ) {
      return;
    }
    const changes = this.#skillsChanges;
    const remember = () => {
      if (changes === this.#skillsChanges)
        this.#listed = { config: configKey, cwds: new Set(cwds) };
    };
    const listing = await this.#process.request<SkillsList>('skills/list', {
      cwds,
      forceReload: true,
    });
    const rules = new Map(config.skills.map((skill) => [skill.path, skill.enabled]));
    for (const skill of listing.data.flatMap((entry) => entry.skills))
      if (!rules.has(skill.path)) rules.set(skill.path, false);
    const effective = {
      connectors: config.connectors,
      rules: [...rules].sort(([a], [b]) => a.localeCompare(b)),
    };
    const fingerprint = JSON.stringify(effective);
    if (fingerprint === this.#applied) {
      remember();
      return;
    }
    const names = new Set(config.connectors.map((item) => item.name));
    const edits: Array<{ keyPath: string; value: unknown; mergeStrategy: 'replace' }> = [
      { keyPath: 'skills.include_instructions', value: true, mergeStrategy: 'replace' },
      {
        keyPath: 'skills.config',
        value: effective.rules.map(([path, enabled]) => ({ path, enabled })),
        mergeStrategy: 'replace',
      },
    ];
    for (const name of this.#names)
      if (!names.has(name))
        edits.push({ keyPath: `mcp_servers.${name}`, value: null, mergeStrategy: 'replace' });
    for (const secret of config.secrets ?? []) this.#secret(secret);
    for (const item of config.connectors) {
      for (const secret of Object.values(
        item.config.transport === 'stdio' ? (item.config.env ?? {}) : (item.config.headers ?? {}),
      ))
        this.#secret(secret);
      edits.push({
        keyPath: `mcp_servers.${item.name}`,
        value: connectorConfig(item.config, item.enabled),
        mergeStrategy: 'replace',
      });
    }
    await this.#process.request('config/batchWrite', { edits, reloadUserConfig: true });
    await this.#process.request('config/mcpServer/reload', undefined);
    this.#names = names;
    this.#enabledNames = new Set(
      config.connectors.filter((item) => item.enabled).map((item) => item.name),
    );
    this.#applied = fingerprint;
    remember();
  }

  async status(): Promise<EngineConnectorStatus[]> {
    if (!this.source || this.#process.state !== 'ready') return [];
    const statuses = new Map<string, EngineConnectorStatus>();
    const threads = this.#threads();
    for (const thread of threads.length > 0 ? threads : [undefined]) {
      let cursor: string | undefined;
      do {
        const page = await this.#process.request<StatusList>('mcpServerStatus/list', {
          detail: 'toolsAndAuthOnly',
          ...(thread && { threadId: thread.id }),
          ...(cursor && { cursor }),
        });
        for (const item of page.data) {
          if (item.name.startsWith('wevir')) continue;
          const status = {
            name: item.name,
            ...(item.runtimeStatus !== null && { status: item.runtimeStatus }),
            ...(item.authStatus !== undefined && { authStatus: item.authStatus }),
            tools: Object.values(item.tools).map(({ name, description }) => ({
              name,
              ...(description !== undefined && { description }),
            })),
          };
          if (statuses.get(item.name)?.status !== 'connected') statuses.set(item.name, status);
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
    }
    return [...statuses.values()];
  }
}
