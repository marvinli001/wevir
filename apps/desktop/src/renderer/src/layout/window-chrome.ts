import { platformApi } from '@/platform/platform';
import type { WindowChrome } from '../../../shared/desktop-api.js';

/**
 * macOS 隐藏了系统标题栏，红绿灯浮在页面左上角（主进程 createWindow）。它们在的时候给 <html> 加
 * data-traffic-lights，index.css 据此设 --traffic-lights-inset，左上角的顶栏用它让出位置；进出全屏时跟着
 * 主进程的推送更新。在首帧前调用，避免顶栏先贴边再挪开。
 */
export function bootstrapWindowChrome(): void {
  const apply = ({ trafficLights }: WindowChrome) =>
    document.documentElement.toggleAttribute('data-traffic-lights', trafficLights);
  apply(platformApi().getWindowChrome());
  platformApi().onWindowChrome(apply);
}
