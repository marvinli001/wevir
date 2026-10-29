// wevir-plugin.json（0.42.0）：zod 清单的合法 / 非法样本，schemas/wevir-plugin.schema.json 与源一致。
import { describe, expect, it } from 'vitest';
import generated from '../schemas/wevir-plugin.schema.json' with { type: 'json' };
import {
  McpServerConfigSchema,
  McpServerPatchSchema,
  McpServerViewSchema,
  PluginPathSchema,
  WevirPluginManifestSchema,
  wevirPluginJsonSchema,
} from './plugins.js';

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
  it.each([
    minimal,
    full,
    { ...minimal, connectors: './connectors.json' },
    { ...minimal, hooks: './hooks.json' },
  ])('合法 %#', (value) => {
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
    ['未知字段', { ...minimal, commands: './commands' }],
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

describe('http(s) 地址字段', () => {
  const good = [
    'http://example.com',
    'https://example.com/mcp?region=1',
    'http://127.0.0.1:8080/x',
  ];
  const bad = [
    'not a url',
    '',
    'example.com',
    '/relative/path',
    'ftp://example.com/x',
    'file:///tmp/x',
    'https://user:pass@example.com',
    'https://user@example.com',
  ];
  // 每个用到 http(s) 地址的位置：把地址放进去解析。
  const places: Array<[string, (url: string) => { success: boolean }]> = [
    ['McpServerConfig.url', (url) => McpServerConfigSchema.safeParse({ transport: 'http', url })],
    ['McpServerPatch.url', (url) => McpServerPatchSchema.safeParse({ transport: 'http', url })],
    ['McpServerView.url', (url) => McpServerViewSchema.safeParse({ transport: 'http', url })],
    [
      '清单 author.url',
      (url) => WevirPluginManifestSchema.safeParse({ ...minimal, author: { name: 'x', url } }),
    ],
    ['清单 homepage', (url) => WevirPluginManifestSchema.safeParse({ ...minimal, homepage: url })],
    [
      '清单行内连接器的 url',
      (url) =>
        WevirPluginManifestSchema.safeParse({
          ...minimal,
          connectors: { remote: { transport: 'http', url } },
        }),
    ],
  ];

  describe.each(places)('%s', (_place, parse) => {
    it.each(good)('接受 %s', (url) => {
      expect(parse(url).success).toBe(true);
    });
    // 不是地址的字符串要像其他非法值一样报校验失败，不能抛 TypeError。
    it.each(bad)('拒绝 %j 且不抛错', (url) => {
      expect(parse(url).success).toBe(false);
    });
  });

  it('补丁省略 url 仍合法', () => {
    expect(McpServerPatchSchema.safeParse({ transport: 'http', headers: {} }).success).toBe(true);
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
