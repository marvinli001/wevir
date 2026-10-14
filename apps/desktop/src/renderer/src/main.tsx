// 第一个求值：动效库在模块加载时插入的 <style> 要带上 CSP 的 nonce（lib/style-nonce.ts）。
import './lib/style-nonce.js';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { bootstrapWindowChrome } from './layout/window-chrome.js';
import { bootstrapTheme } from './theme/theme.js';
import './index.css';

bootstrapTheme();
bootstrapWindowChrome();

const root = document.getElementById('root');
if (!root) throw new Error('index.html 里缺少 #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
