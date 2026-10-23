// 系统交给 App 的链接 → 配对链接（`wevir://pair?…`）。纯逻辑。

import { PAIRING_URI_PREFIX } from '@wevir/protocol';

/** 是配对链接时原样返回（`a` 参数可以重复，不能拆成路由参数）；有的系统只给路径部分（`/pair?…`），补回前缀。 */
export function pairingLinkFromPath(path: string): string | undefined {
  if (path.startsWith(PAIRING_URI_PREFIX)) return path;
  const match = /^\/?pair\?/.exec(path);
  return match === null ? undefined : `${PAIRING_URI_PREFIX}${path.slice(match[0].length)}`;
}

/** expo-router 的 `redirectSystemPath`：配对链接去添加电脑页，其他照旧。 */
export function redirectSystemPath(path: string): string {
  const link = pairingLinkFromPath(path);
  return link === undefined ? path : `/add?link=${encodeURIComponent(link)}`;
}
