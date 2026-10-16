// wevir-plugin.json（0.42.0）：zod 清单的合法 / 非法样本，schemas/wevir-plugin.schema.json 与源一致。
import { describe, expect, it } from 'vitest';
import generated from '../schemas/wevir-plugin.schema.json' with { type: 'json' };
import { PluginPathSchema, WevirPluginManifestSchema, wevirPluginJsonSchema } from './plugins.js';

const minimal = { schemaVersion: 1, id: 'sample', name: 'Sample', version: '1.0.0' };
const full = {
  $schema: '../schemas/wevir-plugin.schema.json',
  ...minimal,
  version: '2.1.0-beta.1+build.5',
  description: 'Tools for the sample service',
  author: { name: 'Sample Inc.', url: 'https://example.com' },
  homepage: 'https://example.com/plugin',
  license: 'MIT',
  icon: './assets/icon.svg',
  skills: './skills',
  connectors: {
    api: {
      transport: 'stdio',
      command: 'node',
      args: [`\${pluginDir}/server.mjs`, '--region', `\${input:REGION}`],
      env: { TOKEN: `\${input:TOKEN}` },
    },
    remote: {
      transport: 'http',
      url: `https://example.com/mcp?region=\${input:REGION}`,
      headers: { Authorization: `Bearer \${input:TOKEN}` },
      enabled: false,
    },
  },
  inputs: [
    { key: 'TOKEN', label: 'API token', secret: true, required: true },
    { key: 'REGION', label: 'Region', description: 'Data region' },
  ],
};

describe('WevirPluginManifestSchema', () => {
  it.each([minimal, full, { ...minimal, connectors: './connectors.json' }])('合法 %#', (value) => {
    expect(WevirPluginManifestSchema.safeParse(value).error?.issues).toBeUndefined();
  });

  it.each([
    ['缺 schemaVersion', { ...minimal, schemaVersion: undefined }],
    ['未来的 schemaVersion', { ...minimal, schemaVersion: 2 }],
    ['大写 id', { ...minimal, id: 'Sample' }],
    ['保留的 id', { ...minimal, id: 'wevir-tools' }],
    ['id 里有下划线', { ...minimal, id: 'a_b' }],
    ['id 过长', { ...minimal, id: 'a'.repeat(65) }],
    ['非 semver', { ...minimal, version: '1.0' }],
    ['未知字段', { ...minimal, hooks: './hooks.json' }],
    ['越界路径', { ...minimal, skills: '../skills' }],
    ['绝对路径', { ...minimal, skills: '/skills' }],
    ['中间的 ..', { ...minimal, connectors: './a/../../b.json' }],
    ['图标格式', { ...minimal, icon: './icon.jpg' }],
    ['连接器名字', { ...minimal, connectors: { Bad: { transport: 'stdio', command: 'x' } } }],
    ['连接器缺 transport', { ...minimal, connectors: { api: { command: 'x' } } }],
    [
      '重复的输入项',
      {
        ...minimal,
        inputs: [
          { key: 'A', label: 'A' },
          { key: 'A', label: 'B' },
        ],
      },
    ],
    ['输入项键', { ...minimal, inputs: [{ key: 'a-b', label: 'A' }] }],
    ['作者地址', { ...minimal, author: { name: 'x', url: 'file:///x' } }],
  ])('非法：%s', (_name, value) => {
    expect(WevirPluginManifestSchema.safeParse(value).success).toBe(false);
  });

  it('包内路径：以 ./ 开头、不含 .. 段与反斜杠', () => {
    for (const path of ['./', './skills', './a/b.json', './.hidden'])
      expect(PluginPathSchema.safeParse(path).success, path).toBe(true);
    for (const path of ['skills', '../x', './..', './a/../b', './a\\b', './a//b'])
      expect(PluginPathSchema.safeParse(path).success, path).toBe(false);
  });
});

describe('schemas/wevir-plugin.schema.json', () => {
  it('与 zod 源生成的一致（改了清单就运行 pnpm --filter @wevir/protocol schema）', () => {
    expect(generated).toEqual(JSON.parse(JSON.stringify(wevirPluginJsonSchema())));
  });

  it('必填字段、禁止未知字段与模式和 zod 一致', () => {
    const schema = generated as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, { pattern?: string; const?: unknown }>;
    };
    expect(schema.required).toEqual(['schemaVersion', 'id', 'name', 'version']);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.schemaVersion?.const).toBe(1);
    const id = new RegExp(schema.properties.id?.pattern as string);
    for (const value of ['sample', 'a-1', 'Sample', 'wevir-x', 'a--b'])
      expect(id.test(value), value).toBe(
        WevirPluginManifestSchema.safeParse({ ...minimal, id: value }).success,
      );
    const path = new RegExp(schema.properties.skills?.pattern as string);
    for (const value of ['./skills', '../x', './a/../b'])
      expect(path.test(value), value).toBe(PluginPathSchema.safeParse(value).success);
  });
});
