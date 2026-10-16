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
const httpUrl = z.url().refine((value) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
});

export const McpServerConfigSchema = z.discriminatedUnion('transport', [
  z.object({ transport: z.literal('stdio'), ...stdio, env: secrets.optional(), ...common }),
  z.object({ transport: z.literal('http'), url: httpUrl, headers: secrets.optional(), ...common }),
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
    ...common,
  }),
]);
export type McpServerPatch = z.infer<typeof McpServerPatchSchema>;
export const McpServerViewSchema = z.discriminatedUnion('transport', [
  z.object({ transport: z.literal('stdio'), ...stdio, env: markers.optional(), ...common }),
  z.object({ transport: z.literal('http'), url: httpUrl, headers: markers.optional(), ...common }),
]);
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
export const PluginMethodSchemas = {
  'plugins.list': { params: empty, result: PluginsListResultSchema, permission: 'host.manage' },
  'connector.add': {
    params: z.object({
      name: ConnectorNameSchema,
      config: McpServerConfigSchema,
      enabled: z.boolean().optional(),
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
