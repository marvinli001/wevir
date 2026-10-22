// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 OpenAI
// 改写自 openai/codex codex-rs/config/src/mcp_types.rs，提交 092d3acd6bec3e3a14bdc7e7a2810ab628ab759d。
// 修改：TypeScript / zod、Wevir camelCase 线缆子集，密钥输入与脱敏结果分开。
// 0.42.0 的 wevir-plugin.json 字段名取自 codex-rs/core-plugins/src/manifest.rs（同一提交）与 Claude 插件清单：
// name、version、description、author、homepage、license、skills（默认 ./skills）、包内路径必须以 ./ 开头；
// Codex 的 mcpServers 换成 Wevir 的 connectors（字段同 McpServerConfig），另加 schemaVersion、id、icon、inputs。
// 本文件只依赖 zod：scripts/plugin-schema.ts 用 Node 直接加载它生成 JSON Schema。
import { z } from 'zod';
export const ConnectorNameSchema = z
  .string()
  .regex(/^(?!wevir)[a-z0-9_-]+$/)
  .max(128);
const text = z.string().min(1);
const secrets = z.record(text, z.string());
const secretPatch = z.record(text, z.string().nullable());
const markers = z.record(text, z.literal(true));
const common = {
  enabled: z.boolean().optional(),
  toolTimeoutSec: z.number().positive().finite().optional(),
};
const stdio = { command: text, args: z.array(z.string()).optional(), cwd: text.optional() };
// zod 4 在 z.url() 失败后仍会跑 refine，所以这里要自己接住 new URL 的解析错误，不能抛 TypeError。
/** http(s) 地址，不带用户名与口令。 */
export const PluginUrlSchema = z.url().refine((value) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
});
const httpUrl = PluginUrlSchema;

/**
 * 远程 MCP 服务的登录方式（0.97.0）：`oauth` 由 Host 走 OAuth 登录并代理请求，`none` 不登录；省略时 Host 加连接器和启动时探测一次
 * （服务器回 401 且能发现授权服务器就记成 `oauth`）。
 */
export const McpAuthModeSchema = z.enum(['oauth', 'none']);
/** 授权请求里 Host 自己设的参数，`authorizeParams` 不能覆盖。 */
export const OAUTH_RESERVED_AUTHORIZE_PARAMS = [
  'response_type',
  'client_id',
  'redirect_uri',
  'state',
  'code_challenge',
  'code_challenge_method',
  'resource',
  'scope',
] as const;
const RESERVED_AUTHORIZE: ReadonlySet<string> = new Set(OAUTH_RESERVED_AUTHORIZE_PARAMS);
const oauthCommon = {
  /** 预先注册的客户端 ID；没有时 Host 依次试 CIMD 与动态注册。插件清单里可以写 `${input:KEY}`。 */
  clientId: text.optional(),
  /** 请求的 scope；服务器在 `WWW-Authenticate` 里给了时用它的，否则优先于受保护资源元数据的 `scopes_supported`。 */
  scopes: z.array(text).optional(),
  /** RFC 8707 的 `resource`；省略时用服务器地址。 */
  resource: httpUrl.optional(),
  /** 固定的回调端口或地址（有些预先注册的客户端要求）；省略时 Host 每次登录在 127.0.0.1 上随机取一个端口。 */
  callbackPort: z.int().min(1).max(65535).optional(),
  /**
   * 给了就原样作为 redirect_uri（不加按服务器区分的路径）；没写端口时用 `callbackPort` 或随机端口。是 https 时当作中转页：
   * 它要把查询串原样转到 `http://127.0.0.1:<callbackPort>/callback`，这时必须给 `callbackPort`。
   */
  callbackUrl: httpUrl.optional(),
  /** 授权请求另加的参数，如 Google 的 `access_type: 'offline'`；不能是 Host 自己设的参数（`OAUTH_RESERVED_AUTHORIZE_PARAMS`）。 */
  authorizeParams: z
    .record(text, z.string())
    .refine((params) => !Object.keys(params).some((key) => RESERVED_AUTHORIZE.has(key)), {
      message: 'Reserved authorization parameter',
    })
    .optional(),
};
/**
 * 连接器的 OAuth 设置（0.97.0）。`clientSecret` 有两种：用户加连接器时填的是密钥，Host 存进密钥文件；插件清单里写死的是分发出去的
 * 预注册客户端的公开密钥（安全靠 PKCE），留在清单里、不要求用户填。两种在视图里都只有 `true`。
 */
export const McpOAuthConfigSchema = z.object({
  ...oauthCommon,
  clientSecret: z.string().optional(),
});
export type McpOAuthConfig = z.infer<typeof McpOAuthConfigSchema>;
const httpAuth = { auth: McpAuthModeSchema.optional(), oauth: McpOAuthConfigSchema.optional() };

export const McpServerConfigSchema = z.discriminatedUnion('transport', [
  z.object({ transport: z.literal('stdio'), ...stdio, env: secrets.optional(), ...common }),
  z.object({
    transport: z.literal('http'),
    url: httpUrl,
    headers: secrets.optional(),
    ...httpAuth,
    ...common,
  }),
]);
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export const McpServerPatchSchema = z.discriminatedUnion('transport', [
  z.object({
    transport: z.literal('stdio'),
    command: text.optional(),
    args: stdio.args,
    cwd: stdio.cwd,
    env: secretPatch.optional(),
    ...common,
  }),
  z.object({
    transport: z.literal('http'),
    url: httpUrl.optional(),
    headers: secretPatch.optional(),
    /** 0.97.0：null 回到自动判断。 */
    auth: McpAuthModeSchema.nullable().optional(),
    /** 0.97.0：给了就整体替换（`clientSecret` 省略保留、null 删除），null 删掉全部 OAuth 设置。 */
    oauth: z
      .object({ ...oauthCommon, clientSecret: z.string().nullable().optional() })
      .nullable()
      .optional(),
    ...common,
  }),
]);
export type McpServerPatch = z.infer<typeof McpServerPatchSchema>;
export const McpServerViewSchema = z.discriminatedUnion('transport', [
  z.object({ transport: z.literal('stdio'), ...stdio, env: markers.optional(), ...common }),
  z.object({
    transport: z.literal('http'),
    url: httpUrl,
    headers: markers.optional(),
    auth: McpAuthModeSchema.optional(),
    oauth: z.object({ ...oauthCommon, clientSecret: z.literal(true).optional() }).optional(),
    ...common,
  }),
]);
/** 从哪个应用导入（0.74.0，`import.*`）：`claude` Claude Code、`codex` Codex、`grok` Grok Build、`antigravity` Antigravity。 */
export const ImportAppSchema = z.enum(['claude', 'codex', 'grok', 'antigravity']);
export type ImportApp = z.infer<typeof ImportAppSchema>;
/** 导入时记下的出处（0.74.0）：应用与源文件的绝对路径。只说明从哪里来，导入后与源文件不再同步。 */
export const ImportedFromSchema = z.object({ app: ImportAppSchema, path: text });
export type ImportedFrom = z.infer<typeof ImportedFromSchema>;
/** 同 common.ts 的 WorkspaceIdSchema；本文件只依赖 zod，这里另写一份。 */
const workspaceId = z.string().regex(/^ws_[0-9A-Za-z]{1,64}$/);

/**
 * OAuth 连接器的登录状态（0.97.0）：`required` 要登录（没登录、退出了或刷新失败），`signing_in` 正在登录，`signed_in` 已登录，
 * `insufficient_scope` 已登录但服务器要更多权限（重新登录时带上 `scopes`），`error` 上次登录失败（原因在 `error`）。
 */
export const ConnectorOAuthStatusSchema = z.enum([
  'required',
  'signing_in',
  'signed_in',
  'insufficient_scope',
  'error',
]);
/**
 * 登录失败的原因（0.97.0，开放字符串）：`not_supported` 服务器不用 OAuth 或发现不了授权服务器，`client_id_required` 要填客户端 ID，
 * `pkce_unsupported` 授权服务器不支持 PKCE S256，`insecure_endpoint` 授权服务器的地址不是 https 或指向本机与局域网，
 * `discovery_failed` 读元数据失败，`registration_failed` 动态注册失败，`callback_unavailable` 回调端口开不了，`denied` 用户拒绝，
 * `timeout` 五分钟内没完成，`issuer_mismatch` 回调的 `iss` 不对，`token_exchange_failed` 换令牌失败，`refresh_failed` 刷新失败。
 */
export const McpOAuthErrorReasonSchema = z.string().min(1);
export const ConnectorOAuthSchema = z.object({
  status: ConnectorOAuthStatusSchema,
  /** 授权服务器（元数据的 issuer）。 */
  issuer: z.string().optional(),
  /** 已授予的 scope；`insufficient_scope` 时是服务器要的。 */
  scopes: z.array(text).optional(),
  /** 访问令牌的过期时间（ISO 8601）；Host 在过期前自动刷新。 */
  expiresAt: z.string().optional(),
  error: McpOAuthErrorReasonSchema.optional(),
});
export type ConnectorOAuth = z.infer<typeof ConnectorOAuthSchema>;

export const ConnectorSchema = z.object({
  id: text,
  /** 引擎里的名字；插件里的连接器是 `<插件 id>_<清单里的名字>`（0.42.0）。 */
  name: ConnectorNameSchema,
  /** 所属插件（0.42.0）；散装的没有。 */
  pluginId: text.optional(),
  /** 引用了还没填的必填输入项，这些连接器不交给引擎（0.42.0）。 */
  missingInputs: z.array(text).optional(),
  config: McpServerViewSchema,
  enabled: z.boolean(),
  status: z.string().optional(),
  authStatus: z.string().optional(),
  tools: z.array(z.object({ name: text, description: z.string().optional() })).optional(),
  /** 只给这个项目的会话（0.74.0）；省略是全局的。名字在全局与同一项目之间唯一，不同项目可以重名。 */
  workspaceId: workspaceId.optional(),
  /** 从别的应用导入的（0.74.0）。 */
  importedFrom: ImportedFromSchema.optional(),
  /** OAuth 登录状态（0.97.0）；不用 OAuth 的没有。不含任何令牌。 */
  oauth: ConnectorOAuthSchema.optional(),
});
export type Connector = z.infer<typeof ConnectorSchema>;
export const SkillSchema = z.object({
  id: text,
  name: text,
  description: text,
  shortDescription: text.optional(),
  source: z.enum(['wevir', 'user', 'project']),
  /** 规范绝对路径，指向 SKILL.md。 */
  path: text,
  enabled: z.boolean(),
  /** 所属插件（0.42.0）；散装与外部的没有。 */
  pluginId: text.optional(),
  /** 从别的应用导入的（0.74.0）。 */
  importedFrom: ImportedFromSchema.optional(),
  /**
   * 随 Wevir 分发的（0.96.0），`source` 是 `wevir`：文件在安装包的 `prompts/skills/` 里，默认启用，可以关掉，不能删除。
   */
  builtin: z.literal(true).optional(),
});
export type Skill = z.infer<typeof SkillSchema>;
// ---- Wevir 插件包（0.42.0）----

/** 插件 ID：小写字母数字与单个连字符，最长 64；`wevir` 开头保留（引擎里的连接器名以它开头）。 */
export const PluginIdSchema = z
  .string()
  .max(64)
  .regex(/^(?!wevir)[a-z0-9]+(?:-[a-z0-9]+)*$/);
/** 插件里连接器的名字；引擎里加上 `<插件 id>_` 前缀，合起来守 ConnectorNameSchema。 */
export const PluginConnectorNameSchema = z
  .string()
  .max(63)
  .regex(/^[a-z0-9_-]+$/);
/** 输入项的键，`${input:KEY}` 引用。 */
export const PluginInputKeySchema = z
  .string()
  .max(64)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
/** 包内相对路径：以 `./` 开头，没有 `..` 段与反斜杠。 */
export const PluginPathSchema = z
  .string()
  .max(512)
  .regex(/^\.\/(?:(?!\.\.(?:\/|$))[^/\\]+(?:\/|$))*$/);
/** semver 2.0.0（semver.org 给的正则）。 */
export const SemverSchema = z
  .string()
  .max(128)
  .regex(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/,
  );
/** `${input:KEY}`：连接器的 args、env、headers、url 里引用输入项，Host 交给引擎前展开。 */
export const PLUGIN_INPUT_PATTERN = /\$\{input:([A-Za-z_][A-Za-z0-9_]*)\}/g;
/** stdio 连接器的 command、args、cwd、env 里指向插件安装目录。 */
// biome-ignore lint/suspicious/noTemplateCurlyInString: 清单里的字面占位符
export const PLUGIN_DIR_PLACEHOLDER = '${pluginDir}';
/** 图标文件的大小上限。 */
export const PLUGIN_ICON_MAX_BYTES = 128 * 1024;
export const PLUGIN_INPUTS_MAX = 32;

export const PluginInputSchema = z.strictObject({
  key: PluginInputKeySchema,
  label: z.string().min(1).max(128),
  description: z.string().max(1024).optional(),
  secret: z.boolean().optional(),
  required: z.boolean().optional(),
});
export type PluginInput = z.infer<typeof PluginInputSchema>;
const PluginAuthorSchema = z.strictObject({
  name: z.string().min(1).max(128),
  url: httpUrl.optional(),
});
/** 语言标签，如 `zh-CN`、`en`。 */
export const LocaleTagSchema = z
  .string()
  .max(35)
  .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/);
/** 市场分类 ID（0.91.0）。 */
export const MarketCategoryIdSchema = z
  .string()
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
/** 示例 prompt（0.93.0）：最多 3 条，每条最长 200 字。 */
export const PluginExamplesSchema = z.array(z.string().min(1).max(200)).max(3);

/** 插件包根目录的 `wevir-plugin.json`。 */
export const WevirPluginManifestSchema = z
  .strictObject({
    /** 编辑器补全用，Host 不读。 */
    $schema: z.string().optional(),
    schemaVersion: z.literal(1),
    id: PluginIdSchema,
    name: z.string().min(1).max(128),
    version: SemverSchema,
    description: z.string().max(1024).optional(),
    author: PluginAuthorSchema.optional(),
    homepage: httpUrl.optional(),
    license: z.string().min(1).max(128).optional(),
    /** png 或 svg，最大 128 KiB。 */
    icon: PluginPathSchema.regex(/\.(?:png|svg)$/).optional(),
    /** 默认 `./skills`；下面每个含 SKILL.md 的文件夹是一个 skill。 */
    skills: PluginPathSchema.optional(),
    /** 行内 `{ 名字: McpServerConfig }`，或指向包内同样形状的 JSON 文件。 */
    connectors: z
      .union([PluginPathSchema, z.record(PluginConnectorNameSchema, McpServerConfigSchema)])
      .optional(),
    inputs: z.array(PluginInputSchema).max(PLUGIN_INPUTS_MAX).optional(),
    /** 以下四项给插件市场（0.91.0）。搜索用的关键词。 */
    keywords: z.array(z.string().min(1).max(32)).max(16).optional(),
    /** 市场分类 ID，取值见市场的分类表。 */
    category: MarketCategoryIdSchema.optional(),
    /** 名称、描述与示例的多语言版本。 */
    i18n: z
      .record(
        LocaleTagSchema,
        z.strictObject({
          name: z.string().min(1).max(128).optional(),
          description: z.string().max(1024).optional(),
          examples: PluginExamplesSchema.optional(),
        }),
      )
      .optional(),
    /** 以下三项也给插件市场（0.93.0）。示例 prompt，详情页里点一下就填进输入框。 */
    examples: PluginExamplesSchema.optional(),
    privacyPolicy: httpUrl.optional(),
    termsOfService: httpUrl.optional(),
    /** 运行要求，如 `node>=20`、`python>=3.11`、`uv`。 */
    requires: z
      .strictObject({
        runtimes: z
          .array(
            z
              .string()
              .regex(/^[a-z][a-z0-9-]*(?:(?:>=|=)[0-9][0-9A-Za-z.+-]*)?$/)
              .max(64),
          )
          .max(8)
          .optional(),
      })
      .optional(),
  })
  .superRefine((manifest, ctx) => {
    const keys = new Set<string>();
    for (const [index, input] of (manifest.inputs ?? []).entries()) {
      if (keys.has(input.key))
        ctx.addIssue({ code: 'custom', path: ['inputs', index, 'key'], message: 'Duplicate key' });
      keys.add(input.key);
    }
  });
export type WevirPluginManifest = z.infer<typeof WevirPluginManifestSchema>;
export const WEVIR_PLUGIN_MANIFEST = 'wevir-plugin.json';

export const PluginInputViewSchema = z.object({
  key: text,
  label: text,
  description: z.string().optional(),
  secret: z.boolean(),
  required: z.boolean(),
  set: z.boolean(),
  /** 只有非密钥项回传已填的值。 */
  value: z.string().optional(),
});
export const PluginSchema = z.object({
  id: text,
  name: text,
  version: text,
  description: z.string().optional(),
  author: z.object({ name: text, url: z.string().optional() }).optional(),
  homepage: z.string().optional(),
  /** 包里的图标，`data:` URL。 */
  iconUrl: z.string().optional(),
  /** 包的格式：Wevir 自己的，或从 Claude / Codex 包导入。 */
  source: z.enum(['wevir', 'claude', 'codex']),
  enabled: z.boolean(),
  /** 安装目录（规范绝对路径）。 */
  path: text,
  inputs: z.array(PluginInputViewSchema),
  /** 包含的连接器与 skills 的 ID。 */
  connectors: z.array(text),
  skills: z.array(text),
});
export type Plugin = z.infer<typeof PluginSchema>;

export const PluginsListResultSchema = z.object({
  connectors: z.array(ConnectorSchema),
  skills: z.array(SkillSchema),
  /** 0.42.0 起 Host 总是给。 */
  plugins: z.array(PluginSchema).optional(),
});
export type PluginsList = z.infer<typeof PluginsListResultSchema>;

const empty = z.object({});
const id = z.object({ id: text });
const toggle = z.object({ id: text, enabled: z.boolean() });
const connectorResult = z.object({ connector: ConnectorSchema });
const pluginResult = z.object({ plugin: PluginSchema });
const connectorRef = z.object({
  name: ConnectorNameSchema,
  workspaceId: workspaceId.optional(),
  pluginId: PluginIdSchema.optional(),
});
export const PluginMethodSchemas = {
  'plugins.list': { params: empty, result: PluginsListResultSchema, permission: 'host.manage' },
  'connector.add': {
    params: z.object({
      name: ConnectorNameSchema,
      config: McpServerConfigSchema,
      enabled: z.boolean().optional(),
      /** 只给这个项目（0.74.0）；省略是全局的。 */
      workspaceId: workspaceId.optional(),
    }),
    result: connectorResult,
    permission: 'host.manage',
  },
  'connector.update': {
    params: z.object({
      id: text,
      name: ConnectorNameSchema.optional(),
      config: McpServerPatchSchema.optional(),
      enabled: z.boolean().optional(),
    }),
    result: connectorResult,
    permission: 'host.manage',
  },
  'connector.remove': { params: id, result: empty, permission: 'host.manage' },
  'connector.setEnabled': { params: toggle, result: connectorResult, permission: 'host.manage' },
  /**
   * 0.97.0：开始 OAuth 登录。`name` 是 `Connector.name`，项目的连接器带 `workspaceId`，插件里的可带 `pluginId` 核对。客户端打开
   * `authUrl`；完成、失败、超时与取消都发 `plugins.changed`。同一个连接器再调会取消上一次。
   */
  'connector.login': {
    params: connectorRef.extend({ scopes: z.array(text).optional() }),
    result: z.object({ loginId: text, authUrl: httpUrl }),
    permission: 'host.manage',
  },
  'connector.loginCancel': {
    params: z.object({ loginId: text }),
    result: empty,
    permission: 'host.manage',
  },
  /** 0.97.0：退出登录。授权服务器支持撤销时尽力撤销，失败不报错；本机的令牌总会删掉。 */
  'connector.logout': { params: connectorRef, result: empty, permission: 'host.manage' },
  'skill.install': {
    params: z.object({ path: text }),
    result: PluginsListResultSchema,
    permission: 'host.manage',
  },
  'skill.remove': { params: id, result: empty, permission: 'host.manage' },
  'skill.setEnabled': {
    params: toggle,
    result: z.object({ skill: SkillSchema }),
    permission: 'host.manage',
  },
  'plugin.install': {
    params: z.object({
      path: text,
      inputs: z.record(PluginInputKeySchema, z.string()).optional(),
      replace: z.boolean().optional(),
    }),
    result: z.object({ plugin: PluginSchema, ignored: z.array(text) }),
    permission: 'host.manage',
  },
  'plugin.remove': { params: id, result: empty, permission: 'host.manage' },
  'plugin.setEnabled': { params: toggle, result: pluginResult, permission: 'host.manage' },
  'plugin.setInputs': {
    params: z.object({ id: text, values: z.record(PluginInputKeySchema, z.string().nullable()) }),
    result: pluginResult,
    permission: 'host.manage',
  },
} as const;

/** 清单的 JSON Schema，scripts/plugin-schema.ts 写进 schemas/wevir-plugin.schema.json，给插件作者的编辑器补全。 */
export function wevirPluginJsonSchema(): Record<string, unknown> {
  return {
    ...z.toJSONSchema(WevirPluginManifestSchema, { io: 'input' }),
    title: 'Wevir plugin manifest (wevir-plugin.json)',
  };
}
