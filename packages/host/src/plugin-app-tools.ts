// 在对话里安装插件（P3，domain-model §3.15.3）。Wevir 自己的工具与审批衔接；格式、解析和安装事务复用 P1/P1a，
// plugin-install.ts / plugin-packages.ts / plugin-skills.ts 各有 Codex 092d3acd（Apache-2.0）的来源登记。
// 安装之后的管理（`wevir_plugins_browse` / `wevir_plugins_manage`）：开关、移除、改连接器与输入项、市场安装、从别的应用导入、
// 发起连接器的 OAuth 登录，都调 Host 已有的 RPC 实现；删改与写入内容的动作不论引擎问没问都由用户批准，登录只交出登录链接、不碰令牌。
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  type Connector,
  ConnectorNameSchema,
  ImportApplyParamsSchema,
  ImportAppSchema,
  MarketMethodSchemas,
  McpServerConfigSchema,
  McpServerPatchSchema,
  MemoryScopeSchema,
  type Plugin,
  PluginMethodSchemas,
  type PluginsList,
  type SessionId,
  type Skill,
  type TurnId,
} from '@wevir/protocol';
import {
  type AgentEvent,
  APP_TOOLS_SERVER,
  appToolBaseName,
  appToolServerOf,
} from '@wevir/runtime-adapter';
import type { Storage } from '@wevir/storage';
import { type AppTool, AppToolError, type AppToolResult, jsonResult } from './app-mcp.js';
import type { EventStore } from './event-store.js';
import type { ExternalImport } from './external-import/service.js';
import type { MarketService } from './market/service.js';
import type { McpOAuthService } from './mcp-oauth/service.js';
import { contained, readSkills, stagePlugin } from './plugin-install.js';
import { type PluginPackage, readPluginPackage } from './plugin-packages.js';
import { record } from './plugin-skills.js';
import type { PluginRegistry } from './plugins.js';
import type { SessionManager } from './session-manager.js';

const INSTALLS = ['wevir_plugin_install', 'wevir_skill_install', 'wevir_connector_add'] as const;
const MANAGE = 'wevir_plugins_manage';
/** 要先固定内容、经批准才执行的工具。 */
const MUTATIONS = [...INSTALLS, MANAGE] as const;
type Mutation = (typeof MUTATIONS)[number];
const MANAGE_ACTIONS = [
  'enable',
  'disable',
  'remove',
  'update',
  'set_inputs',
  'sign_in',
  'market_install',
  'import',
] as const;
type ManageAction = (typeof MANAGE_ACTIONS)[number];
/** 删除与写入内容的动作：引擎没问时 Host 也要用户批准。开关与发起登录按引擎自己的审批规则。 */
const CONFIRMED: ReadonlySet<ManageAction> = new Set([
  'remove',
  'update',
  'set_inputs',
  'market_install',
  'import',
]);
const KINDS = ['plugin', 'skill', 'connector'] as const;
type Kind = (typeof KINDS)[number];
/** 市场搜索一次最多列几条。 */
const MARKET_RESULTS_MAX = 25;
/** 导入审批卡片里每条记忆正文最多显示的字符。 */
const IMPORT_PREVIEW_CHARS = 2000;
const PLUGINS_PAGE = 'Ask the user to do this on the Plugins page instead.';
const AVAILABILITY =
  'Saved globally for all sessions. Codex uses changes on subsequent turns after hot reload, or in the next new session; availability in the current turn is not guaranteed. Other engines need MCP/skills support to use them.';
const OAUTH_REQUIRED =
  'This MCP server requires OAuth sign-in; its tools are unavailable until then. Use wevir_plugins_manage with action "sign_in" to get a sign-in link for the user, or ask the user to sign in on the Plugins page.';
const SIGN_IN_NEXT =
  'Give the user this link to open in their own web browser (not the Wevir browser) and finish signing in there; Wevir never shows you the tokens. The sign-in expires after 5 minutes. Then check this MCP server with wevir_plugins_list: oauth.status "signed_in" means it worked, "error" carries the reason.';
const MASK = '[REDACTED]';
const CREDENTIAL = /(?:token|secret|password|passwd|api[-_]?key|authorization|credential)/i;

interface Prepared {
  sessionId: SessionId;
  turnId: TurnId;
  toolCallId: string;
  name: Mutation;
  /** 引擎调用它用的服务（`wevir`，Codex 上是 `wevir_more`）：Host 自己请批准时卡片上的工具名照它写。 */
  server: string;
  /** 引擎没问时 Host 要不要请用户批准；开关与发起登录不要。 */
  confirm: boolean;
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
  /** 官方插件市场（0.91.0）：有它时 `wevir_plugins_browse` 能搜市场、`wevir_plugins_manage` 能从市场安装。 */
  market?: Pick<MarketService, 'index' | 'install' | 'installing' | 'cancelInstall'>;
  /** 从别的应用导入（0.74.0）：有它时能扫描与导入。 */
  importer?: Pick<ExternalImport, 'scan' | 'apply'>;
  /** 连接器的 OAuth 登录（0.97.0）：有它时能发起登录。 */
  oauth?: Pick<McpOAuthService, 'login'>;
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
          'List global plugins, MCP servers and skills, including enabled state. Never returns secrets. To install ' +
          "one, first write or download its files into this session's folder, then use wevir_plugin_install " +
          '(Wevir, Claude or Codex package), wevir_skill_install (skill folder, SKILL.md or ZIP) or ' +
          'wevir_connector_add (MCP configuration). ' +
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
      {
        name: 'wevir_plugins_browse',
        title: 'Browse plugins to add',
        description:
          'Find what to add. source "market" searches the Wevir plugin marketplace (query; refresh re-reads the index); ' +
          '"claude", "codex", "grok" or "antigravity" scans that app on this computer for memories, MCP servers and skills ' +
          'to import. Act on results with wevir_plugins_manage. Never returns secrets.',
        inputSchema: {
          type: 'object',
          properties: {
            source: { type: 'string', enum: ['market', ...ImportAppSchema.options] },
            query: { type: 'string' },
            refresh: { type: 'boolean' },
          },
          required: ['source'],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
        call: async (args, { sessionId }) => {
          this.#caller(sessionId);
          return jsonResult(await this.#browse(args));
        },
      },
      {
        name: MANAGE,
        title: 'Manage Wevir plugins',
        description:
          'Manage plugins, skills and MCP servers (kind, id or name from wevir_plugins_list). Actions: enable, disable, ' +
          'remove (kind, id); update an MCP server (id; config fields to change, null removes an env or header key; ' +
          'optional name); set_inputs (plugin id; inputs, null clears; ask the user, never guess); sign_in (MCP server ' +
          'id): a link for the user to open, you never get tokens; market_install (market entry id; inputs; replace ' +
          'upgrades); import (app; items with keys from wevir_plugins_browse). remove, update, set_inputs, ' +
          "market_install and import need the user's approval. " +
          AVAILABILITY,
        inputSchema: manageSchema(),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
        call: (args, call) => this.#call(MANAGE, args, call.sessionId, call.signal, call.server),
      },
      ...INSTALLS.map(
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
                : 'Add a global MCP server. Fields follow McpServerConfig: stdio command/args/env/cwd or Streamable HTTP url/headers; optional enabled and toolTimeoutSec. Credentials belong in env or headers; remote servers that use OAuth need no headers, the user signs in on the Plugins page. ') +
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
          call: (args, call) => this.#call(name, args, call.sessionId, call.signal, call.server),
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
    const server =
      event.type === 'tool.started'
        ? appToolServerOf(event.toolName)
        : (prepared?.server ?? APP_TOOLS_SERVER);
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
      prepared = this.#ensure(sessionId, event.toolCallId, name, args, server);
    }
    if (!prepared) return event;
    await prepared.ready;
    return {
      ...event,
      display: {
        kind: 'unknown',
        mcpServer: server,
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
    server: string = APP_TOOLS_SERVER,
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
      server,
      fingerprint: hash,
      confirm:
        name !== MANAGE ||
        CONFIRMED.has(args.action as ManageAction) ||
        !MANAGE_ACTIONS.includes(args.action as ManageAction),
      controller: new AbortController(),
      ready: Promise.resolve(),
      summary: {},
    };
    this.#prepared.set(key, prepared);
    prepared.ready = this.#prepare(prepared, structuredClone(args)).catch(
      async (error: unknown) => {
        prepared.error = redactText(
          error instanceof Error ? error.message : 'Invalid plugin change',
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
    if (prepared.name === MANAGE) {
      await this.#prepareManage(prepared, args);
      prepared.controller.signal.throwIfAborted();
      return;
    }
    if (prepared.name === 'wevir_connector_add') {
      const { name, ...config } = args;
      const parsed = PluginMethodSchemas['connector.add'].params.safeParse({ name, config });
      if (!parsed.success)
        throw new AppToolError(
          `Invalid MCP server: ${connectorIssues(parsed.error.issues)}. Use transport "stdio" with command/args/env/cwd, or transport "http" with url/headers.`,
        );
      prepared.summary = { name: parsed.data.name, ...safeConnector(parsed.data.config) };
      prepared.run = async (signal) => {
        const connector = await registry.add(
          parsed.data.name,
          parsed.data.config,
          undefined,
          signal,
        );
        // 0.97.0：要 OAuth 登录的服务登录前不交给引擎；这次不给 agent 发起登录的工具。
        return connector.oauth?.status === 'required'
          ? { connector, next: OAUTH_REQUIRED }
          : { connector };
      };
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
      checkInputs(pkg, inputs);
      prepared.summary = packageSummary(pkg, inputs);
      prepared.run = async (signal) => registry.installPlugin(root, { inputs, signal });
    }
    prepared.controller.signal.throwIfAborted();
  }

  async #browse(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { market, importer, registry } = this.#options;
    const source = args.source;
    if (source === 'market') {
      if (!market) throw new AppToolError(`This Host has no plugin marketplace. ${PLUGINS_PAGE}`);
      const result = await market.index(args.refresh === true);
      const terms = typeof args.query === 'string' ? words(args.query) : [];
      const installed = new Map(
        registry.pluginVersions().map((plugin) => [plugin.id, plugin] as const),
      );
      const matches = result.index.entries.filter((entry) => {
        const haystack = [
          entry.id,
          entry.name,
          entry.description ?? '',
          entry.category,
          ...(entry.keywords ?? []),
          ...Object.values(entry.i18n ?? {}).flatMap((item) => [
            item.name ?? '',
            item.description ?? '',
          ]),
        ]
          .join(' ')
          .toLowerCase();
        return terms.every((term) => haystack.includes(term));
      });
      return {
        total: matches.length,
        entries: matches.slice(0, MARKET_RESULTS_MAX).map((entry) => {
          const current = installed.get(entry.id);
          return {
            id: entry.id,
            kind: entry.kind,
            name: entry.name,
            version: entry.version,
            ...(entry.description !== undefined && { description: entry.description }),
            category: entry.category,
            ...(entry.verification && {
              verification: {
                level: entry.verification.level,
                ...(entry.verification.publisher !== undefined && {
                  publisher: entry.verification.publisher,
                }),
              },
            }),
            ...(entry.requires && { requires: entry.requires }),
            connectors: entry.contents.connectors.map(({ name, transport }) => ({
              name,
              transport,
            })),
            skills: entry.contents.skills.map(({ name }) => name),
            inputs: entry.contents.inputs.map(({ key, label, required, secret }) => ({
              key,
              label,
              required: required === true,
              secret: secret === true,
            })),
            ...(current && {
              installed: { version: current.version, enabled: current.enabled },
            }),
          };
        }),
        ...(result.error !== undefined && { error: result.error }),
      };
    }
    const app = ImportAppSchema.safeParse(source);
    if (!app.success)
      throw new AppToolError(
        `source must be "market" or one of ${ImportAppSchema.options.join(', ')}.`,
      );
    if (!importer)
      throw new AppToolError(`This Host cannot import from other apps. ${PLUGINS_PAGE}`);
    const scan = await importer.scan(app.data);
    const common = (item: {
      key: string;
      status: string;
      recommended: boolean;
      problem?: string | undefined;
      project?: string | undefined;
    }) => ({
      key: item.key,
      status: item.status,
      recommended: item.recommended,
      ...(item.problem !== undefined && { problem: item.problem }),
      ...(item.project !== undefined && { project: item.project }),
    });
    return {
      app: scan.app,
      found: scan.found,
      memories: scan.memories.map((item) => ({
        ...common(item),
        name: item.name,
        type: item.type,
        description: item.description,
        scope: item.scope,
        ...(item.workspaceId !== undefined && { workspaceId: item.workspaceId }),
      })),
      connectors: scan.connectors.map((item) => ({
        ...common(item),
        name: item.name,
        ...(item.config && { config: safeConnector(item.config) }),
        ...(item.workspaceId !== undefined && { workspaceId: item.workspaceId }),
      })),
      skills: scan.skills.map((item) => ({
        ...common(item),
        name: item.name,
        description: item.description,
      })),
      unsupported: scan.unsupported,
      next: 'Env and header values are not imported; the user fills them in on the Plugins page.',
    };
  }

  /** `wevir_plugins_manage`：校验参数、找到对象，写出给用户看的摘要与批准后执行的动作。 */
  async #prepareManage(prepared: Prepared, args: Record<string, unknown>): Promise<void> {
    const { registry, market, importer, oauth } = this.#options;
    const action = args.action as ManageAction;
    if (!MANAGE_ACTIONS.includes(action))
      throw new AppToolError(`action must be one of ${MANAGE_ACTIONS.join(', ')}.`);
    const id = typeof args.id === 'string' && args.id !== '' ? args.id : undefined;
    const need = (value: unknown, what: string): void => {
      if (value === undefined) throw new AppToolError(`${action} needs ${what}.`);
    };
    if (action === 'import') {
      if (!importer)
        throw new AppToolError(`This Host cannot import from other apps. ${PLUGINS_PAGE}`);
      const parsed = ImportApplyParamsSchema.safeParse({ app: args.app, items: args.items });
      if (!parsed.success)
        throw new AppToolError(
          `import needs app (${ImportAppSchema.options.join(', ')}) and items with the keys from wevir_plugins_browse.`,
        );
      const { app, items } = parsed.data;
      const scan = await importer.scan(app);
      const candidates = new Map<string, Record<string, unknown>>([
        ...scan.memories.map(
          (item) =>
            [
              item.key,
              {
                kind: 'memory',
                name: item.name,
                description: item.description,
                content: preview(item.content),
                scope: item.scope,
                problem: item.problem,
              },
            ] as const,
        ),
        ...scan.connectors.map(
          (item) =>
            [
              item.key,
              {
                kind: 'connector',
                name: item.name,
                ...(item.config && safeConnector(item.config)),
                problem: item.problem,
              },
            ] as const,
        ),
        ...scan.skills.map(
          (item) =>
            [
              item.key,
              {
                kind: 'skill',
                name: item.name,
                description: item.description,
                problem: item.problem,
              },
            ] as const,
        ),
      ]);
      const unknown = items.filter((item) => !candidates.has(item.key)).map(({ key }) => key);
      if (unknown.length)
        throw new AppToolError(
          `Unknown import keys: ${unknown.join(', ')}. Scan with wevir_plugins_browse source "${app}" first.`,
        );
      const blocked = items.filter((item) => candidates.get(item.key)?.problem !== undefined);
      if (blocked.length)
        throw new AppToolError(
          `These items cannot be imported: ${blocked
            .map((item) => `${item.key} (${String(candidates.get(item.key)?.problem)})`)
            .join(', ')}.`,
        );
      prepared.summary = {
        action,
        app,
        source: scan.home,
        items: items.map((item) => {
          const { problem: _problem, ...candidate } = candidates.get(item.key) ?? {};
          return {
            ...candidate,
            ...(item.name !== undefined && { name: item.name }),
            ...(item.scope !== undefined && { scope: item.scope }),
            ...(item.workspaceId !== undefined && { workspaceId: item.workspaceId }),
          };
        }),
      };
      prepared.run = async () => ({ results: await importer.apply(app, items) });
      return;
    }
    if (action === 'market_install') {
      if (!market) throw new AppToolError(`This Host has no plugin marketplace. ${PLUGINS_PAGE}`);
      need(id, 'id (the market entry)');
      const parsed = MarketMethodSchemas['market.install'].params.safeParse({
        entry: id,
        ...(args.inputs !== undefined && { inputs: args.inputs }),
        ...(args.replace !== undefined && { replace: args.replace }),
      });
      if (!parsed.success)
        throw new AppToolError(
          'market_install needs id (a market entry id); inputs, when provided, map declared keys to strings.',
        );
      const { entry: entryId, inputs = {}, replace = false } = parsed.data;
      const entry = (await market.index()).index.entries.find((item) => item.id === entryId);
      if (!entry)
        throw new AppToolError(
          `No market entry "${entryId}". Search with wevir_plugins_browse source "market".`,
        );
      const current = (await registry.list()).plugins?.find((plugin) => plugin.id === entryId);
      if (current && !replace)
        throw new AppToolError(
          `Plugin "${entryId}" ${current.version} is already installed; pass replace to upgrade it to ${entry.version}.`,
        );
      if (market.installing(entryId))
        throw new AppToolError(
          `"${entryId}" is already being installed from the Plugins page. Check wevir_plugins_list when it finishes.`,
        );
      // 下载、校验后复制一份到自己的暂存目录：用户批准的就是这份内容，批准后照 plugin.install 的事务发布。
      prepared.stage = await mkdtemp(join(registry.dir, '.install-app-'));
      const target = join(prepared.stage, 'source');
      const stop = () => market.cancelInstall(entryId);
      prepared.controller.signal.addEventListener('abort', stop, { once: true });
      let root: string | undefined;
      try {
        await market.install(entryId, async (folder) => {
          root = await stagePlugin(folder, target);
        });
      } finally {
        prepared.controller.signal.removeEventListener('abort', stop);
      }
      if (root === undefined)
        throw new AppToolError(`"${entryId}" was installed from the Plugins page meanwhile.`);
      const staged = root;
      const pkg = await readPluginPackage(staged);
      if (pkg.id !== entryId)
        throw new AppToolError(`Market entry "${entryId}" contains plugin "${pkg.id}".`);
      checkInputs(
        pkg,
        inputs,
        new Set(current?.inputs.filter((input) => input.set).map(({ key }) => key)),
      );
      prepared.summary = {
        action,
        market: {
          entry: entry.id,
          version: entry.version,
          ...(entry.verification && {
            verification: entry.verification.level,
            ...(entry.verification.publisher !== undefined && {
              publisher: entry.verification.publisher,
            }),
          }),
          ...(current && { replaces: current.version }),
        },
        ...packageSummary(pkg, inputs),
      };
      prepared.run = async (signal) => registry.installPlugin(staged, { inputs, replace, signal });
      return;
    }
    if (action === 'set_inputs') {
      need(id, 'id (the plugin)');
      const plugin = find(await registry.list(), 'plugin', id as string);
      const parsed = PluginMethodSchemas['plugin.setInputs'].params.safeParse({
        id: plugin.id,
        values: args.inputs,
      });
      if (!parsed.success || Object.keys(parsed.data.values).length === 0)
        throw new AppToolError('set_inputs needs inputs: declared keys mapped to strings or null.');
      const { values } = parsed.data;
      const unknown = Object.keys(values).filter(
        (key) => !plugin.inputs.some((input) => input.key === key),
      );
      if (unknown.length)
        throw new AppToolError(`Undeclared plugin inputs: ${unknown.join(', ')}.`);
      // 只给键与“设上 / 清掉”，值不进摘要。
      prepared.summary = {
        action,
        plugin: { id: plugin.id, name: plugin.name },
        inputs: Object.fromEntries(
          Object.entries(values).map(([key, value]) => [key, value === null ? 'clear' : 'set']),
        ),
      };
      prepared.run = async () => ({
        plugin: await registry.setPluginInputs(plugin.id, values),
      });
      return;
    }
    if (action === 'sign_in') {
      need(id, 'id (the MCP server)');
      const connector = find(await registry.list(), 'connector', id as string);
      prepared.summary = {
        action,
        connector: { id: connector.id, name: connector.name },
        ...(connector.oauth && { status: connector.oauth.status }),
      };
      prepared.run = async () => {
        if (!oauth) throw new AppToolError(`This Host cannot start sign-in. ${PLUGINS_PAGE}`);
        if (connector.config.transport !== 'http')
          throw new AppToolError(
            'This MCP server does not use OAuth sign-in. If it needs a token, ask the user to add it on the Plugins page.',
          );
        try {
          const { authUrl } = await oauth.login({
            name: connector.name,
            ...(connector.workspaceId !== undefined && { workspaceId: connector.workspaceId }),
            ...(connector.pluginId !== undefined && { pluginId: connector.pluginId }),
          });
          return { status: 'signing_in', signInUrl: authUrl, next: SIGN_IN_NEXT };
        } catch (error) {
          throw new AppToolError(
            `Could not start sign-in: ${error instanceof Error ? error.message : 'unknown error'}. ${PLUGINS_PAGE}`,
          );
        }
      };
      return;
    }
    if (action === 'update') {
      need(id, 'id (the MCP server)');
      const connector = find(await registry.list(), 'connector', id as string);
      const patch = {
        transport: connector.config.transport,
        ...record(args.config),
      };
      const config = McpServerPatchSchema.safeParse(patch);
      const name = args.name;
      if (!config.success || (name !== undefined && !ConnectorNameSchema.safeParse(name).success))
        throw new AppToolError(
          `Invalid MCP server change: ${config.success ? 'name must be lowercase letters, digits, - or _' : connectorIssues(config.error.issues)}.`,
        );
      if (Object.keys(record(args.config)).length === 0 && name === undefined)
        throw new AppToolError('update needs config fields to change or a new name.');
      prepared.summary = {
        action,
        connector: { id: connector.id, name: connector.name },
        ...(name !== undefined && { rename: name }),
        before: safeConnector(connector.config),
        changes: safePatch(config.data),
      };
      prepared.run = async () => ({
        connector: await registry.update(connector.id, {
          config: config.data,
          ...(typeof name === 'string' && { name }),
        }),
      });
      return;
    }
    // enable / disable / remove
    if (!KINDS.includes(args.kind as Kind))
      throw new AppToolError(`${action} needs kind (${KINDS.join(', ')}).`);
    need(id, 'id');
    const kind = args.kind as Kind;
    const list = await registry.list();
    const target = find(list, kind, id as string);
    prepared.summary = { action, ...described(list, kind, target.id) };
    if (action === 'remove') {
      prepared.run = async () => {
        if (kind === 'plugin') await registry.removePlugin(target.id);
        else if (kind === 'skill') await registry.removeSkill(target.id);
        else await registry.removeConnector(target.id);
        return { removed: { kind, id: target.id, name: target.name } };
      };
      return;
    }
    const enabled = action === 'enable';
    prepared.run = async () =>
      kind === 'plugin'
        ? { plugin: await registry.setPluginEnabled(target.id, enabled) }
        : kind === 'skill'
          ? { skill: await registry.setSkillEnabled(target.id, enabled) }
          : { connector: await registry.update(target.id, { enabled }) };
  }

  async #call(
    name: Mutation,
    args: Record<string, unknown>,
    sessionId: SessionId,
    signal: AbortSignal,
    server?: string,
  ): Promise<AppToolResult> {
    this.#caller(sessionId);
    // 只复用本次调用的批准，不能拿同一参数的旧批准重复安装。
    const hash = fingerprint(name, args);
    const prepared =
      [...this.#prepared.values()].find(
        (item) => item.sessionId === sessionId && item.fingerprint === hash && !item.consumed,
      ) ?? this.#ensure(sessionId, `app-${randomUUID()}`, name, args, server);
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
      if (prepared.approved !== true && prepared.confirm) {
        const approved = await this.#options.sessions.requestAppToolApproval(
          sessionId,
          prepared.toolCallId,
          {
            toolName: `mcp__${prepared.server}__${name}`,
            display: {
              kind: 'unknown',
              mcpServer: prepared.server,
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
  const bare = appToolBaseName(name);
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

interface Listed {
  plugin: Plugin;
  skill: Skill;
  connector: Connector;
}

/** 按 ID 找，找不到再按名字；名字对上几个（不同项目的同名连接器）时要 ID。 */
function find<K extends Kind>(list: PluginsList, kind: K, ref: string): Listed[K] {
  const items: readonly Listed[Kind][] =
    kind === 'plugin' ? (list.plugins ?? []) : kind === 'skill' ? list.skills : list.connectors;
  const byId = items.find((item) => item.id === ref);
  if (byId) return byId as Listed[K];
  const byName = items.filter((item) => item.name === ref);
  if (byName.length > 1)
    throw new AppToolError(
      `Several ${kind}s are named "${ref}"; use the id from wevir_plugins_list.`,
    );
  if (byName[0] === undefined)
    throw new AppToolError(`No ${kind} "${ref}". Check wevir_plugins_list.`);
  return byName[0] as Listed[K];
}

/** 开关与移除的摘要：插件带上它的连接器与 skills（移除时一起删）。 */
function described(list: PluginsList, kind: Kind, id: string): Record<string, unknown> {
  if (kind === 'plugin') {
    const plugin = find(list, 'plugin', id);
    const names = (ids: string[], items: readonly { id: string; name: string }[]) =>
      ids.map((item) => items.find((candidate) => candidate.id === item)?.name ?? item);
    return {
      plugin: { id: plugin.id, name: plugin.name, version: plugin.version },
      connectors: names(plugin.connectors, list.connectors),
      skills: names(plugin.skills, list.skills),
    };
  }
  if (kind === 'skill') {
    const skill = find(list, 'skill', id);
    return { skill: { id: skill.id, name: skill.name, description: skill.description } };
  }
  const connector = find(list, 'connector', id);
  return {
    connector: { id: connector.id, name: connector.name, ...safeConnector(connector.config) },
  };
}

/** 未声明的输入项拒绝；缺必填项时让 agent 去问用户。`kept` 是升级时已经填过的项。 */
function checkInputs(
  pkg: PluginPackage,
  inputs: Record<string, string>,
  kept: ReadonlySet<string> = new Set(),
): void {
  const unknown = Object.keys(inputs).filter(
    (key) => !pkg.inputs.some((input) => input.key === key),
  );
  if (unknown.length) throw new AppToolError(`Undeclared plugin inputs: ${unknown.join(', ')}.`);
  const missing = pkg.inputs
    .filter((input) => input.required && !inputs[input.key] && !kept.has(input.key))
    .map(({ key }) => key);
  if (missing.length)
    throw new AppToolError(
      `Missing required plugin inputs: ${missing.join(', ')}. Ask the user for these inputs, then retry.`,
    );
}

/** 安装前给用户看的包内容：连接器的命令与地址（密钥打码）、skills、输入项填没填。 */
function packageSummary(
  pkg: PluginPackage,
  inputs: Record<string, string>,
): Record<string, unknown> {
  const secrets = Object.values(inputs);
  return {
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
}

/** 连接器改动的摘要：env / headers 只给键与“设上 / 删掉”，OAuth 客户端密钥同样。 */
function safePatch(patch: Record<string, unknown>): Record<string, unknown> {
  const result = safeConnector(
    Object.fromEntries(
      Object.entries(patch).filter(
        ([key]) => key !== 'env' && key !== 'headers' && key !== 'oauth',
      ),
    ),
    secretValues({ ...patch, oauth: patch.oauth ?? undefined }),
  );
  for (const key of ['env', 'headers'])
    if (patch[key])
      result[key] = Object.fromEntries(
        Object.entries(record(patch[key])).map(([name, value]) => [
          name,
          value === null ? 'remove' : 'set',
        ]),
      );
  if (patch.oauth === null) result.oauth = 'remove';
  else if (patch.oauth !== undefined) {
    const oauth = record(patch.oauth);
    result.oauth = {
      ...oauth,
      ...('clientSecret' in oauth && {
        clientSecret: oauth.clientSecret === null ? 'remove' : 'set',
      }),
    };
  }
  return result;
}

function preview(text: string): string {
  return text.length > IMPORT_PREVIEW_CHARS ? `${text.slice(0, IMPORT_PREVIEW_CHARS)}…` : text;
}

function words(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

function manageSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      action: { type: 'string', enum: MANAGE_ACTIONS },
      kind: { type: 'string', enum: KINDS },
      id: { type: 'string', minLength: 1 },
      name: { type: 'string' },
      config: { type: 'object' },
      inputs: { type: 'object', additionalProperties: { type: ['string', 'null'] } },
      replace: { type: 'boolean' },
      app: { type: 'string', enum: ImportAppSchema.options },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            scope: { type: 'string', enum: MemoryScopeSchema.options },
            workspaceId: { type: 'string' },
            name: { type: 'string' },
          },
          required: ['key'],
        },
      },
    },
    required: ['action'],
    additionalProperties: false,
  };
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
  // `wevir_plugins_manage` 把连接器的改动放在 config 里。
  if (args.config !== undefined && typeof args.config === 'object')
    return [...secretValues({ ...args, config: undefined }), ...secretValues(record(args.config))];
  const clientSecret = record(args.oauth).clientSecret;
  return [
    ...['env', 'headers', 'inputs'].flatMap((key) =>
      Object.values(record(args[key])).filter(
        (value): value is string => typeof value === 'string' && value !== '',
      ),
    ),
    ...(typeof clientSecret === 'string' && clientSecret !== '' ? [clientSecret] : []),
  ];
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
  if (config.oauth && 'clientSecret' in record(config.oauth))
    result.oauth = { ...record(config.oauth), clientSecret: true };
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

/** 交给模型的插件清单：连接器抹掉密钥；插件图标（base64 的 data URL，可达几十 KB）模型用不到，去掉。 */
function safeList(value: Record<string, unknown>, secrets: string[] = []): Record<string, unknown> {
  const result = structuredClone(value);
  if (Array.isArray(result.plugins)) result.plugins = result.plugins.map(withoutIcon);
  if (result.plugin) result.plugin = withoutIcon(result.plugin);
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

function withoutIcon(plugin: unknown): Record<string, unknown> {
  const { iconUrl: _icon, ...rest } = record(plugin);
  return rest;
}

/** `wevir_connector_add` 哪几项不对：字段路径（`config.` 去掉）与原因，缺的项写成 required。 */
function connectorIssues(
  issues: readonly { path: readonly PropertyKey[]; message: string; code?: string }[],
): string {
  return issues
    .slice(0, 3)
    .map((issue) => {
      const path = issue.path
        .filter((key) => key !== 'config')
        .map(String)
        .join('.');
      const reason = /received undefined/.test(issue.message) ? 'is required' : issue.message;
      return path === '' ? reason : `${path} ${reason}`;
    })
    .join('; ');
}
