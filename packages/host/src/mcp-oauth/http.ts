// MCP OAuth 的出站请求（元数据、注册、换令牌、撤销与探测）：只用 Node 内置的 http / https，不跟随跳转，响应体有上限，连接前按
// DNS 结果做 SSRF 检查（同 web/fetch-page.ts）。这些地址大多来自远程服务器的元数据，不能让它们把 Host 指到本机或局域网。

import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { isBlockedAddress, isLocalHostname } from '../web/address.js';

/** 响应体上限：元数据与令牌都很小。 */
export const OAUTH_RESPONSE_MAX_BYTES = 256 * 1024;
/** 单个请求的超时。 */
export const OAUTH_REQUEST_TIMEOUT_MS = 15_000;

/**
 * 允许去哪：`public` 只去公网的 https；连接器地址本身在本机回环上时是 `loopback`，另外放行本机回环（可以是 http，测试与本机开发服务器
 * 用）；连接器地址是局域网 IP 时是 `private`，另外放行局域网与本机（仍要 https）。
 */
export type AddressScope = 'public' | 'loopback' | 'private';

export class OAuthHttpError extends Error {
  constructor(
    readonly reason: 'insecure_endpoint' | 'network' | 'too_large',
    message: string,
  ) {
    super(message);
  }
}

export interface OAuthResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface OAuthRequestOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  scope: AddressScope;
  /** 连接器地址本身（用户自己填的）：不查 https 与地址范围。只给探测用。 */
  trusted?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  /** 测试用：换掉 DNS 解析。 */
  lookup?: typeof dnsLookup;
}

/** 本机回环：127.0.0.0/8、::1（含 IPv4 映射）与 `localhost`。 */
export function isLoopbackHost(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isLocalHostname(bare)) return true;
  if (isIP(bare) === 4) return bare.startsWith('127.');
  if (isIP(bare) === 6) {
    if (bare === '::1') return true;
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare)?.[1];
    if (mapped !== undefined) return mapped.startsWith('127.');
    const hex = /^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/.exec(bare)?.[1];
    return hex !== undefined && Number.parseInt(hex, 16) >> 8 === 127;
  }
  return false;
}

/** 连接器地址决定 OAuth 请求能去哪（见 `AddressScope`）。 */
export function scopeOf(url: string): AddressScope {
  const { hostname } = new URL(url);
  if (isLoopbackHost(hostname)) return 'loopback';
  return isBlockedAddress(hostname) ? 'private' : 'public';
}

function allowedAddress(address: string, scope: AddressScope): boolean {
  if (!isBlockedAddress(address)) return true;
  if (scope === 'private') return true;
  return scope === 'loopback' && isLoopbackHost(address);
}

/** 这个地址能不能作为授权服务器的端点：https，或连接器在本机时的本机 http；不带用户名口令；主机不在拦截范围。 */
export function checkEndpoint(raw: string, scope: AddressScope): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OAuthHttpError('insecure_endpoint', `Not a valid URL: ${raw}`);
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '')
    throw new OAuthHttpError(
      'insecure_endpoint',
      `${url.origin} carries credentials or a fragment`,
    );
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback && scope === 'loopback'))
    throw new OAuthHttpError('insecure_endpoint', `${url.origin} is not https`);
  if (isLocalHostname(url.hostname) ? scope !== 'loopback' : !allowedAddress(url.hostname, scope))
    throw new OAuthHttpError('insecure_endpoint', `${url.hostname} is a local or private address`);
  return url;
}

function guardedLookup(resolve: typeof dnsLookup, scope: AddressScope): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
      if (error) {
        callback(error, '', 4);
        return;
      }
      if (
        addresses.length === 0 ||
        addresses.some((entry) => !allowedAddress(entry.address, scope))
      ) {
        callback(
          new OAuthHttpError(
            'insecure_endpoint',
            `${hostname} resolves to a local or private address`,
          ) as unknown as NodeJS.ErrnoException,
          '',
          4,
        );
        return;
      }
      if (options.all) {
        (callback as unknown as (error: null, addresses: LookupAddress[]) => void)(null, addresses);
        return;
      }
      const first = addresses[0] as LookupAddress;
      callback(null, first.address, first.family);
    });
  };
}

/** 发一个请求，读完响应体（超过上限抛 `too_large`）。不跟随跳转：3xx 原样返回。 */
export function oauthRequest(raw: string, options: OAuthRequestOptions): Promise<OAuthResponse> {
  const url = options.trusted ? new URL(raw) : checkEndpoint(raw, options.scope);
  const maxBytes = options.maxBytes ?? OAUTH_RESPONSE_MAX_BYTES;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? OAUTH_REQUEST_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  const body = options.body === undefined ? undefined : Buffer.from(options.body, 'utf8');
  return new Promise((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = send(
      url,
      {
        method: options.method ?? (body === undefined ? 'GET' : 'POST'),
        signal,
        lookup: options.trusted
          ? (options.lookup ?? dnsLookup)
          : guardedLookup(options.lookup ?? dnsLookup, options.scope),
        headers: {
          'user-agent': 'Wevir',
          'accept-encoding': 'identity',
          ...options.headers,
          ...(body !== undefined && { 'content-length': String(body.length) }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) {
            response.destroy();
            reject(
              new OAuthHttpError('too_large', `${url.origin} sent more than ${maxBytes} bytes`),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
        response.on('error', (error) => reject(network(error, url)));
      },
    );
    request.on('error', (error) => reject(network(error, url)));
    request.end(body);
  });
}

function network(error: unknown, url: URL): OAuthHttpError {
  if (error instanceof OAuthHttpError) return error;
  const code = (error as NodeJS.ErrnoException).code;
  return new OAuthHttpError(
    'network',
    `${url.origin}: ${code ?? (error instanceof Error ? error.message : String(error))}`,
  );
}

/** 响应体按 JSON 对象读；不是对象时返回 undefined。 */
export function jsonObject(response: OAuthResponse): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(response.body.toString('utf8'));
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
