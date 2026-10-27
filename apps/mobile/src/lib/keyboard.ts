import { Dimensions, type KeyboardEvent } from 'react-native';

/**
 * 键盘挡住屏幕底部的高度。Android 的 `endCoordinates.height` 不含键盘下面的导航栏，
 * 全面屏（edge-to-edge）下页面铺到屏幕最底，按它让开会差一条导航栏；用键盘顶边到屏幕底的距离。
 */
export function keyboardOverlap(e: KeyboardEvent): number {
  return Math.max(0, Dimensions.get('screen').height - e.endCoordinates.screenY);
}
