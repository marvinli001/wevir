import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CSP_NONCE_PLACEHOLDER, productionCsp } from '../shared/csp.js';
import { serveRendererFile } from './renderer-files.js';

let root: string;
let outside: string;
beforeEach(() => {
  outside = mkdtempSync(join(tmpdir(), 'wevir-renderer-'));
  root = join(outside, 'renderer');
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(
    join(root, 'index.html'),
    `<!doctype html><meta property="csp-nonce" nonce="${CSP_NONCE_PLACEHOLDER}" />`,
  );
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(outside, 'secret.txt'), 'secret');
});
afterEach(() => rmSync(outside, { recursive: true, force: true }));

const get = (url: string, method = 'GET') => serveRendererFile(new Request(url, { method }), root);

describe('serveRendererFile（wevir:// 协议）', () => {
  it('从构建产物目录读文件，带内容类型与生产 CSP', async () => {
    const page = await get('wevir://app/index.html');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await get('wevir://app/')).status).toBe(200);
    const script = await get('wevir://app/assets/app.js');
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(script.headers.get('content-security-policy')).toBe(productionCsp());
    expect(await script.text()).toBe('console.log(1)');
    const head = await get('wevir://app/assets/app.js', 'HEAD');
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('页面每次加载换一个样式 nonce：替换占位符，并写进这次的 CSP', async () => {
    const nonceOf = async (response: Response) => {
      const html = await response.text();
      const nonce = /nonce="([^"]+)"/.exec(html)?.[1];
      expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
      expect(html).not.toContain(CSP_NONCE_PLACEHOLDER);
      expect(response.headers.get('content-security-policy')).toBe(productionCsp(nonce));
      return nonce;
    };
    const first = await nonceOf(await get('wevir://app/index.html'));
    const second = await nonceOf(await get('wevir://app/'));
    expect(first).not.toBe(second);
  });

  it('不出构建产物目录，只认主机 app 与 GET / HEAD', async () => {
    // URL 解析已把 %2e%2e 段归一化掉（落在目录内、不存在）；%2f 解码后才出现的 .. 由路径检查挡住。
    expect((await get('wevir://app/%2e%2e/secret.txt')).status).toBe(404);
    expect((await get('wevir://app/..%2fsecret.txt')).status).toBe(403);
    expect((await get('wevir://app/assets%2f..%2f..%2fsecret.txt')).status).toBe(403);
    expect((await get('wevir://app/%E0%A4%A')).status).toBe(400);
    expect((await get('wevir://other/index.html')).status).toBe(404);
    expect((await get('wevir://app/missing.js')).status).toBe(404);
    expect((await get('wevir://app/assets')).status).toBe(404);
    expect((await get('wevir://app/index.html', 'POST')).status).toBe(405);
  });
});

describe('CSP', () => {
  it('生产：没有内联脚本，样式只放行自己的文件与这次的 nonce，只连 127.0.0.1 上的 Host', () => {
    const csp = productionCsp('abc');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("style-src 'self' 'nonce-abc';");
    expect(csp).toContain('connect-src ws://127.0.0.1:*;');
    expect(csp).not.toContain('unsafe');
    expect(productionCsp()).toContain("style-src 'self';");
  });
});
