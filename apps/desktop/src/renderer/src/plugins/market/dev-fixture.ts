// 开发用的假市场（只在 `pnpm dev` 且设了 `VITE_WEVIR_FAKE_MARKET` 时由 use-market.ts 动态加载，正式构建里没有）：官方市场
// 现在一个条目都没有，点验市场分段与详情页用它。条目覆盖 official、verified、无认证、有上游、有示例、没图标与三种类型。
// `VITE_WEVIR_FAKE_MARKET=stale` 时刷新回缓存并带 `error`（警告点），`=fail` 时读取失败（空状态与重试）。安装是假的：先等一会儿，
// 再用几秒按字节报进度，最后停在发布阶段一下；`sql-explorer` 下到一半失败。不会真装上，按钮装完回到“安装插件”。

import type { MarketEntry, MarketInstallProgress, Plugin, WevirMarketIndex } from '@wevir/protocol';
import type { MarketIndexResult, MarketSource } from './use-market';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const HASH = 'f'.repeat(64);
const MODE = import.meta.env.VITE_WEVIR_FAKE_MARKET;

const icon = (background: string, glyph: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${background}"/><text x="32" y="42" font-family="Helvetica, Arial, sans-serif" font-size="28" font-weight="700" fill="#fff" text-anchor="middle">${glyph}</text></svg>`;

/** 条目目录下的文件：路径 → 内容。 */
const FILES: Record<string, Record<string, string>> = {
  'wevir-browser': {
    'icon.svg': icon('#9b7840', 'W'),
    'README.md':
      '# Wevir Browser\n\nDrive the built-in browser from any session: open pages, read the DOM and take screenshots.\n\n## Tools\n\n- `browser_open` — open a URL in a new tab\n- `browser_snapshot` — read the page as an accessibility tree\n- `browser_screenshot` — capture the visible area\n\n```bash\nwevir plugins enable wevir-browser\n```\n',
  },
  notion: {
    'icon.svg': icon('#191919', 'N'),
    'README.md':
      '# Notion\n\nSearch, read and update pages and databases in your Notion workspace.\n\nThis entry tracks the official [notion-mcp-server](https://github.com/makenotion/notion-mcp-server).\n',
  },
  github: { 'icon.svg': icon('#24292f', 'G') },
  linear: { 'icon.svg': icon('#5e6ad2', 'L') },
  'pdf-tools': {},
  'sql-explorer': { 'icon.svg': icon('#2f6b42', 'S') },
  'trip-planner': {},
  'unicode-lookup': {},
};

function files(id: string): MarketEntry['files'] {
  const own = Object.entries(FILES[id] ?? {}).map(([path, text]) => ({
    path,
    size: new TextEncoder().encode(text).length,
    sha256: HASH,
  }));
  return [{ path: 'wevir-plugin.json', size: 512, sha256: HASH }, ...own];
}

function entry(
  id: string,
  patch: Partial<MarketEntry> & Pick<MarketEntry, 'name' | 'kind' | 'category'>,
): MarketEntry {
  const path = `${patch.kind === 'skill' ? 'skills' : 'plugins'}/${id}`;
  return {
    id,
    path,
    version: '1.0.0',
    listedAt: '2026-10-21T08:00:00Z',
    contents: { connectors: [], skills: [], inputs: [] },
    files: files(id),
    digest: HASH,
    ...(FILES[id]?.['icon.svg'] !== undefined && { icon: `${path}/icon.svg` }),
    ...patch,
  };
}

const INDEX: WevirMarketIndex = {
  schemaVersion: 1,
  name: 'Wevir (dev fixture)',
  generatedAt: '2026-10-21T08:00:00Z',
  sequence: 1,
  commit: COMMIT,
  categories: [
    { id: 'productivity', name: { 'zh-CN': '效率', en: 'Productivity' } },
    { id: 'developer-tools', name: { 'zh-CN': '开发者工具', en: 'Developer tools' } },
    { id: 'data', name: { 'zh-CN': '数据与分析', en: 'Data & analytics' } },
    { id: 'travel', name: { 'zh-CN': '旅行', en: 'Travel' } },
    { id: 'other', name: { 'zh-CN': '其他', en: 'Other' } },
  ],
  featured: [
    {
      id: 'popular',
      name: { 'zh-CN': '热门', en: 'Popular' },
      entries: [
        'notion',
        'wevir-browser',
        'github',
        'linear',
        'pdf-tools',
        'sql-explorer',
        'trip-planner',
      ],
    },
  ],
  entries: [
    entry('wevir-browser', {
      name: 'Wevir Browser',
      kind: 'plugin',
      category: 'developer-tools',
      version: '1.2.0',
      description: 'Drive the built-in browser: open pages, read the DOM and take screenshots.',
      i18n: {
        'zh-CN': {
          description: '在会话里操作内置浏览器：打开网页、读取页面结构、截图。',
          examples: ['打开 localhost:5173，截一张首页的图', '检查登录页有没有控制台报错'],
        },
      },
      author: { name: 'Wevir', url: 'https://wevir.dev' },
      homepage: 'https://wevir.dev',
      license: 'Apache-2.0',
      keywords: ['browser', 'screenshot'],
      verification: { level: 'official', since: '2026-10' },
      examples: ['Open localhost:5173 and take a screenshot of the home page'],
      contents: {
        connectors: [
          {
            name: 'wevir-browser',
            transport: 'stdio',
            command: 'node',
            args: ['server/index.js', '--headless'],
          },
        ],
        skills: [
          { name: 'page-audit', description: 'Audit a page for console errors and broken links.' },
        ],
        inputs: [],
      },
      links: { privacy: 'https://wevir.dev/privacy', terms: 'https://wevir.dev/terms' },
      requires: { runtimes: ['node>=20'] },
    }),
    entry('notion', {
      name: 'Notion',
      kind: 'mcp',
      category: 'productivity',
      version: '1.0.3',
      description: 'Search, read and update pages and databases in your Notion workspace.',
      i18n: {
        'zh-CN': {
          description: '搜索、阅读和更新 Notion 工作区里的页面与数据库。',
          examples: [
            '把今天的会议记录整理成 Notion 页面',
            '在“项目”数据库里找出本周到期的任务',
            '总结“产品路线图”页面的最新改动',
          ],
        },
      },
      author: { name: 'Notion Labs', url: 'https://www.notion.so' },
      homepage: 'https://www.notion.so',
      license: 'MIT',
      keywords: ['docs', 'wiki', 'notes'],
      verification: {
        level: 'verified',
        publisher: 'Notion Labs',
        since: '2026-10',
        note: {
          'zh-CN': '连接 Notion 官方托管的 MCP 服务',
          en: 'Connects to the MCP server hosted by Notion',
        },
      },
      upstream: {
        url: 'https://github.com/makenotion/notion-mcp-server',
        version: '2.4.0',
        commit: 'a'.repeat(40),
        license: 'MIT',
      },
      examples: [
        'Turn today’s meeting notes into a Notion page',
        'Find tasks due this week in the Projects database',
        'Summarize the latest changes to the Roadmap page',
      ],
      contents: {
        connectors: [{ name: 'notion', transport: 'http', url: 'https://mcp.notion.com/mcp' }],
        skills: [],
        inputs: [],
      },
      links: { privacy: 'https://www.notion.so/privacy', terms: 'https://www.notion.so/terms' },
    }),
    entry('github', {
      name: 'GitHub',
      kind: 'mcp',
      category: 'developer-tools',
      description: 'Issues, pull requests and code search across your repositories.',
      author: { name: 'GitHub' },
      verification: { level: 'verified', publisher: 'GitHub, Inc.', since: '2026-09' },
      upstream: { url: 'https://github.com/github/github-mcp-server', version: '0.9.1' },
      contents: {
        connectors: [
          {
            name: 'github',
            transport: 'stdio',
            command: 'docker',
            args: ['run', '-i', '--rm', '-e', 'GITHUB_TOKEN', 'ghcr.io/github/github-mcp-server'],
          },
        ],
        skills: [],
        inputs: [{ key: 'GITHUB_TOKEN', label: 'Token', secret: true, required: true }],
      },
    }),
    entry('linear', {
      name: 'Linear',
      kind: 'mcp',
      category: 'productivity',
      description: 'Create and update Linear issues without leaving the conversation.',
      author: { name: 'Community' },
      upstream: { url: 'https://www.npmjs.com/package/@community/linear-mcp', version: '0.3.0' },
      contents: {
        connectors: [
          {
            name: 'linear',
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@community/linear-mcp'],
          },
        ],
        skills: [],
        inputs: [],
      },
    }),
    entry('pdf-tools', {
      name: 'PDF Tools',
      kind: 'skill',
      category: 'productivity',
      description: 'Fill forms, merge files and extract tables from PDF documents.',
      author: { name: 'Community' },
      contents: {
        connectors: [],
        skills: [{ name: 'pdf-tools', description: 'Fill forms, merge files and extract tables.' }],
        inputs: [],
      },
    }),
    entry('sql-explorer', {
      name: 'SQL Explorer',
      kind: 'plugin',
      category: 'data',
      description:
        'Explore SQLite and Postgres databases, explain query plans and chart the results in a long description that should truncate.',
      author: { name: 'Data Folks' },
      verification: { level: 'verified', publisher: 'Data Folks GmbH', since: '2026-08' },
      examples: ['Which tables in app.db have no index on their foreign keys?'],
      contents: {
        connectors: [
          { name: 'sql', transport: 'stdio', command: 'uvx', args: ['sql-explorer-mcp'] },
        ],
        skills: [
          { name: 'query-review', description: 'Review a SQL query for performance issues.' },
        ],
        inputs: [],
      },
      requires: { runtimes: ['python>=3.11'] },
    }),
    entry('trip-planner', {
      name: 'Trip Planner',
      kind: 'skill',
      category: 'travel',
      description: 'Plan itineraries with day-by-day schedules and packing lists.',
      contents: {
        connectors: [],
        skills: [
          { name: 'trip-planner', description: 'Day-by-day itineraries and packing lists.' },
        ],
        inputs: [],
      },
    }),
    entry('unicode-lookup', {
      name: 'Unicode Lookup',
      kind: 'skill',
      category: 'unknown-category',
      contents: {
        connectors: [],
        skills: [{ name: 'unicode-lookup', description: 'Look up code points.' }],
        inputs: [],
      },
    }),
  ],
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const installListeners = new Set<(progress: MarketInstallProgress) => void>();
const cancelled = new Set<string>();

export const fakeMarketSource: MarketSource = {
  async index(refresh) {
    await delay(refresh ? 900 : 500);
    if (MODE === 'fail') throw new Error('could not read the plugin market: github: HTTP 503');
    const result: MarketIndexResult = {
      index: INDEX,
      mirror: 'github',
      fetchedAt: new Date().toISOString(),
    };
    return MODE === 'stale' && refresh
      ? { ...result, error: 'github: HTTP 503; cnb: fetch failed; gitee: HTTP 502' }
      : result;
  },
  async file(entryId, path) {
    await delay(150);
    const text = FILES[entryId]?.[path];
    if (text === undefined) throw new Error(`no ${entryId}/${path}`);
    const bytes = new TextEncoder().encode(text);
    return btoa(String.fromCharCode(...bytes));
  },
  async install(entryId) {
    const entry = INDEX.entries.find((item) => item.id === entryId);
    if (entry === undefined) throw new Error(`no market entry ${entryId}`);
    cancelled.delete(entryId);
    const totalBytes = 2_400_000;
    const emit = (phase: MarketInstallProgress['phase'], receivedBytes: number) => {
      for (const listener of installListeners)
        listener({ entry: entryId, phase, receivedBytes, totalBytes });
    };
    const check = () => {
      if (cancelled.has(entryId)) throw new Error(`installing ${entryId} was cancelled`);
    };
    await delay(700);
    for (let step = 0; step <= 20; step++) {
      check();
      if (entryId === 'sql-explorer' && step === 11)
        throw new Error('could not read server/index.js from the plugin market: HTTP 503');
      emit('download', Math.round((totalBytes * step) / 20));
      await delay(120 + Math.random() * 120);
    }
    emit('install', totalBytes);
    await delay(600);
    check();
    const plugin: Plugin = {
      id: entry.id,
      name: entry.name,
      version: entry.version,
      source: 'wevir',
      enabled: true,
      path: `/tmp/${entry.id}`,
      inputs: [],
      connectors: [],
      skills: [],
    };
    return { plugin, ignored: [] };
  },
  async cancelInstall(entryId) {
    cancelled.add(entryId);
  },
  onInstallProgress(listener) {
    installListeners.add(listener);
    return () => installListeners.delete(listener);
  },
};
