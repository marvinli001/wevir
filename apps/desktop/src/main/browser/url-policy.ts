// 内置浏览器的地址规则（0.33.0，docs/security.md）：页面只能是 http(s)；页面里的资源另外可以是 data / blob（图片、脚本生成的
// 内容）与 ws(s)；file:、Wevir 自己的 wevir:、chrome: / devtools: 与各种外部协议一律不放行，也不交给系统。

const PAGE_PROTOCOLS = new Set(['http:', 'https:']);
const SUBFRAME_PROTOCOLS = new Set(['http:', 'https:', 'data:', 'blob:', 'about:']);
const RESOURCE_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:', 'data:', 'blob:']);

function protocolOf(url: string): string | undefined {
  try {
    return new URL(url).protocol;
  } catch {
    return undefined;
  }
}

/** 标签页能跳转到的地址（主框架）：http(s)。 */
export function isAllowedNavigation(url: string): boolean {
  const protocol = protocolOf(url);
  return protocol !== undefined && PAGE_PROTOCOLS.has(protocol);
}

/**
 * session 的请求关口（`webRequest.onBeforeRequest`）：主框架只放行 http(s) 与新标签页的 about:blank，子框架另外放行
 * data / blob / about，其余资源放行 http(s)、ws(s)、data、blob。
 */
export function isAllowedRequest(url: string, resourceType: string): boolean {
  const protocol = protocolOf(url);
  if (protocol === undefined) return false;
  if (resourceType === 'mainFrame') return PAGE_PROTOCOLS.has(protocol) || url === 'about:blank';
  if (resourceType === 'subFrame') return SUBFRAME_PROTOCOLS.has(protocol);
  return RESOURCE_PROTOCOLS.has(protocol);
}

/**
 * 用户在地址栏里敲的：带 http(s) 的照用；本机地址与 IP 补 http，其余补 https；有空白或别的协议的不认（不接搜索引擎）。
 */
export function addressToUrl(input: string): string | undefined {
  const value = input.trim();
  if (value === '' || /\s/.test(value)) return undefined;
  let candidate = value;
  if (!/^https?:\/\//i.test(value)) {
    if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(value)) return undefined;
    const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|\d+\.\d+\.\d+\.\d+)(:\d+)?(\/|$)/i.test(
      value,
    );
    candidate = `${local ? 'http' : 'https'}://${value}`;
  }
  try {
    const url = new URL(candidate);
    return PAGE_PROTOCOLS.has(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}
