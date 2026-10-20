// 在对话里安装插件（P3，domain-model §3.15.3）。Wevir 自己的工具与审批衔接；格式、解析和安装事务复用 P1/P1a，
// plugin-install.ts / plugin-packages.ts / plugin-skills.ts 各有 Codex 092d3acd（Apache-2.0）的来源登记。
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  ConnectorNameSchema,
  McpServerConfigSchema,
  PluginMethodSchemas,
  type SessionId,
  type TurnId,
} from '@wevir/protocol';
import type { AgentEvent } from '@wevir/runtime-adapter';
import type { Storage } from '@wevir/storage';
import { type AppTool, AppToolError, type AppToolResult, jsonResult } from './app-mcp.js';
import type { EventStore } from './event-store.js';
import { contained, readSkills, stagePlugin } from './plugin-install.js';
import { readPluginPackage } from './plugin-packages.js';
import { record } from './plugin-skills.js';
import type { PluginRegistry } from './plugins.js';
import type { SessionManager } from './session-manager.js';

const MUTATIONS = ['wevir_plugin_install', 'wevir_skill_install', 'wevir_connector_add'] as const;
type Mutation = (typeof MUTATIONS)[number];
const AVAILABILITY =
  'Saved globally for all sessions. Codex uses changes on subsequent turns after hot reload, or in the next new session; availability in the current turn is not guaranteed. Other engines need MCP/skills support to use them.';
const MASK = '[REDACTED]';
const CREDENTIAL = /(?:token|secret|password|passwd|api[-_]?key|authorization|credential)/i;

interface Prepared {
  sessionId: SessionId;
  turnId: TurnId;
  toolCallId: string;
  name: Mutation;
  fingerprint: string;
  controller: AbortController;
  ready: Promise<void>;
  summary: Record<string, unknown>;
  run?: (signal: AbortSignal) => Promise<Record<string, unknown>>;
  stage?: string;
  error?: string;
  approved?: boolean;
  consumed?: boolean;
}

export interface PluginAppToolsOptions {
  registry: PluginRegistry;
  storage: Storage;
  events: EventStore;
  sessions: SessionManager;
}

export class PluginAppTools {
  readonly tools: readonly AppTool[];
  readonly #options: PluginAppToolsOptions;
  readonly #prepared = new Map<string, Prepared>();

  constructor(options: PluginAppToolsOptions) {
    this.#options = options;
    this.tools = [
      {
        name: 'wevir_plugins_list',
        title: 'List Wevir plugins',
        description:
          'List global plugins, MCP servers and skills, including enabled state. Never returns secrets. ' +
          AVAILABILITY,
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        call: async (_args, { sessionId }) => {
          this.#caller(sessionId);
          const secrets = options.registry.appToolSecrets();
          return jsonResult(safeList(await options.registry.list(), secrets));
        },
      },
      ...MUTATIONS.map(
        (name): AppTool => ({
          name,
          title:
            name === 'wevir_plugin_install'
              ? 'Install a Wevir plugin'
              : name === 'wevir_skill_install'
                ? 'Install a skill'
                : 'Add an MCP server',
          description:
            (name === 'wevir_plugin_install'
              ? "Install a Wevir, Claude or Codex plugin folder or ZIP from this session's folder. To create a plugin, write wevir-plugin.json and its contents there first. Supply declared inputs; if required inputs are missing, ask the user for the listed keys and retry. Does not replace an installed plugin. "
              : name === 'wevir_skill_install'
                ? "Install a skill folder, SKILL.md or ZIP from this session's folder. Write or download it there first. Uses Codex SKILL.md frontmatter (name, description); paths may be relative to cwd or absolute, but must stay inside the session folder. "
                : 'Add a global MCP server. Fields follow McpServerConfig: stdio command/args/env/cwd or Streamable HTTP url/headers; optional enabled and toolTimeoutSec. Credentials belong in env or headers. ') +
            "Requires the user's approval of the actual contents before changing configuration. " +
            AVAILABILITY,
          inputSchema: mutationSchema(name),
          // 不标只读、不按名字放行：引擎先问；未问时 Host 补问，自动审查也不能代替用户批准。
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true,
          },
          call: (args, call) => this.#call(name, args, call.sessionId, call.signal),
        }),
      ),
    ];
  }

  /** 引擎事件落库前固定待安装内容；审批与工具事件只使用这份脱敏详情。 */
  async prepareEvent(sessionId: SessionId, event: AgentEvent): Promise<AgentEvent> {
    if (event.type !== 'tool.started' && event.type !== 'tool.updated') return event;
    const key = `${sessionId}:${event.toolCallId}`;
    let prepared = this.#prepared.get(key);
    const name = event.type === 'tool.started' ? mutationName(event.toolName) : prepared?.name;
    if (!name) return event;
    if (event.input !== undefined) {
      const input = record(event.input);
      // Codex 带 arguments；Cursor 的 MCP 参数在 args（旁边是 providerIdentifier / toolName）；Claude / ACP 直接给参数。
      const args = record(
        'arguments' in input
          ? input.arguments
          : input.providerIdentifier === 'wevir' && input.toolName === name
            ? input.args
            : input,
      );
      prepared = this.#ensure(sessionId, event.toolCallId, name, args);
    }
    if (!prepared) return event;
    await prepared.ready;
    return {
      ...event,
      display: {
        kind: 'unknown',
        mcpServer: 'wevir',
        summary: JSON.stringify(prepared.summary, null, 2),
      },
      ...(event.input !== undefined && { input: prepared.summary }),
    };
  }

  resolved(sessionId: SessionId, toolCallId: string, approved: boolean): void {
    const prepared = this.#prepared.get(`${sessionId}:${toolCallId}`);
    if (!prepared) return;
    prepared.approved = approved;
    if (!approved) {
      prepared.controller.abort();
      void prepared.ready.then(() => this.#clean(prepared));
    }
  }

  finishTurn(sessionId: SessionId, turnId: TurnId): void {
    for (const [key, prepared] of this.#prepared) {
      if (prepared.sessionId !== sessionId || prepared.turnId !== turnId) continue;
      prepared.controller.abort();
      this.#prepared.delete(key);
      void prepared.ready.then(() => this.#clean(prepared));
    }
  }

  close(): void {
    for (const prepared of this.#prepared.values()) {
      prepared.controller.abort();
      void prepared.ready.then(() => this.#clean(prepared));
    }
    this.#prepared.clear();
  }

  #caller(sessionId: SessionId) {
    const caller = this.#options.storage.sessions.get(sessionId);
    const workspace = caller && this.#options.storage.workspaces.get(caller.workspaceId);
    if (!caller || !workspace || workspace.removedAt !== undefined)
      throw new AppToolError('This session or its project is no longer available.');
    return caller;
  }

  #ensure(
    sessionId: SessionId,
    toolCallId: string,
    name: Mutation,
    args: Record<string, unknown>,
  ): Prepared {
    const key = `${sessionId}:${toolCallId}`;
    const hash = fingerprint(name, args);
    const old = this.#prepared.get(key);
    if (old?.fingerprint === hash) return old;
    if (old) {
      old.controller.abort();
      void old.ready.then(() => this.#clean(old));
    }
    const turnId = this.#options.events.snapshot(sessionId)?.session.activeTurn?.turnId;
    if (!turnId) throw new AppToolError('Plugin changes require an active turn.');
    const prepared: Prepared = {
      sessionId,
      turnId,
      toolCallId,
      name,
      fingerprint: hash,
      controller: new AbortController(),
      ready: Promise.resolve(),
      summary: {},
    };
    this.#prepared.set(key, prepared);
    prepared.ready = this.#prepare(prepared, structuredClone(args)).catch(
      async (error: unknown) => {
        prepared.error = redactText(
          error instanceof Error ? error.message : 'Invalid plugin installation',
          secretValues(args),
        );
        prepared.summary = { error: prepared.error };
        await this.#clean(prepared);
      },
    );
    return prepared;
  }

  async #prepare(prepared: Prepared, args: Record<string, unknown>): Promise<void> {
    const { registry } = this.#options;
    const caller = this.#caller(prepared.sessionId);
    if (prepared.name === 'wevir_connector_add') {
      const { name, ...config } = args;
      const parsed = PluginMethodSchemas['connector.add'].params.safeParse({ name, config });
      if (!parsed.success)
        throw new AppToolError(
          'Invalid MCP server name or McpServerConfig. Use stdio command/args/env/cwd or http url/headers.',
        );
      prepared.summary = { name: parsed.data.name, ...safeConnector(parsed.data.config) };
      prepared.run = async (signal) => ({
        connector: await registry.add(parsed.data.name, parsed.data.config, undefined, signal),
      });
      return;
    }
    const parsed = PluginMethodSchemas['plugin.install'].params.safeParse(args);
    if (!parsed.success || 'replace' in args)
      throw new AppToolError(
        'path must be a non-empty string and inputs, when provided, must map declared keys to strings.',
      );
    const source = await sessionInstallPath(caller.cwd, parsed.data.path);
    prepared.stage = await mkdtemp(join(registry.dir, '.install-app-'));
    const root = await stagePlugin(source, join(prepared.stage, 'source'));
    if (prepared.name === 'wevir_skill_install') {
      if ('inputs' in args) throw new AppToolError('wevir_skill_install only accepts path.');
      const skills = await readSkills(root);
      if (skills.length === 0)
        throw new AppToolError('No skills found. Add a valid SKILL.md with name and description.');
      prepared.summary = { skills: skills.map(({ name, description }) => ({ name, description })) };
      prepared.run = async (signal) => safeList(await registry.install(root, signal));
    } else {
      const pkg = await readPluginPackage(root);
      const inputs = parsed.data.inputs ?? {};
      const unknown = Object.keys(inputs).filter(
        (key) => !pkg.inputs.some((input) => input.key === key),
      );
      if (unknown.length)
        throw new AppToolError(`Undeclared plugin inputs: ${unknown.join(', ')}.`);
      const missing = pkg.inputs
        .filter((input) => input.required && !inputs[input.key])
        .map(({ key }) => key);
      if (missing.length)
        throw new AppToolError(
          `Missing required plugin inputs: ${missing.join(', ')}. Ask the user for these inputs, then retry.`,
        );
      const secrets = Object.values(inputs);
      prepared.summary = {
        plugin: {
          id: pkg.id,
          name: pkg.name,
          version: pkg.version,
          description: pkg.description,
          source: pkg.source,
        },
        connectors: pkg.connectors.map(({ name, config }) => ({
          name,
          ...safeConnector(config, secrets),
        })),
        skills: pkg.skills.map(({ name, description }) => ({ name, description })),
        inputs: pkg.inputs.map(({ key, label }) => ({ key, label, set: Boolean(inputs[key]) })),
        ignored: pkg.ignored,
      };
      prepared.run = async (signal) => registry.installPlugin(root, { inputs, signal });
    }
    prepared.controller.signal.throwIfAborted();
  }

  async #call(
    name: Mutation,
    args: Record<string, unknown>,
    sessionId: SessionId,
    signal: AbortSignal,
  ): Promise<AppToolResult> {
    this.#caller(sessionId);
    // 只复用本次调用的批准，不能拿同一参数的旧批准重复安装。
    const hash = fingerprint(name, args);
    const prepared =
      [...this.#prepared.values()].find(
        (item) => item.sessionId === sessionId && item.fingerprint === hash && !item.consumed,
      ) ?? this.#ensure(sessionId, `app-${randomUUID()}`, name, args);
    prepared.consumed = true;
    const combined = AbortSignal.any([signal, prepared.controller.signal]);
    try {
      await prepared.ready;
      if (prepared.error) throw new AppToolError(prepared.error);
      if (prepared.approved === false)
        throw new AppToolError(
          'The user denied this plugin change. Configuration was not changed.',
        );
      combined.throwIfAborted();
      if (prepared.approved !== true) {
        const approved = await this.#options.sessions.requestAppToolApproval(
          sessionId,
          prepared.toolCallId,
          {
            toolName: `mcp__wevir__${name}`,
            display: {
              kind: 'unknown',
              mcpServer: 'wevir',
              summary: JSON.stringify(prepared.summary, null, 2),
            },
            input: prepared.summary,
          },
          combined,
        );
        if (!approved)
          throw new AppToolError(
            'The user denied or cancelled this plugin change. Configuration was not changed.',
          );
      }
      combined.throwIfAborted();
      const current = this.#options.events.snapshot(sessionId)?.session;
      if (current?.activeTurn?.turnId !== prepared.turnId || current.state === 'cancelling')
        throw new AppToolError('The turn ended or was cancelled. Configuration was not changed.');
      if (!prepared.run) throw new AppToolError('Invalid plugin installation.');
      return jsonResult({
        ...safeList(await prepared.run(combined), this.#options.registry.appToolSecrets()),
        availability: AVAILABILITY,
      });
    } catch (error) {
      throw new AppToolError(
        redactText(
          error instanceof Error ? error.message : 'Plugin change failed.',
          secretValues(args),
        ),
      );
    } finally {
      await this.#clean(prepared);
    }
  }

  async #clean(prepared: Prepared): Promise<void> {
    // Windows 上刚关掉的句柄（杀毒、索引）会让 rmdir 短暂报 EPERM / EBUSY，重试几次再放弃。
    if (prepared.stage)
      await rm(prepared.stage, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

function mutationName(name: string): Mutation | undefined {
  const bare = name.replace(/^mcp__wevir__/, '');
  return MUTATIONS.find((candidate) => candidate === bare);
}

function fingerprint(name: string, args: Record<string, unknown>): string {
  // 对象键顺序不决定是不是同一次调用；只保存摘要，含密钥的参数留在待执行闭包。
  const stable = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(stable)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, stable(item)]),
          )
        : value;
  return createHash('sha256')
    .update(name)
    .update(JSON.stringify(stable(args)))
    .digest('hex');
}

/** 相对 / 绝对路径都用 realpath 验证；路径中间的链接也拒绝，包内链接由 P1 的复制 / 解包拒绝。 */
async function sessionInstallPath(cwd: string, path: string): Promise<string> {
  const root = await realpath(cwd);
  const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const real = await realpath(absolute).catch(() => {
    throw new AppToolError(
      "Installation source does not exist in this session's folder. Copy or download it there first.",
    );
  });
  if (!contained(root, real) || !contained(root, absolute))
    throw new AppToolError(
      "Installation source must be inside this session's folder. Copy or download it there first.",
    );
  let part = root;
  for (const segment of relative(root, absolute).split(sep)) {
    part = join(part, segment);
    if ((await lstat(part)).isSymbolicLink())
      throw new AppToolError(
        'Installation symbolic links are not supported. Copy the contents into the session folder.',
      );
  }
  return real;
}

function mutationSchema(name: Mutation): Record<string, unknown> {
  if (name === 'wevir_connector_add') {
    const schema = McpServerConfigSchema.toJSONSchema({ io: 'input' });
    const variants = schema.oneOf ?? schema.anyOf;
    const properties: Record<string, unknown> = { name: ConnectorNameSchema.toJSONSchema() };
    for (const variant of variants ?? []) Object.assign(properties, record(variant).properties);
    properties.transport = { type: 'string', enum: ['stdio', 'http'] };
    return {
      type: 'object',
      properties,
      required: ['name', 'transport'],
      additionalProperties: false,
    };
  }
  return {
    type: 'object',
    properties: {
      path: { type: 'string', minLength: 1 },
      ...(name === 'wevir_plugin_install' && {
        inputs: { type: 'object', additionalProperties: { type: 'string' } },
      }),
    },
    required: ['path'],
    additionalProperties: false,
  };
}

function secretValues(args: Record<string, unknown>): string[] {
  return ['env', 'headers', 'inputs'].flatMap((key) =>
    Object.values(record(args[key])).filter(
      (value): value is string => typeof value === 'string' && value !== '',
    ),
  );
}

function redactText(text: string, secrets: string[]): string {
  for (const secret of [...secrets].sort((a, b) => b.length - a.length))
    text = text.replaceAll(secret, MASK);
  return text
    .replace(/https?:\/\/[^\s"'<>]+/g, (value) => {
      try {
        const url = new URL(value);
        if (url.username) url.username = MASK;
        if (url.password) url.password = MASK;
        for (const key of [...url.searchParams.keys()]) url.searchParams.set(key, MASK);
        if (url.hash) url.hash = MASK;
        return url.toString();
      } catch {
        return value;
      }
    })
    .replace(/(\bBearer\s+)[^\s"']+/gi, `$1${MASK}`)
    .replace(
      /((?:--?)?[\w-]*(?:token|secret|password|passwd|api[-_]?key|authorization|credential)[\w-]*[=:\s]+)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\S+)/gi,
      `$1${MASK}`,
    );
}

/** env / headers 永远只给已设置标记；命令、参数与 URL 也打码。 */
function safeConnector(
  config: Record<string, unknown>,
  extraSecrets: string[] = [],
): Record<string, unknown> {
  const secrets = [...secretValues(config), ...extraSecrets];
  const result = { ...config };
  for (const key of ['env', 'headers'])
    if (config[key])
      result[key] = Object.fromEntries(Object.keys(record(config[key])).map((key) => [key, true]));
  for (const key of ['command', 'url', 'cwd'])
    if (typeof result[key] === 'string') result[key] = redactText(result[key], secrets);
  if (Array.isArray(config.args))
    result.args = config.args.map((value, index, args) =>
      typeof value === 'string'
        ? index > 0 &&
          CREDENTIAL.test(String(args[index - 1])) &&
          !String(args[index - 1]).includes('=')
          ? MASK
          : redactText(value, secrets)
        : value,
    );
  return result;
}

function safeList(value: Record<string, unknown>, secrets: string[] = []): Record<string, unknown> {
  const result = structuredClone(value);
  if (Array.isArray(result.connectors))
    result.connectors = result.connectors.map((item) => ({
      ...item,
      config: safeConnector(record(item.config), secrets),
    }));
  if (result.connector) {
    const connector = record(result.connector);
    result.connector = { ...connector, config: safeConnector(record(connector.config), secrets) };
  }
  return result;
}
