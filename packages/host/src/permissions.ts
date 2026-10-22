import {
  type ClientIdentity,
  type MethodName,
  type MethodParams,
  MethodSchemas,
  PERMISSIONS,
  type Permission,
} from '@wevir/protocol';

/**
 * 连接的身份（domain-model §3.44，ADR-0017 §4）：出示了 `run/host.json` 令牌的本机连接是 `local`；远程设备是 `device`，
 * 权限取自它的设备记录（下一阶段）。只在 Host 里，不上线缆。
 */
export type ConnectionPrincipal = { kind: 'local' } | { kind: 'device'; deviceId: string };

/** hello 时定下的身份与权限，连接活着期间不变。 */
export interface ConnectionGrant {
  readonly principal: ConnectionPrincipal;
  readonly permissions: readonly Permission[];
}

/** 本机连接：全部权限，行为与权限执行之前相同。 */
export const LOCAL_GRANT: ConnectionGrant = Object.freeze({
  principal: Object.freeze({ kind: 'local' }),
  permissions: PERMISSIONS,
});

/**
 * 只给测试：hello 成功后按客户端身份给这条连接另一个 grant，返回 undefined 时是 `LOCAL_GRANT`。生产入口不传它（host-process.ts
 * 的 `startHost` 只透传调用方给的），也不读环境变量。
 */
export type TestConnectionGrant = (client: ClientIdentity) => ConnectionGrant | undefined;

/** 方法本身允许、某些参数要更高权限的情况（host-api.md §3 开头）。`applies` 拿到的是按 schema 解析过的参数。 */
interface ParamPermissionRule<M extends MethodName> {
  readonly permission: Permission;
  readonly applies: (params: MethodParams<M>) => boolean;
}

type ParamPermissionRules = {
  readonly [M in MethodName]?: readonly ParamPermissionRule<M>[];
};

const fullAccess = {
  permission: 'policy.write',
  applies: (params: { permissionMode?: string | undefined }) =>
    params.permissionMode === 'full_access',
} as const;

/**
 * 参数级检查的唯一一张表。只看请求里给的参数：沿用已有设置（`session.fork` 沿用原会话的权限模式、`automation.run` 按保存的权限
 * 模式运行）不算设置。
 */
export const PARAM_PERMISSION_RULES: ParamPermissionRules = {
  'session.create': [fullAccess],
  'session.configure': [fullAccess],
  'automation.create': [fullAccess],
  'automation.update': [fullAccess],
  // “总是允许”会写审批规则。
  'approval.respond': [
    { permission: 'policy.write', applies: (params) => params.remember !== undefined },
  ],
};

/** 只有本机连接能调的方法（0.107.0）：设备与配对的管理。远程设备即使有 `host.manage` 也不行。 */
export function isLocalOnlyMethod(method: MethodName): boolean {
  return method.startsWith('device.') || method.startsWith('pairing.');
}

/** 方法本身要的权限里这条连接缺的（0 或 1 个）。 */
export function missingMethodPermission(
  method: MethodName,
  granted: ReadonlySet<string>,
): Permission[] {
  const permission = MethodSchemas[method].permission;
  return permission === null || granted.has(permission) ? [] : [permission];
}

/** 参数要的权限里这条连接缺的，按表的顺序、不重复。 */
export function missingParamPermissions<M extends MethodName>(
  method: M,
  params: MethodParams<M>,
  granted: ReadonlySet<string>,
): Permission[] {
  const rules = (PARAM_PERMISSION_RULES[method] ?? []) as readonly ParamPermissionRule<M>[];
  const missing: Permission[] = [];
  for (const rule of rules) {
    if (granted.has(rule.permission) || missing.includes(rule.permission)) continue;
    if (rule.applies(params)) missing.push(rule.permission);
  }
  return missing;
}
