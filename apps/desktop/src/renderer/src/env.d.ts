import type { DesktopApi } from '../../shared/desktop-api.js';

declare global {
  interface ImportMetaEnv {
    /** 构建时设为 1：正式构建也带上动效样张 #/dev/fx（routes/router.tsx）。 */
    readonly VITE_WEVIR_FX_GALLERY?: string;
    /** 开发时设了它（1、stale 或 fail）：插件市场用 plugins/market/dev-fixture.ts 的假索引，不连 Host（只在 `pnpm dev` 下生效）。 */
    readonly VITE_WEVIR_FAKE_MARKET?: string;
  }

  interface Window {
    /** preload 经 contextBridge 暴露的接口（src/preload/index.ts）。 */
    readonly wevir: DesktopApi;
  }
}
