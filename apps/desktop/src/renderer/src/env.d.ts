import type { DesktopApi } from '../../shared/desktop-api.js';

declare global {
  interface Window {
    /** preload 经 contextBridge 暴露的接口（src/preload/index.ts）。 */
    readonly wevir: DesktopApi;
  }
}
