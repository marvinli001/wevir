// 插件市场的索引（0.91.0、0.93.0）：schemas/wevir-market.schema.json 与源一致，清单的市场字段，读取时丢掉未知字段。
import { describe, expect, it } from 'vitest';
import generated from '../schemas/wevir-market.schema.json' with { type: 'json' };
import { WevirMarketIndexLenientSchema, wevirMarketJsonSchema } from './market.js';
import { WevirPluginManifestSchema } from './plugins.js';
import { marketIndex } from './test-samples.js';

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

  it('接受示例、多语言示例与隐私政策、服务条款（0.93.0）', () => {
    const manifest = {
      ...minimal,
      examples: ['Summarize my inbox', 'Draft a reply'],
      i18n: { 'zh-CN': { examples: ['总结收件箱'] } },
      privacyPolicy: 'https://example.com/privacy',
      termsOfService: 'https://example.com/terms',
    };
    expect(WevirPluginManifestSchema.safeParse(manifest).error?.issues).toBeUndefined();
  });

  it.each([
    ['大写分类', { category: 'Dev' }],
    ['多语言里的未知字段', { i18n: { en: { title: 'x' } } }],
    ['不合法的语言标签', { i18n: { zh_CN: { name: 'x' } } }],
    ['运行要求带范围', { requires: { runtimes: ['node^20'] } }],
    ['四条示例', { examples: ['a', 'b', 'c', 'd'] }],
    ['超过 200 字的示例', { examples: ['x'.repeat(201)] }],
    ['空的示例', { examples: [''] }],
    ['多语言里四条示例', { i18n: { en: { examples: ['a', 'b', 'c', 'd'] } } }],
    ['不是 http(s) 的隐私政策', { privacyPolicy: 'mailto:privacy@example.com' }],
    ['不是地址的服务条款', { termsOfService: 'terms.html' }],
  ])('拒绝%s', (_, extra) => {
    expect(WevirPluginManifestSchema.safeParse({ ...minimal, ...extra }).success).toBe(false);
  });
});

describe('读取用的宽松版本', () => {
  it('接受各层多出的未知字段并丢掉它们', () => {
    const [notes, tracker] = marketIndex.entries;
    const future = {
      ...marketIndex,
      mirrors: ['github'],
      categories: [{ ...marketIndex.categories[0], icon: 'x.svg' }],
      featured: [{ ...marketIndex.featured[0], layout: 'carousel' }],
      entries: [
        { ...notes, trust: 'official', rating: 4.5, i18n: { en: { tagline: 'x' } } },
        {
          ...tracker,
          verification: { ...tracker?.verification, badge: 'gold' },
          upstream: { ...tracker?.upstream, stars: 120 },
          links: { privacy: 'https://example.com/privacy', support: 'https://example.com' },
          contents: {
            ...tracker?.contents,
            apps: [],
            connectors: [{ name: 'tracker', transport: 'http', url: 'https://x', oauth: true }],
          },
          files: [{ path: 'wevir-plugin.json', size: 300, sha256: 'f'.repeat(64), mode: 493 }],
        },
      ],
    };
    const parsed = WevirMarketIndexLenientSchema.parse(future);
    expect(parsed).not.toHaveProperty('mirrors');
    expect(parsed.categories[0]).not.toHaveProperty('icon');
    expect(parsed.featured[0]).not.toHaveProperty('layout');
    expect(parsed.entries[0]).not.toHaveProperty('trust');
    expect(parsed.entries[0]).not.toHaveProperty('rating');
    expect(parsed.entries[0]?.i18n).toEqual({ en: {} });
    expect(parsed.entries[1]?.verification).toEqual(tracker?.verification);
    expect(parsed.entries[1]?.upstream).toEqual(tracker?.upstream);
    expect(parsed.entries[1]?.links).toEqual({ privacy: 'https://example.com/privacy' });
    expect(parsed.entries[1]?.contents).not.toHaveProperty('apps');
    expect(parsed.entries[1]?.contents.connectors[0]).not.toHaveProperty('oauth');
    expect(parsed.entries[1]?.files[0]).not.toHaveProperty('mode');
  });

  it('不认识的 schemaVersion 与已知字段的错误照样拒绝', () => {
    expect(
      WevirMarketIndexLenientSchema.safeParse({ ...marketIndex, schemaVersion: 2 }).success,
    ).toBe(false);
    const [notes] = marketIndex.entries;
    const broken = { ...marketIndex, entries: [{ ...notes, category: undefined }] };
    expect(WevirMarketIndexLenientSchema.safeParse(broken).success).toBe(false);
  });
});
