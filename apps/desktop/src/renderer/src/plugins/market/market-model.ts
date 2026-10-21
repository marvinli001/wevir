// 插件页“市场”分段的纯逻辑（plugin-market.md §9）：多语言取值、分组（先推荐位再按分类）、本地搜索、上游与网页地址、
// 认证月份与图标类型。数据是 `market.index` 的结果，不碰 DOM 与 Host，组件与测试都用它。

import type {
  MarketEntry,
  MarketEntryKind,
  MarketMirror,
  MarketVerificationLevel,
  WevirMarketIndex,
} from '@wevir/protocol';
import type { PlainMessageKey } from '@/i18n';

/** 内置的官方源；第三方源做好前只有它（路由 `/plugins/market/:source/:entry` 的 `source`）。 */
export const OFFICIAL_SOURCE = 'official';
/** 首页每组最多显示几个，其余进分组的完整列表。 */
export const GROUP_PREVIEW_LIMIT = 6;

type Localized = Readonly<Record<string, string>>;

/** 分类与推荐位的名字：当前语言 → 英语 → 简体中文 → 任意一种；都没有时用 `fallback`。 */
export function localizedName(name: Localized, locale: string, fallback: string): string {
  return name[locale] ?? name.en ?? name['zh-CN'] ?? Object.values(name)[0] ?? fallback;
}

export interface EntryText {
  name: string;
  description: string;
  examples: readonly string[];
}

/** 条目的名称、描述与示例：当前语言的 i18n 有就用，没有用条目本身的（作者写的那种语言）。 */
export function entryText(entry: MarketEntry, locale: string): EntryText {
  const local = entry.i18n?.[locale];
  return {
    name: local?.name ?? entry.name,
    description: (local?.description ?? entry.description ?? '').replace(/\s+/g, ' ').trim(),
    examples: local?.examples ?? entry.examples ?? [],
  };
}

export interface MarketGroup {
  id: string;
  name: string;
  entries: MarketEntry[];
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/**
 * 首页的分组：先推荐位（按索引顺序，条目按推荐位里的顺序，不在索引里的跳过），再按分类表的顺序每类一组（组内按名字排）；
 * 没有条目的组不要。分类不在分类表里的条目归“其他”（`other`），分类表里也没有“其他”时不显示。
 */
export function marketGroups(index: WevirMarketIndex, locale: string): MarketGroup[] {
  const byId = new Map(index.entries.map((entry) => [entry.id, entry]));
  const featured = index.featured.map((group) => ({
    id: group.id,
    name: localizedName(group.name, locale, group.id),
    entries: group.entries.flatMap((id) => byId.get(id) ?? []),
  }));
  const known = new Set(index.categories.map((category) => category.id));
  const sorted = [...index.entries].sort((a, b) =>
    collator.compare(entryText(a, locale).name, entryText(b, locale).name),
  );
  const categories = index.categories.map((category) => ({
    id: category.id,
    name: localizedName(category.name, locale, category.id),
    entries: sorted.filter((entry) =>
      known.has(entry.category) ? entry.category === category.id : category.id === 'other',
    ),
  }));
  return [...featured, ...categories].filter((group) => group.entries.length > 0);
}

/** 分组的完整列表（`/plugins/market/group/:id`）；推荐位与分类同名时推荐位优先。 */
export function findGroup(
  index: WevirMarketIndex,
  locale: string,
  id: string,
): MarketGroup | undefined {
  return marketGroups(index, locale).find((group) => group.id === id);
}

const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase();

/**
 * 本地搜索：按空白分词，每个词都要在名称、描述（含各语言）、关键词或作者里出现。名称里命中的排在前面，其余按名字排。
 * 空的查询返回空表（调用方显示分组）。
 */
export function searchEntries(
  index: WevirMarketIndex,
  query: string,
  locale: string,
): MarketEntry[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const scored = index.entries.flatMap((entry) => {
    const names = [entry.name, ...Object.values(entry.i18n ?? {}).flatMap((t) => t.name ?? [])];
    const haystack = normalize(
      [
        ...names,
        entry.description ?? '',
        ...Object.values(entry.i18n ?? {}).flatMap((t) => t.description ?? []),
        ...(entry.keywords ?? []),
        entry.author?.name ?? '',
        entry.id,
      ].join('\n'),
    );
    if (!terms.every((term) => haystack.includes(term))) return [];
    const nameText = normalize(names.join('\n'));
    return [{ entry, inName: terms.some((term) => nameText.includes(term)) }];
  });
  return scored
    .sort(
      (a, b) =>
        Number(b.inName) - Number(a.inName) ||
        collator.compare(entryText(a.entry, locale).name, entryText(b.entry, locale).name),
    )
    .map(({ entry }) => entry);
}

/** 名称首字（没有图标时的占位块）。 */
export function entryInitial(name: string): string {
  return (Array.from(name.trim())[0] ?? '?').toLocaleUpperCase();
}

const ICON_TYPES: Record<string, string> = {
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** 图标的 MIME 类型（按扩展名）；认不出的不显示，用占位块。 */
export function iconMimeType(path: string): string | undefined {
  return ICON_TYPES[path.split('.').pop()?.toLowerCase() ?? ''];
}

/**
 * 图标在条目目录里的路径（`market.file` 要相对条目目录的路径）：索引的 `icon` 是仓库路径，不在条目目录下或不在 `files` 里
 * 时没有。
 */
export function entryIconPath(entry: MarketEntry): string | undefined {
  if (entry.icon === undefined || !entry.icon.startsWith(`${entry.path}/`)) return undefined;
  const path = entry.icon.slice(entry.path.length + 1);
  return entry.files.some((file) => file.path === path) && iconMimeType(path) !== undefined
    ? path
    : undefined;
}

/** README 在条目目录里的路径（不分大小写），没有时详情页用描述。 */
export function entryReadmePath(entry: MarketEntry): string | undefined {
  return entry.files.find((file) => file.path.toLowerCase() === 'readme.md')?.path;
}

/**
 * 上游项目的简称：GitHub、GitLab、Gitee、Codeberg、CNB 的仓库写 `owner/repo`，npm 与 PyPI 的包写包名，其余写主机与路径。
 */
export function upstreamLabel(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const host = parsed.hostname.replace(/^www\./, '');
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (['github.com', 'gitlab.com', 'gitee.com', 'codeberg.org', 'cnb.cool'].includes(host)) {
    if (parts.length >= 2) return `${parts[0]}/${(parts[1] ?? '').replace(/\.git$/, '')}`;
  }
  if (host === 'npmjs.com' && parts[0] === 'package' && parts.length >= 2) {
    return parts[1]?.startsWith('@') ? `${parts[1]}/${parts[2] ?? ''}` : (parts[1] ?? url);
  }
  if (host === 'pypi.org' && parts[0] === 'project' && parts[1]) return parts[1];
  return `${host}${parsed.pathname.replace(/\/$/, '')}`;
}

/** 官方市场仓库在各镜像上的网页地址（“复制链接”）：`main` 分支上的条目目录。 */
const MIRROR_WEB: Record<MarketMirror, (path: string) => string> = {
  github: (path) => `https://github.com/Wevir-Labs/wevir-marketplace/tree/main/${path}`,
  cnb: (path) => `https://cnb.cool/wevir-labs/wevir-marketplace/-/tree/main/${path}`,
  gitee: (path) => `https://gitee.com/wevir-labs/wevir-marketplace/tree/main/${path}`,
};

export function entryWebUrl(mirror: MarketMirror, entry: Pick<MarketEntry, 'path'>): string {
  return MIRROR_WEB[mirror](entry.path.split('/').map(encodeURIComponent).join('/'));
}

/** 认证的年月（`YYYY-MM`）按界面语言写成“2026 年 10 月”这类；格式不对时原样返回。 */
export function verificationMonth(since: string, locale: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(since);
  if (!match) return since;
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)));
}

export const KIND_LABEL: Record<MarketEntryKind, PlainMessageKey> = {
  plugin: 'plugins.market.kind.plugin',
  mcp: 'plugins.market.kind.mcp',
  skill: 'plugins.market.kind.skill',
};

export const VERIFICATION_LABEL: Record<MarketVerificationLevel, PlainMessageKey> = {
  official: 'plugins.market.badge.official',
  verified: 'plugins.market.badge.verified',
};

/** 详情页“由〈作者〉提供”的名字：核实过的发布者优先，其次作者。 */
export function entryPublisher(entry: MarketEntry): string | undefined {
  return entry.verification?.publisher ?? entry.author?.name;
}

/** base64 解成 UTF-8 文本（README）。 */
export function decodeText(base64: string): string {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
