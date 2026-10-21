// 插件市场的索引（0.90.0）：schemas/wevir-market.schema.json 与源一致，清单的市场字段。
import { describe, expect, it } from 'vitest';
import generated from '../schemas/wevir-market.schema.json' with { type: 'json' };
import { wevirMarketJsonSchema } from './market.js';
import { WevirPluginManifestSchema } from './plugins.js';

const minimal = { schemaVersion: 1, id: 'sample', name: 'Sample', version: '1.0.0' };

describe('wevir-market.schema.json', () => {
  it('与 zod 源一致（改了 market.ts 后运行 pnpm --filter @wevir/protocol schema）', () => {
    expect(generated).toEqual(JSON.parse(JSON.stringify(wevirMarketJsonSchema())));
  });
});

describe('清单的市场字段', () => {
  it('接受分类、关键词、多语言与运行要求', () => {
    const manifest = {
      ...minimal,
      category: 'productivity',
      keywords: ['notes'],
      i18n: { 'zh-CN': { name: '示例', description: '说明' } },
      requires: { runtimes: ['node>=20', 'uv'] },
    };
    expect(WevirPluginManifestSchema.safeParse(manifest).error?.issues).toBeUndefined();
  });

  it.each([
    ['大写分类', { category: 'Dev' }],
    ['多语言里的未知字段', { i18n: { en: { title: 'x' } } }],
    ['不合法的语言标签', { i18n: { zh_CN: { name: 'x' } } }],
    ['运行要求带范围', { requires: { runtimes: ['node^20'] } }],
  ])('拒绝%s', (_, extra) => {
    expect(WevirPluginManifestSchema.safeParse({ ...minimal, ...extra }).success).toBe(false);
  });
});
