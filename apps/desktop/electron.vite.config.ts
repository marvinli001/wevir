import { randomBytes } from 'node:crypto';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';
import { defaultClientConditions } from 'vite';
import { developmentCsp } from './src/shared/csp.js';
import { DEV_SERVER_PORT } from './src/shared/renderer-origin.js';

// 工作区包按 exports 的 "@wevir/source" 条件直接用源码打进 main 与 renderer（ADR-0004 补记 1），改了
// client-sdk 等包不用先构建，开发时也能热更新。Host 本身仍是 dist/ 里的 wevir-host 子进程。
const WORKSPACE_PACKAGES = ['@wevir/client-sdk', '@wevir/host', '@wevir/protocol'];

export default defineConfig(({ command }) => {
  // 开发服务器的 CSP nonce：每次启动随机生成，Vite 把它加到引导脚本与注入的 <style> 上（src/shared/csp.ts）。
  const nonce = randomBytes(18).toString('base64');
  return {
    main: {
      resolve: { conditions: ['@wevir/source'] },
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
      resolve: { conditions: ['@wevir/source', ...defaultClientConditions] },
      server: {
        // 渲染进程的 origin 必须在 Host 的 Origin 白名单里（host-api.md §1）：固定主机与端口，不换端口。
        host: 'localhost',
        port: DEV_SERVER_PORT,
        strictPort: true,
        headers: { 'Content-Security-Policy': developmentCsp(nonce) },
      },
      ...(command === 'serve' && { html: { cspNonce: nonce } }),
      plugins: [react(), tailwindcss()],
    },
  };
});
