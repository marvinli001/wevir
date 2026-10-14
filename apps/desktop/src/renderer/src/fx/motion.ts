// 动效封装共用的两件事（U3）：主题只取 Wevir 自己的设置（theme/theme.ts，可以和系统不同），所有库都显式传 theme，
// 不用库的 'auto'（它们读系统或祖先的 data-theme，时机各不相同）；减弱动效跟着系统的 prefers-reduced-motion，库自己
// 不处理的（border-beam 的 line、metal-fx 的光环、img-fx）由封装停下。

import { useSyncExternalStore } from 'react';
import { useTheme } from '@/theme/theme';
import type { ResolvedTheme } from '../../../shared/theme.js';

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

function subscribeReduced(listener: () => void): () => void {
  const query = window.matchMedia(REDUCED_QUERY);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}

/** 系统开了“减弱动态效果”。 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduced, () => window.matchMedia(REDUCED_QUERY).matches);
}

/** 传给动效库的主题：Wevir 当前生效的浅色 / 深色。 */
export function useFxTheme(): ResolvedTheme {
  return useTheme().resolved;
}
