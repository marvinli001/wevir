// 电脑操作期间的提示条：屏幕上方居中的一条，鼠标穿过它、不抢焦点、所有桌面与全屏应用上都在。文字由渲染进程按界面语言送来。
// 它属于 Wevir 的进程，所以截屏幕时不在图里；helper 判断“点上最前面的窗口”时按 `windowIds` 跳过它。

import { BrowserWindow, screen } from 'electron';
import type { ComputerOverlay } from './service.js';

const WIDTH = 440;
const HEIGHT = 44;

function page(label: string): string {
  const text = label.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;font:500 13px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;-webkit-user-select:none;cursor:default}
body{display:flex;align-items:center;justify-content:center}
.pill{display:flex;align-items:center;gap:8px;padding:7px 14px;border-radius:999px;color:#fff;background:rgba(28,28,30,.86);box-shadow:0 0 0 1px rgba(255,159,10,.75),0 6px 20px rgba(0,0,0,.25);white-space:nowrap}
.dot{width:8px;height:8px;border-radius:50%;background:#ff9f0a;animation:pulse 1.4s ease-in-out infinite}
kbd{font:inherit;padding:1px 6px;border-radius:5px;background:rgba(255,255,255,.18)}
@keyframes pulse{50%{opacity:.35}}
@media (prefers-reduced-motion:reduce){.dot{animation:none}}
</style></head><body><div class="pill"><span class="dot"></span><span>${text.replace('Esc', '<kbd>Esc</kbd>')}</span></div></body></html>`;
}

export interface OverlayWindow extends ComputerOverlay {
  setLabel(label: string): void;
  dispose(): void;
}

export function createComputerOverlay(initialLabel: string): OverlayWindow {
  let label = initialLabel;
  let window: BrowserWindow | undefined;
  let visible = false;

  const place = (target: BrowserWindow) => {
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    target.setBounds({
      x: Math.round(area.x + (area.width - WIDTH) / 2),
      y: area.y + 8,
      width: WIDTH,
      height: HEIGHT,
    });
  };

  const load = (target: BrowserWindow) =>
    target
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page(label))}`)
      .catch(() => undefined);

  const create = (): BrowserWindow => {
    const created = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        javascript: false,
      },
    });
    created.setIgnoreMouseEvents(true);
    created.setAlwaysOnTop(true, 'screen-saver');
    created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    created.on('closed', () => {
      if (window === created) window = undefined;
    });
    void load(created);
    return created;
  };

  return {
    show() {
      visible = true;
      const target = window ?? create();
      window = target;
      place(target);
      if (target.webContents.isLoading()) {
        target.webContents.once('did-finish-load', () => {
          if (visible && !target.isDestroyed()) target.showInactive();
        });
      } else {
        target.showInactive();
      }
    },
    hide() {
      visible = false;
      if (window !== undefined && !window.isDestroyed()) window.hide();
    },
    windowIds() {
      if (window === undefined || window.isDestroyed()) return [];
      const match = /^window:(\d+):/.exec(window.getMediaSourceId());
      return match ? [Number(match[1])] : [];
    },
    setLabel(next) {
      if (next === label) return;
      label = next;
      if (window !== undefined && !window.isDestroyed()) void load(window);
    },
    dispose() {
      if (window !== undefined && !window.isDestroyed()) window.destroy();
      window = undefined;
    },
  };
}
