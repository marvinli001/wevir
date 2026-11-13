import { IS_MAC } from '@/lib/shortcuts';
import { platformApi } from '@/platform/platform';
import type { WindowChrome } from '../../../shared/desktop-api.js';

/**
 * macOS 与 Windows 隐藏了系统标题栏（主进程 createWindow）：macOS 的红绿灯浮在页面左上角，Windows 的最小化、最大化与
 * 关闭按钮浮在右上角。它们在的时候给 <html> 加 data-traffic-lights / data-caption-buttons，index.css 据此设
 * --traffic-lights-inset 与 --caption-buttons-inset，顶栏用它们让出位置；进出全屏时跟着主进程的推送更新。在首帧前
 * 调用，避免顶栏先贴边再挪开。<html data-platform> 也在这里设。
 */
export function bootstrapWindowChrome(): void {
  // 平台：index.css 只在 Windows、Linux 上改原生滚动条（macOS 用系统的浮动滚动条）。
  document.documentElement.dataset.platform = IS_MAC ? 'mac' : 'other';
  const apply = ({ trafficLights, captionButtons }: WindowChrome) => {
    document.documentElement.toggleAttribute('data-traffic-lights', trafficLights);
    document.documentElement.toggleAttribute('data-caption-buttons', captionButtons);
  };
  apply(platformApi().getWindowChrome());
  platformApi().onWindowChrome(apply);
}
