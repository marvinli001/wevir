// SPDX-License-Identifier: Apache-2.0
// Copyright 2025 OpenAI
// 改写自 openai/codex codex-rs/config/src/mcp_types.rs，提交 092d3acd6bec3e3a14bdc7e7a2810ab628ab759d。
// 修改：TypeScript / zod、Wevir camelCase 线缆子集，密钥输入与脱敏结果分开。
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
const httpUrl = z.url().refine((value) => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
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
  name: ConnectorNameSchema,
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
});
export type Skill = z.infer<typeof SkillSchema>;
export const PluginsListResultSchema = z.object({
  connectors: z.array(ConnectorSchema),
  skills: z.array(SkillSchema),
});
export type PluginsList = z.infer<typeof PluginsListResultSchema>;

const empty = z.object({});
const id = z.object({ id: text });
const toggle = z.object({ id: text, enabled: z.boolean() });
const connectorResult = z.object({ connector: ConnectorSchema });
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
} as const;
