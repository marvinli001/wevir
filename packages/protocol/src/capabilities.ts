import { z } from 'zod';

// 能力位、功能与权限（host-api.md「兼容规则」）。三者都是开放集合：认不出的键或值照常接受，
// 新老两端互相解析时不会因为对方多了一项而失败。

/**
 * 客户端能力位：客户端在 `host.hello` 里声明自己能理解的新线缆形状，Host 据此决定发新形状还是降级。
 * 新增时按下面的格式写，并在 host-api.md 的能力表里登记：
 *
 * ```ts
 * // COMPAT(fooEnum): added in 0.2.0, remove gate after 2027-06-01
 * fooEnum: 'foo_enum',
 * ```
 */
export const CLIENT_CAPABILITIES = {
  // COMPAT(titleSourceGenerated): added in 0.5.0, remove gate after 2027-06-01
  /** 认得 `TitleSource` 的 `generated`；没有时 Host 把它降级成 `first_prompt`。 */
  titleSourceGenerated: 'title_source_generated',
} as const;
export type ClientCapability = (typeof CLIENT_CAPABILITIES)[keyof typeof CLIENT_CAPABILITIES];

/** 已知能力位写成 `z.boolean().optional()`；未知键原样保留。 */
export const ClientCapabilitiesSchema = z.looseObject({
  title_source_generated: z.boolean().optional(),
});
export type ClientCapabilities = z.infer<typeof ClientCapabilitiesSchema>;

/**
 * Host 功能：Host 在 `host.hello` 结果里声明，客户端在一处判断是启用功能还是提示升级 Host。
 * v0 是基线，没有功能项；新增方式同 `CLIENT_CAPABILITIES`。
 */
export const HOST_FEATURES = {} as const;
export type HostFeature = (typeof HOST_FEATURES)[keyof typeof HOST_FEATURES];

export const HostFeaturesSchema = z.looseObject({});
export type HostFeatures = z.infer<typeof HostFeaturesSchema>;

/**
 * 权限词表。每个方法需要其中一项（`MethodSchemas[*].permission`）；骨架阶段 Host 对每个连接都给全部，
 * 词表为将来的设备权限预留（ADR-0002 未决事项 3）。
 */
export const PERMISSIONS = [
  'host.manage',
  'workspace.read',
  'workspace.write',
  'provider.read',
  'provider.write',
  'session.read',
  'session.write',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** 线缆上是开放的字符串数组，旧客户端遇到新权限名不会解析失败。 */
export const PermissionsSchema = z.array(z.string().min(1));
