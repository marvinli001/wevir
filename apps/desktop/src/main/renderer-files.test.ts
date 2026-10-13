import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { productionCsp } from '../shared/csp.js';
import { serveRendererFile } from './renderer-files.js';

let root: string;
let outside: string;
beforeEach(() => {
  outside = mkdtempSync(join(tmpdir(), 'wevir-renderer-'));
  root = join(outside, 'renderer');
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'index.html'), '<!doctype html>');
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
    expect(page.headers.get('content-security-policy')).toBe(productionCsp());
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await page.text()).toBe('<!doctype html>');
    expect((await get('wevir://app/')).status).toBe(200);
    const script = await get('wevir://app/assets/app.js');
    expect(script.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    const head = await get('wevir://app/assets/app.js', 'HEAD');
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
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
  it('生产：没有内联脚本与样式，只连 127.0.0.1 上的 Host', () => {
    const csp = productionCsp();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self';");
    expect(csp).toContain("style-src 'self';");
    expect(csp).toContain('connect-src ws://127.0.0.1:*;');
    expect(csp).not.toContain('unsafe');
  });
});
