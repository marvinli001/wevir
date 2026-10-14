import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { defaultClientConditions, defaultServerConditions } from 'vite';
import { developmentCsp } from './src/shared/csp.js';
import { DEV_SERVER_PORT } from './src/shared/renderer-origin.js';

// 工作区包按 exports 的 "@wevir/source" 条件直接用源码打进 main 与 renderer（ADR-0004 补记 1），改了
// client-sdk 等包不用先构建，开发时也能热更新。Host 本身仍是 dist/ 里的 wevir-host 子进程。
const WORKSPACE_PACKAGES = ['@wevir/client-sdk', '@wevir/host', '@wevir/protocol'];
const RENDERER_SRC = fileURLToPath(new URL('./src/renderer/src', import.meta.url));

export default defineConfig(({ command }) => {
  // 开发服务器的 CSP nonce：每次启动随机生成，Vite 把它加到引导脚本与注入的 <style> 上（src/shared/csp.ts）。
  const nonce = randomBytes(18).toString('base64');
  return {
    main: {
      // 主进程按 SSR 构建：对它生效的是 ssr.resolve.conditions，顶层 resolve.conditions 不起作用（T6.1 在全新
      // 克隆里发现，之前主进程打包的其实是各包的 dist/，client-sdk 没构建过就失败）。
      ssr: { resolve: { conditions: ['@wevir/source', ...defaultServerConditions] } },
      build: { externalizeDeps: { exclude: WORKSPACE_PACKAGES } },
    },
    preload: {
      build: {
        // 沙箱里的 preload 只能 require('electron')：不外置任何依赖，打成单个 CJS 文件（ADR-0004 §3）。
        externalizeDeps: false,
        rollupOptions: { output: { format: 'cjs', inlineDynamicImports: true } },
      },
    },
    renderer: {
      resolve: {
        conditions: ['@wevir/source', ...defaultClientConditions],
        // shadcn 原语按 @/ 引用（components.json 的 aliases），与 src/renderer/tsconfig.json 的 paths 一致。
        alias: { '@': RENDERER_SRC },
      },
      server: {
        // 渲染进程的 origin 必须在 Host 的 Origin 白名单里（host-api.md §1）：固定主机与端口，不换端口。
        host: 'localhost',
        port: DEV_SERVER_PORT,
        strictPort: true,
        headers: { 'Content-Security-Policy': developmentCsp(nonce) },
      },
      ...(command === 'serve' && { html: { cspNonce: nonce } }),
      // 字体总是单独成文件：Vite 默认把小于 4 KiB 的资源内联成 data: URI（标题宋体的子集只有几 KiB），而 CSP 的
      // font-src 只放行 'self'（src/shared/csp.ts）。其他资源仍按默认规则。
      build: { assetsInlineLimit: (file) => (file.endsWith('.woff2') ? false : undefined) },
      plugins: [react(), tailwindcss()],
    },
  };
});
