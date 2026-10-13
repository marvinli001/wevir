import { DESKTOP_RENDERER_ORIGINS } from '@wevir/protocol';
import { describe, expect, it } from 'vitest';
import { developmentCsp } from './csp.js';
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
    expect(csp).toContain("script-src 'self' 'nonce-abc';");
    expect(csp).toContain("style-src 'self' 'nonce-abc';");
    expect(csp).toContain(`connect-src 'self' ws://localhost:${DEV_SERVER_PORT} ws://127.0.0.1:*;`);
    expect(csp).not.toContain('unsafe');
  });
});
