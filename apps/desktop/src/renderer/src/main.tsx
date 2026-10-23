// 第一个求值：动效库在模块加载时插入的 <style> 要带上 CSP 的 nonce（lib/style-nonce.ts）。
import './lib/style-nonce.js';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { APP_MENU_LABEL_KEYS, type AppMenuLabels } from '../../shared/desktop-api.js';
import { App } from './App.js';
import { bootstrapRenderer } from './bootstrap.js';
import { t } from './i18n/index.js';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('index.html 里缺少 #root');
void bootstrapRenderer().then(() => {
  // 菜单栏 / 通知区域图标的菜单按界面语言（main/tray.ts）。
  window.wevir
    ?.setTrayLabels({ open: t('tray.open'), quit: t('tray.quit') })
    .catch(() => undefined);
  // macOS 应用菜单同样按界面语言（main/app-menu.ts）。
  window.wevir
    ?.setAppMenuLabels(
      Object.fromEntries(
        APP_MENU_LABEL_KEYS.map((key) => [key, t(`appMenu.${key}`)]),
      ) as AppMenuLabels,
    )
    .catch(() => undefined);
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
