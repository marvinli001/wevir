import type { DesktopApi } from '../../shared/desktop-api.js';

declare global {
  interface ImportMetaEnv {
    /** 构建时设为 1：正式构建也带上动效样张 #/dev/fx（routes/router.tsx）。 */
    readonly VITE_WEVIR_FX_GALLERY?: string;
  }

  interface Window {
    /** preload 经 contextBridge 暴露的接口（src/preload/index.ts）。 */
    readonly wevir: DesktopApi;
  }
}
