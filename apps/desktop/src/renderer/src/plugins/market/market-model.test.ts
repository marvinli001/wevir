import type { MarketEntry, WevirMarketIndex } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import {
  decodeText,
  entryIconPath,
  entryInitial,
  entryPublisher,
  entryReadmePath,
  entryText,
  entryWebUrl,
  findGroup,
  iconMimeType,
  localizedName,
  marketGroups,
  searchEntries,
  upstreamLabel,
  verificationMonth,
} from './market-model';

const HASH = 'f'.repeat(64);

const entry = (
  id: string,
  patch: Partial<MarketEntry> & Pick<MarketEntry, 'name' | 'category'>,
): MarketEntry => ({
  id,
  kind: 'plugin',
  path: `plugins/${id}`,
  version: '1.0.0',
  listedAt: '2026-10-21T08:00:00Z',
  contents: { connectors: [], skills: [], inputs: [] },
  files: [{ path: 'wevir-plugin.json', size: 1, sha256: HASH }],
  digest: HASH,
  ...patch,
});

const index: WevirMarketIndex = {
  schemaVersion: 1,
  name: 'Wevir',
  generatedAt: '2026-10-21T08:00:00Z',
  sequence: 1,
  commit: 'a'.repeat(40),
  categories: [
    { id: 'productivity', name: { 'zh-CN': '效率', en: 'Productivity' } },
    { id: 'travel', name: { 'zh-CN': '旅行', en: 'Travel' } },
    { id: 'data', name: { 'zh-CN': '数据', en: 'Data' } },
    { id: 'other', name: { 'zh-CN': '其他', en: 'Other' } },
  ],
  featured: [
    {
      id: 'popular',
      name: { 'zh-CN': '热门', en: 'Popular' },
      entries: ['notion', 'gone', 'atlas'],
    },
    { id: 'empty', name: { en: 'Empty' }, entries: ['gone'] },
  ],
  entries: [
    entry('notion', {
      name: 'Notion',
      category: 'productivity',
      description: 'Pages  and\ndatabases',
      i18n: { 'zh-CN': { name: '笔记', description: '页面与数据库', examples: ['整理会议记录'] } },
      keywords: ['wiki'],
      examples: ['Summarize my notes'],
    }),
    entry('atlas', { name: 'atlas', category: 'travel', author: { name: 'Acme Maps' } }),
    entry('zeta', { name: 'Zeta', category: 'productivity', description: 'Notion importer' }),
    entry('stray', { name: 'Stray', category: 'not-listed' }),
  ],
};

describe('多语言', () => {
  it('分类名：当前语言 → 英语 → 简体中文 → 任意一种 → 兜底', () => {
    expect(localizedName({ 'zh-CN': '效率', en: 'Productivity' }, 'ja', 'x')).toBe('Productivity');
    expect(localizedName({ 'zh-CN': '效率', en: 'Productivity' }, 'zh-CN', 'x')).toBe('效率');
    expect(localizedName({ 'zh-CN': '效率' }, 'fr', 'x')).toBe('效率');
    expect(localizedName({ ko: '생산성' }, 'fr', 'x')).toBe('생산성');
    expect(localizedName({}, 'fr', 'x')).toBe('x');
  });

  it('条目的名称、描述与示例取当前语言，没有时用条目本身的；描述折成一行', () => {
    const notion = index.entries[0] as MarketEntry;
    expect(entryText(notion, 'zh-CN')).toEqual({
      name: '笔记',
      description: '页面与数据库',
      examples: ['整理会议记录'],
    });
    expect(entryText(notion, 'en')).toEqual({
      name: 'Notion',
      description: 'Pages and databases',
      examples: ['Summarize my notes'],
    });
  });
});

describe('分组', () => {
  it('先推荐位（按推荐顺序、跳过不在的条目、空组不要），再按分类表的顺序，组内按名字排', () => {
    const groups = marketGroups(index, 'en');
    expect(groups.map((group) => group.id)).toEqual(['popular', 'productivity', 'travel', 'other']);
    expect(groups[0]?.entries.map((item) => item.id)).toEqual(['notion', 'atlas']);
    expect(groups[1]?.entries.map((item) => item.id)).toEqual(['notion', 'zeta']);
    expect(groups[1]?.name).toBe('Productivity');
  });

  it('分类不在分类表里的条目归“其他”；分类表里没有“其他”时不显示', () => {
    expect(findGroup(index, 'en', 'other')?.entries.map((item) => item.id)).toEqual(['stray']);
    const noOther = { ...index, categories: index.categories.filter((c) => c.id !== 'other') };
    expect(marketGroups(noOther, 'en').flatMap((g) => g.entries.map((e) => e.id))).not.toContain(
      'stray',
    );
  });

  it('分组的完整列表；没有的分组是 undefined', () => {
    expect(findGroup(index, 'zh-CN', 'popular')?.name).toBe('热门');
    expect(findGroup(index, 'en', 'data')).toBeUndefined();
    expect(findGroup(index, 'en', 'nope')).toBeUndefined();
  });
});

describe('搜索', () => {
  const ids = (query: string, locale = 'en') =>
    searchEntries(index, query, locale).map((item) => item.id);

  it('空查询返回空表', () => {
    expect(ids('  ')).toEqual([]);
  });

  it('在名称、各语言的描述、关键词与作者里匹配，不分大小写；名称命中的排前面', () => {
    expect(ids('notion')).toEqual(['notion', 'zeta']);
    expect(ids('数据库')).toEqual(['notion']);
    expect(ids('WIKI')).toEqual(['notion']);
    expect(ids('acme')).toEqual(['atlas']);
    expect(ids('笔记')).toEqual(['notion']);
  });

  it('每个词都要命中', () => {
    expect(ids('notion importer')).toEqual(['zeta']);
    expect(ids('notion travel')).toEqual([]);
  });
});

describe('条目的文件与链接', () => {
  it('图标路径要在条目目录下、在 files 里、是认得的图片', () => {
    const base = index.entries[0] as MarketEntry;
    const files = [
      ...base.files,
      { path: 'icon.svg', size: 10, sha256: HASH },
      { path: 'icon.tiff', size: 10, sha256: HASH },
    ];
    expect(entryIconPath({ ...base, files, icon: 'plugins/notion/icon.svg' })).toBe('icon.svg');
    expect(entryIconPath({ ...base, files, icon: 'plugins/notion/icon.tiff' })).toBeUndefined();
    expect(entryIconPath({ ...base, files, icon: 'plugins/other/icon.svg' })).toBeUndefined();
    expect(entryIconPath({ ...base, icon: 'plugins/notion/icon.svg' })).toBeUndefined();
    expect(entryIconPath(base)).toBeUndefined();
    expect(iconMimeType('a/B.PNG')).toBe('image/png');
  });

  it('README 不分大小写，没有时 undefined', () => {
    const base = index.entries[0] as MarketEntry;
    expect(entryReadmePath(base)).toBeUndefined();
    expect(
      entryReadmePath({
        ...base,
        files: [...base.files, { path: 'Readme.md', size: 1, sha256: HASH }],
      }),
    ).toBe('Readme.md');
  });

  it('上游简称：代码托管写 owner/repo，npm 与 PyPI 写包名', () => {
    expect(upstreamLabel('https://github.com/makenotion/notion-mcp-server')).toBe(
      'makenotion/notion-mcp-server',
    );
    expect(upstreamLabel('https://github.com/org/repo.git')).toBe('org/repo');
    expect(upstreamLabel('https://github.com/org/mono/tree/main/packages/x')).toBe('org/mono');
    expect(upstreamLabel('https://www.npmjs.com/package/@scope/pkg')).toBe('@scope/pkg');
    expect(upstreamLabel('https://www.npmjs.com/package/pkg')).toBe('pkg');
    expect(upstreamLabel('https://pypi.org/project/sql-mcp/')).toBe('sql-mcp');
    expect(upstreamLabel('https://example.com/tools/x/')).toBe('example.com/tools/x');
    expect(upstreamLabel('not a url')).toBe('not a url');
  });

  it('“复制链接”是当前镜像上 main 分支的条目目录', () => {
    expect(entryWebUrl('github', { path: 'plugins/notion' })).toBe(
      'https://github.com/Wevir-Labs/wevir-marketplace/tree/main/plugins/notion',
    );
    expect(entryWebUrl('cnb', { path: 'skills/pdf' })).toBe(
      'https://cnb.cool/wevir-labs/wevir-marketplace/-/tree/main/skills/pdf',
    );
    expect(entryWebUrl('gitee', { path: 'plugins/notion' })).toBe(
      'https://gitee.com/wevir-labs/wevir-marketplace/tree/main/plugins/notion',
    );
  });

  it('发布者：核实过的优先，其次作者', () => {
    const base = index.entries[1] as MarketEntry;
    expect(entryPublisher(base)).toBe('Acme Maps');
    expect(
      entryPublisher({
        ...base,
        verification: { level: 'verified', publisher: 'Acme Inc.', since: '2026-10' },
      }),
    ).toBe('Acme Inc.');
  });

  it('首字、认证月份与 README 解码', () => {
    expect(entryInitial(' atlas')).toBe('A');
    expect(entryInitial('笔记')).toBe('笔');
    expect(entryInitial('')).toBe('?');
    expect(verificationMonth('2026-10', 'en')).toBe('October 2026');
    expect(verificationMonth('2026-10', 'zh-CN')).toBe('2026年10月');
    expect(verificationMonth('soon', 'en')).toBe('soon');
    expect(decodeText(Buffer.from('# 笔记\n').toString('base64'))).toBe('# 笔记\n');
  });
});
