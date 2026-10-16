// 文件预览的流式地址（0.32.0，file-urls.ts）：对着真实的 HTTP 服务与目录。

import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { byteRange, FILE_URL_TTL_MS, FileUrls, isServablePath } from './file-urls.js';
import { useTempDir } from './test-utils.js';

const tempDir = useTempDir();
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
});

async function serve(now: () => number = Date.now) {
  const urls = new FileUrls({ now });
  const server = createServer((req, res) => {
    if (!urls.handle(req, res)) {
      res.writeHead(426);
      res.end();
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  urls.setPort(port);
  return { urls, port };
}

function workspace(): { dir: string; outside: string } {
  const base = realpathSync(tempDir());
  const dir = join(base, 'ws');
  const outside = join(base, 'outside');
  mkdirSync(join(dir, 'site', 'img'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(dir, 'site', 'index.html'), '<img src="img/a.png">');
  writeFileSync(join(dir, 'site', 'img', 'a.png'), 'png-bytes');
  writeFileSync(join(dir, 'clip.mp4'), '0123456789');
  writeFileSync(join(dir, 'notes.txt'), 'text');
  writeFileSync(join(dir, '.env'), 'SECRET=1');
  mkdirSync(join(dir, '.hidden'));
  writeFileSync(join(dir, '.hidden', 'b.png'), 'hidden');
  writeFileSync(join(outside, 'x.png'), 'outside');
  symlinkSync(join(outside, 'x.png'), join(dir, 'link.png'));
  return { dir, outside };
}

interface Got {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function get(
  url: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<Got> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { method: options.method ?? 'GET', headers: options.headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('FileUrls', () => {
  it('发地址；同一目录给同一个令牌，相对引用读得到网页会用的文件', async () => {
    const { dir } = workspace();
    const { urls, port } = await serve();
    const page = urls.issue(dir, 'site/index.html');
    expect(page.url).toMatch(
      new RegExp(`^http://127\\.0\\.0\\.1:${port}/files/[\\w-]+/site/index\\.html$`),
    );
    const html = await get(page.url);
    expect(html.status).toBe(200);
    // 开头插了点链接的脚本（html-preview.ts），原文照旧。
    expect(html.body).toMatch(
      /^<!doctype html><head><script>\(function\(\)\{.*ui\/open-link.*<\/script><\/head><img src="img\/a\.png">$/,
    );
    expect(html.headers['content-length']).toBe(String(Buffer.byteLength(html.body)));
    expect(html.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(html.headers['content-security-policy']).toContain('sandbox allow-scripts');
    expect(html.headers['content-security-policy']).toContain("connect-src 'none'");
    expect(html.headers['x-content-type-options']).toBe('nosniff');
    // 页面里的相对引用：同一个令牌。
    const image = await get(new URL('img/a.png', page.url).href);
    expect(image).toMatchObject({ status: 200, body: 'png-bytes' });
    expect(image.headers['content-type']).toBe('image/png');
    expect(urls.issue(dir, 'clip.mp4').url.split('/')[4]).toBe(page.url.split('/')[4]);
    // HEAD 只回头。
    expect(await get(page.url, { method: 'HEAD' })).toMatchObject({ status: 200, body: '' });
  });

  it('不给隐藏文件、目录外、不能预览的类型与上一级', async () => {
    const { dir } = workspace();
    const { urls } = await serve();
    const base = urls.issue(dir, 'clip.mp4').url;
    for (const path of ['.env', '.hidden/b.png', 'link.png', 'notes.txt', '../outside/x.png']) {
      expect((await get(new URL(path, base).href)).status, path).toBe(404);
    }
    // 编码过的 ..：解码后不是安全的路径。
    expect((await get(base.replace('clip.mp4', '%2E%2E%2Foutside%2Fx.png'))).status).toBe(404);
    expect((await get(base.replace(/files\/[^/]+/, 'files/not-a-token'))).status).toBe(404);
  });

  it('Range：单段 206，越界 416，带 If-Range 回整个文件', async () => {
    const { dir } = workspace();
    const { urls } = await serve();
    const { url } = urls.issue(dir, 'clip.mp4');
    const part = await get(url, { headers: { Range: 'bytes=2-5' } });
    expect(part).toMatchObject({ status: 206, body: '2345' });
    expect(part.headers['content-range']).toBe('bytes 2-5/10');
    expect(part.headers['accept-ranges']).toBe('bytes');
    expect(part.headers['content-type']).toBe('video/mp4');
    expect(await get(url, { headers: { Range: 'bytes=-3' } })).toMatchObject({
      status: 206,
      body: '789',
    });
    const bad = await get(url, { headers: { Range: 'bytes=20-' } });
    expect(bad.status).toBe(416);
    expect(bad.headers['content-range']).toBe('bytes */10');
    expect(await get(url, { headers: { Range: 'bytes=0-1', 'If-Range': '"x"' } })).toMatchObject({
      status: 200,
      body: '0123456789',
    });
  });

  it('Host 头不是本机的回 403，不是 GET / HEAD 的回 405，令牌过期回 404', async () => {
    const { dir } = workspace();
    let now = 1_000_000;
    const { urls } = await serve(() => now);
    const { url, expiresAt } = urls.issue(dir, 'clip.mp4');
    expect(expiresAt).toBe(1_000_000 + FILE_URL_TTL_MS);
    expect((await get(url, { headers: { Host: 'evil.example:80' } })).status).toBe(403);
    expect((await get(url, { method: 'POST' })).status).toBe(405);
    // 过了一半：换新令牌，旧的仍能用到过期。
    now += FILE_URL_TTL_MS / 2 + 1;
    const renewed = urls.issue(dir, 'clip.mp4').url;
    expect(renewed).not.toBe(url);
    expect((await get(url)).status).toBe(200);
    now += FILE_URL_TTL_MS;
    expect((await get(url)).status).toBe(404);
  });

  it('不是 /files/ 的请求交回调用方', async () => {
    const { port } = await serve();
    expect((await get(`http://127.0.0.1:${port}/mcp`)).status).toBe(426);
  });
});

describe('isServablePath / byteRange', () => {
  it('路径规则', () => {
    expect(isServablePath('a/b/report.pdf')).toBe(true);
    expect(isServablePath('book.xlsx')).toBe(true);
    expect(isServablePath('a.ts')).toBe(false);
    expect(isServablePath('a/.git/x.png')).toBe(false);
    expect(isServablePath('a//b.png')).toBe(false);
    expect(isServablePath('a\\b.png')).toBe(false);
  });

  it('字节范围（T3 的 assetByteRange）', () => {
    expect(byteRange('bytes=0-', 10)).toEqual({ start: 0, end: 9 });
    expect(byteRange('bytes=5-100', 10)).toEqual({ start: 5, end: 9 });
    expect(byteRange('bytes=-20', 10)).toEqual({ start: 0, end: 9 });
    expect(byteRange('bytes=10-', 10)).toBe('unsatisfiable');
    expect(byteRange('bytes=0-0', 0)).toBe('unsatisfiable');
    expect(byteRange('bytes=5-2', 10)).toBeUndefined();
    expect(byteRange('bytes=0-1,3-4', 10)).toBeUndefined();
  });
});
