// 非 Electron 外壳的入口（浏览器客户端 wevir-web 从这里构建）：界面的根组件、渲染前的准备，以及外壳要接上的两处——外壳的实现
// （platform/platform.ts：接口、能力位、界面里的位置）与 Host 连接（`HostConnectionSource`）。先 `installPlatform`，再
// `bootstrapRenderer`，然后渲染 `<App />`。
//
// 动效库在模块加载时插入的 <style> 要带 CSP 的 nonce：外壳的页面有 <meta property="csp-nonce"> 时，style-nonce 要最先求值。样式
// 由外壳自己引入 index.css（Tailwind 要按外壳的目录登记 @source）。
import './lib/style-nonce.js';

export type {
  DesktopApi as PlatformApi,
  DesktopNotification,
  HostProcessStatus,
} from '../../shared/desktop-api.js';
export { App } from './App.js';
export { bootstrapRenderer } from './bootstrap.js';
export { BrandMark } from './components/brand-mark.js';
export { StatusDot, type StatusTone } from './components/status-dot.js';
export { Button } from './components/ui/button.js';
export { describeError } from './host/error-text.js';
export { useHostConnection } from './host/host-connection.js';
export { currentLocale } from './i18n/index.js';
export type { Locale } from './i18n/locales.js';
export {
  DESKTOP_CAPABILITIES,
  type HostConnectionSource,
  type HostConnectionTarget,
  installPlatform,
  type Platform,
  type PlatformCapabilities,
  type PlatformSlots,
  unsupportedPlatformApi,
} from './platform/platform.js';
