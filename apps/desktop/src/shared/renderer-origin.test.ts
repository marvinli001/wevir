import { DESKTOP_RENDERER_ORIGINS } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { CSP_NONCE_PLACEHOLDER, developmentCsp, productionCsp } from './csp.js';
import {
  APP_ENTRY_URL,
  APP_ORIGIN,
  DEV_SERVER_ORIGIN,
  DEV_SERVER_PORT,
  rendererOriginOf,
} from './renderer-origin.js';

describe('渲染进程的 origin', () => {
  it('与 Host 的 Origin 白名单一致（host-api.md §1）', () => {
    expect([APP_ORIGIN, DEV_SERVER_ORIGIN]).toEqual(DESKTOP_RENDERER_ORIGINS);
  });

  it('rendererOriginOf：自定义协议按 <协议>//<主机> 算，http 用 URL 的 origin', () => {
    expect(new URL(APP_ENTRY_URL).origin).toBe('null');
    expect(rendererOriginOf(APP_ENTRY_URL)).toBe(APP_ORIGIN);
    expect(rendererOriginOf('wevir://other/index.html')).toBe('wevir://other');
    expect(rendererOriginOf(`http://localhost:${DEV_SERVER_PORT}/src/main.tsx`)).toBe(
      DEV_SERVER_ORIGIN,
    );
    expect(rendererOriginOf('file:///tmp/index.html')).toBeUndefined();
    expect(rendererOriginOf('not a url')).toBeUndefined();
  });

  it('开发 CSP：脚本与样式只靠 nonce 放行，不用 unsafe-inline；放行 HMR 与 Host', () => {
    const csp = developmentCsp('abc');
    expect(csp).toContain("script-src 'self' 'nonce-abc' 'wasm-unsafe-eval';");
    expect(csp).toContain("worker-src 'self';");
    expect(csp).toContain("style-src 'self' 'nonce-abc';");
    expect(csp).toContain(
      `connect-src 'self' ws://localhost:${DEV_SERVER_PORT} ws://127.0.0.1:* http://127.0.0.1:*;`,
    );
    // 只为 Shiki 的 WebAssembly 放开 'wasm-unsafe-eval'（0.20.0），不放开 JS 的 eval 与内联。
    expect(csp.replace("'wasm-unsafe-eval'", '')).not.toContain('unsafe');
  });

  it('生产 CSP：样式 nonce 只进 style-src，脚本只有 self 与 WebAssembly；不用 unsafe-inline，worker 只放行 self、不放开 blob', () => {
    const csp = productionCsp('abc');
    expect(csp).toContain("style-src 'self' 'nonce-abc';");
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval';");
    expect(csp).toContain("worker-src 'self';");
    expect(csp).toContain("default-src 'none';");
    expect(csp.replace("'wasm-unsafe-eval'", '')).not.toMatch(/unsafe|blob:|child-src/);
    expect(productionCsp()).toContain("style-src 'self';");
    // 占位符原样写进 index.html 的 nonce 属性，主进程整串替换：必须是合法的 nonce 字符、不会与页面里别的文字相撞。
    expect(CSP_NONCE_PLACEHOLDER).toMatch(/^[A-Z_]{8,}$/);
  });
});
