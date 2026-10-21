// 插件市场（0.91.0；0.93.0 改了条目字段并加了读取用的宽松版本）：官方市场仓库 wevir-marketplace 的索引格式，与读取镜像的选择。
// 本文件只依赖 zod：scripts/plugin-schema.ts 用 Node 直接加载它生成 schemas/wevir-market.schema.json。
import { z } from 'zod';
import {
  LocaleTagSchema,
  MarketCategoryIdSchema,
  PluginExamplesSchema,
  PluginIdSchema,
  PluginInputSchema,
  PluginUrlSchema,
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
/** 认证级别（0.93.0）：`official` 由 Wevir 维护，`verified` 经维护者审核并核实了发布者身份。 */
export const MarketVerificationLevelSchema = z.enum(['official', 'verified']);
export type MarketVerificationLevel = z.infer<typeof MarketVerificationLevelSchema>;

type ObjectFactory = typeof z.strictObject | typeof z.object;

/**
 * 索引的条目、分类与推荐位。`z.strictObject` 给 CI 与 JSON Schema，拒绝未知字段；
 * `z.object` 给客户端读取，丢掉未知字段，市场仓库以后加字段时旧客户端只是看不到。
 */
function marketSchemas(object: ObjectFactory) {
  const i18nFields = WevirPluginManifestSchema.shape.i18n.unwrap().valueType.shape;
  const verificationFields = {
    /** 首次认证的年月，`YYYY-MM`。 */
    since: z.string().regex(/^\d{4}-(?:0[1-9]|1[0-2])$/),
    /** 悬停卡片里多一行。 */
    note: z.record(LocaleTagSchema, z.string().min(1).max(280)).optional(),
  };
  const entry = object({
    id: PluginIdSchema,
    kind: MarketEntryKindSchema,
    /** 条目目录，如 `plugins/notion`、`skills/pdf`。 */
    path: repoPath,
    name: z.string().min(1).max(128),
    version: SemverSchema,
    description: z.string().max(1024).optional(),
    /** 名称、描述与示例的多语言版本。 */
    i18n: z.record(LocaleTagSchema, object(i18nFields)).optional(),
    author: object({ name: text, url: z.string().optional() }).optional(),
    homepage: z.string().optional(),
    license: z.string().max(128).optional(),
    /** 仓库内路径。 */
    icon: repoPath.optional(),
    /** 市场仓库的归类结果（0.93.0 起总是有）：仓库登记的、作者清单里建议的，都没有时是 `other`。 */
    category: MarketCategoryIdSchema,
    keywords: z.array(z.string()).optional(),
    /** 上架时间（0.93.0）：条目目录在 `main` 上首次出现的提交时间。 */
    listedAt: z.iso.datetime(),
    /** 认证（0.93.0），由市场仓库登记，作者改不了；`verified` 必须写核实过的发布者。 */
    verification: z
      .discriminatedUnion('level', [
        object({
          level: z.literal('official'),
          publisher: z.string().min(1).max(128).optional(),
          ...verificationFields,
        }),
        object({ level: z.literal('verified'), publisher: text.max(128), ...verificationFields }),
      ])
      .optional(),
    /** 搬自的外部项目（0.93.0），只给展示用，客户端不连。 */
    upstream: object({
      /** 仓库（带子目录时是 tree 链接）或包页面。 */
      url: PluginUrlSchema,
      /** 上游自己的版本。 */
      version: z.string().min(1).max(64).optional(),
      /** git 上游搬入的提交。 */
      commit: commit.optional(),
      /** SPDX。 */
      license: z.string().min(1).max(128).optional(),
    }).optional(),
    /** 示例 prompt（0.93.0）。 */
    examples: PluginExamplesSchema.optional(),
    /** 隐私政策与服务条款（0.93.0），来自清单的 `privacyPolicy` 与 `termsOfService`。 */
    links: object({
      privacy: PluginUrlSchema.optional(),
      terms: PluginUrlSchema.optional(),
    }).optional(),
    requires: object(WevirPluginManifestSchema.shape.requires.unwrap().shape).optional(),
    /** 详情页与风险提示用，不必先下载包。 */
    contents: object({
      connectors: z.array(
        object({
          name: text,
          transport: z.enum(['stdio', 'http']),
          command: z.string().optional(),
          args: z.array(z.string()).optional(),
          url: z.string().optional(),
        }),
      ),
      skills: z.array(object({ name: text, description: z.string() })),
      inputs: z.array(object(PluginInputSchema.shape)),
    }),
    /** 条目目录下的全部文件，路径相对条目目录。 */
    files: z.array(object({ path: repoPath, size: z.number().int().min(0), sha256 })).min(1),
    /** `files` 按路径排序后，每行 `<sha256>  <path>\n` 拼起来的 sha256。 */
    digest: sha256,
    /** 最近的旧版本，新的在前。 */
    history: z
      .array(object({ version: SemverSchema, commit }))
      .max(5)
      .optional(),
  });
  /** `dist` 分支的 `index.json`；`index.json.sig` 是对它原始字节的 ed25519 签名（base64）。 */
  const index = object({
    $schema: z.string().optional(),
    /** 只有不兼容的改动才升；客户端不认识的版本当作读取失败。 */
    schemaVersion: z.literal(1),
    name: z.string().min(1).max(128),
    generatedAt: z.iso.datetime(),
    /** 每次发布加一；客户端拒绝比缓存小的，防回滚。 */
    sequence: z.number().int().min(1),
    /** 条目文件按这个 `main` 提交读取。 */
    commit,
    categories: z.array(object({ id: MarketCategoryIdSchema, name: localized })),
    featured: z.array(
      object({
        id: MarketCategoryIdSchema,
        name: localized,
        entries: z.array(PluginIdSchema),
      }),
    ),
    entries: z.array(entry),
  });
  return { entry, index };
}

const strict = marketSchemas(z.strictObject);
const lenient = marketSchemas(z.object);

/** 严格版本：CI 与生成的 JSON Schema 用，拒绝未知字段。 */
export const MarketEntrySchema = strict.entry;
export type MarketEntry = z.infer<typeof MarketEntrySchema>;
export type MarketVerification = NonNullable<MarketEntry['verification']>;
export type MarketUpstream = NonNullable<MarketEntry['upstream']>;
export const WevirMarketIndexSchema = strict.index;
export type WevirMarketIndex = z.infer<typeof WevirMarketIndexSchema>;
/** 读取用的版本（0.93.0）：形状同上，但丢掉条目、分类、推荐位等各层的未知字段。Host 读索引与 `market.index` 的结果用它。 */
export const MarketEntryLenientSchema = lenient.entry;
export const WevirMarketIndexLenientSchema = lenient.index;

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

/** Host 功能 `plugin_market`（0.91.0）。 */
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
      index: WevirMarketIndexLenientSchema,
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
