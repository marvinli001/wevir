// 插件市场（0.90.0）：官方市场仓库 wevir-marketplace 的索引格式，与读取镜像的选择。
// 本文件只依赖 zod：scripts/plugin-schema.ts 用 Node 直接加载它生成 schemas/wevir-market.schema.json。
import { z } from 'zod';
import {
  LocaleTagSchema,
  MarketCategoryIdSchema,
  PluginIdSchema,
  PluginInputSchema,
  SemverSchema,
  WevirPluginManifestSchema,
} from './plugins.js';

const text = z.string().min(1);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const commit = z.string().regex(/^[0-9a-f]{40}$/);
/** 仓库内相对路径，不以 `/` 或 `./` 开头，没有 `..` 段与反斜杠。 */
const repoPath = z
  .string()
  .max(512)
  .regex(/^(?!\.{1,2}(?:\/|$))[^/\\]+(?:\/(?!\.{1,2}(?:\/|$))[^/\\]+)*$/);
const localized = z.record(LocaleTagSchema, z.string().min(1).max(128));

/** 条目类型，由 CI 按包内容推导：只有一个 skill 是 `skill`，只有连接器是 `mcp`，其余是 `plugin`。 */
export const MarketEntryKindSchema = z.enum(['plugin', 'mcp', 'skill']);
export type MarketEntryKind = z.infer<typeof MarketEntryKindSchema>;
/** 信任级别：`official` 由 Wevir 维护，`community` 由社区投稿、经维护者审核。 */
export const MarketTrustSchema = z.enum(['official', 'community']);

export const MarketEntrySchema = z.strictObject({
  id: PluginIdSchema,
  kind: MarketEntryKindSchema,
  /** 条目目录，如 `plugins/notion`、`skills/pdf`。 */
  path: repoPath,
  name: z.string().min(1).max(128),
  version: SemverSchema,
  description: z.string().max(1024).optional(),
  i18n: WevirPluginManifestSchema.shape.i18n,
  author: z.strictObject({ name: text, url: z.string().optional() }).optional(),
  homepage: z.string().optional(),
  license: z.string().max(128).optional(),
  /** 仓库内路径。 */
  icon: repoPath.optional(),
  category: MarketCategoryIdSchema.optional(),
  keywords: z.array(z.string()).optional(),
  trust: MarketTrustSchema,
  requires: WevirPluginManifestSchema.shape.requires,
  /** 详情页与风险提示用，不必先下载包。 */
  contents: z.strictObject({
    connectors: z.array(
      z.strictObject({
        name: text,
        transport: z.enum(['stdio', 'http']),
        command: z.string().optional(),
        args: z.array(z.string()).optional(),
        url: z.string().optional(),
      }),
    ),
    skills: z.array(z.strictObject({ name: text, description: z.string() })),
    inputs: z.array(PluginInputSchema),
  }),
  /** 条目目录下的全部文件，路径相对条目目录。 */
  files: z.array(z.strictObject({ path: repoPath, size: z.number().int().min(0), sha256 })).min(1),
  /** `files` 按路径排序后，每行 `<sha256>  <path>\n` 拼起来的 sha256。 */
  digest: sha256,
  /** 最近的旧版本，新的在前。 */
  history: z
    .array(z.strictObject({ version: SemverSchema, commit }))
    .max(5)
    .optional(),
});
export type MarketEntry = z.infer<typeof MarketEntrySchema>;

/** `dist` 分支的 `index.json`；`index.json.sig` 是对它原始字节的 ed25519 签名（base64）。 */
export const WevirMarketIndexSchema = z.strictObject({
  $schema: z.string().optional(),
  schemaVersion: z.literal(1),
  name: z.string().min(1).max(128),
  generatedAt: z.iso.datetime(),
  /** 每次发布加一；客户端拒绝比缓存小的，防回滚。 */
  sequence: z.number().int().min(1),
  /** 条目文件按这个 `main` 提交读取。 */
  commit,
  categories: z.array(z.strictObject({ id: MarketCategoryIdSchema, name: localized })),
  featured: z.array(
    z.strictObject({
      id: MarketCategoryIdSchema,
      name: localized,
      entries: z.array(PluginIdSchema),
    }),
  ),
  entries: z.array(MarketEntrySchema),
});
export type WevirMarketIndex = z.infer<typeof WevirMarketIndexSchema>;

/** 官方市场的镜像。 */
export const MarketMirrorSchema = z.enum(['github', 'cnb', 'gitee']);
export type MarketMirror = z.infer<typeof MarketMirrorSchema>;
/** 设置里的选择：`auto` 首次测速后记住最快的那家，之后一直用它。 */
export const MarketMirrorPreferenceSchema = z.enum(['auto', ...MarketMirrorSchema.options]);
export type MarketMirrorPreference = z.infer<typeof MarketMirrorPreferenceSchema>;

const MarketStatusSchema = z.object({
  /** 设置里的选择（`settings.marketMirror`，省略按 `auto`）。 */
  preference: MarketMirrorPreferenceSchema,
  /** 现在用的镜像：手动选的那家，或自动测速后记住的那家；三家都测不通时省略。 */
  mirror: MarketMirrorSchema.optional(),
});
export type MarketStatus = z.infer<typeof MarketStatusSchema>;

/** Host 功能 `plugin_market`（0.90.0）。 */
export const MarketMethodSchemas = {
  /** 自动模式下还没测过速时先测速（几秒），结果记在数据目录里。 */
  'market.status': {
    params: z.object({}),
    result: MarketStatusSchema,
    permission: 'host.manage',
  },
  /**
   * 官方市场的索引。默认用一小时内的缓存；`refresh` 强制重新读取。从选定的镜像读，读不到或验签失败时依次换另外两家；
   * 都失败且有缓存时返回缓存并带 `error`，没有缓存时回 ENGINE_ERROR。
   */
  'market.index': {
    params: z.object({ refresh: z.boolean().optional() }),
    result: z.object({
      index: WevirMarketIndexSchema,
      /** 这份索引来自哪个镜像。 */
      mirror: MarketMirrorSchema,
      fetchedAt: z.iso.datetime(),
      /** 这次刷新失败的原因；索引是之前的缓存。 */
      error: z.string().optional(),
    }),
    permission: 'host.manage',
  },
} as const;

/** 索引的 JSON Schema，scripts/plugin-schema.ts 写进 schemas/wevir-market.schema.json。 */
export function wevirMarketJsonSchema(): Record<string, unknown> {
  return {
    ...z.toJSONSchema(WevirMarketIndexSchema, { io: 'input' }),
    title: 'Wevir marketplace index (index.json)',
  };
}
