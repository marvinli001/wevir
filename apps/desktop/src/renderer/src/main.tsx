// 第一个求值：动效库在模块加载时插入的 <style> 要带上 CSP 的 nonce（lib/style-nonce.ts）。
import './lib/style-nonce.js';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { initI18n } from './i18n/index.js';
import { bootstrapWindowChrome } from './layout/window-chrome.js';
import { bootstrapTheme } from './theme/theme.js';
import './index.css';

bootstrapTheme();
bootstrapWindowChrome();

const root = document.getElementById('root');
if (!root) throw new Error('index.html 里缺少 #root');
// 界面语言的目录在第一次渲染之前加载好，t() 始终是同步的。
void initI18n().then(() =>
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  ),
);
