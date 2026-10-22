// 订阅来源后面的上游列表（0.56.0 `account.upstreams`）的纯逻辑：哪些行先列、搜索、点“连接”要做什么、登录进行中给用户看什么。

import type { AccountState, AccountUpstream, AccountUpstreamMethod } from '@wevir/protocol';

/** 列表超过这个个数才给搜索框。 */
export const SEARCH_THRESHOLD = 8;

export interface UpstreamRows {
  rows: AccountUpstream[];
  /** 收起时没列出的个数；搜索中或已展开时是 0。 */
  hidden: number;
}

/**
 * 要列哪些行：默认只列常用的（`featured`），展开后列全部（常用的仍在前）；搜索时在全部里按名称与 ID 匹配，不分常用与否。
 */
export function visibleUpstreams(
  upstreams: readonly AccountUpstream[],
  options: { query: string; expanded: boolean },
): UpstreamRows {
  const query = options.query.trim().toLowerCase();
  const ordered = [...upstreams.filter((u) => u.featured), ...upstreams.filter((u) => !u.featured)];
  if (query !== '') {
    return {
      rows: ordered.filter(
        (u) => u.name.toLowerCase().includes(query) || u.id.toLowerCase().includes(query),
      ),
      hidden: 0,
    };
  }
  if (options.expanded) return { rows: ordered, hidden: 0 };
  const rows = ordered.filter((u) => u.featured);
  return { rows, hidden: ordered.length - rows.length };
}

/** 点“连接”：只有一种 OAuth 方式的直接开始；只有填 Key 的展开输入框；有好几种的展开让用户选。 */
export type ConnectMode = 'oauth' | 'key' | 'choose';

export function connectMode(upstream: AccountUpstream): ConnectMode {
  const [only] = upstream.methods;
  if (upstream.methods.length === 1 && only !== undefined) {
    return only.type === 'oauth' ? 'oauth' : 'key';
  }
  return 'choose';
}

/** `account.login` 的参数（`method` 是协议必填的字段，OpenCode 按上游自己的方式定，不看它）。 */
export function connectParams(
  ref: { kind: AccountState['kind']; id?: string },
  upstream: AccountUpstream,
  method: AccountUpstreamMethod,
  apiKey?: string,
) {
  return {
    ...ref,
    method: 'browser' as const,
    upstream: upstream.id,
    option: method.option,
    ...(apiKey !== undefined && { apiKey: apiKey.trim() }),
  };
}

/** 进行中的登录给用户看什么：设备码（网址加码）、浏览器授权（网址），或还没有网址。 */
export type LoginPrompt =
  | { kind: 'device_code'; url: string; code: string }
  | { kind: 'browser'; url: string }
  | { kind: 'waiting' };

export function loginPrompt(login: AccountState['login']): LoginPrompt | undefined {
  if (login === undefined) return undefined;
  if (login.userCode !== undefined && login.verificationUrl !== undefined) {
    return { kind: 'device_code', url: login.verificationUrl, code: login.userCode };
  }
  const url = login.authUrl ?? login.verificationUrl;
  return url === undefined ? { kind: 'waiting' } : { kind: 'browser', url };
}

/** 账号状态里哪些字段变了，上游列表就要重新读（接上、断开、登录开始与结束）。 */
export function upstreamsStamp(account: AccountState): string {
  return [account.status, account.plan, account.planLabel, account.login?.loginId].join('|');
}
