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
