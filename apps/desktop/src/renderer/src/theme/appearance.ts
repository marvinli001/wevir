import { IS_MAC } from '@/lib/shortcuts';
import { createPersistedStore } from '@/lib/store';
import { platformApi } from '@/platform/platform';
import type { WindowAppearanceInput } from '../../../shared/desktop-api.js';
import { APPEARANCE_STORAGE_KEY } from '../../../shared/theme.js';
import {
  type Appearance,
  appearanceVariables,
  DEFAULT_APPEARANCE,
  DEFAULT_COLORS,
  parseAppearance,
} from './appearance-model';
import { resolvedTheme, subscribeTheme } from './theme';

/** 设置 → 外观的个性化（appearance-model.ts），只存在本机。 */
export const appearanceStore = createPersistedStore<Appearance>(
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  parseAppearance,
);

export function useAppearance(): Appearance {
  return appearanceStore.use();
}

export function updateAppearance(patch: Partial<Appearance>): void {
  appearanceStore.set((current) => ({ ...current, ...patch }));
}

/** 半透明侧栏只有 macOS 有（窗口的 vibrancy）。 */
export const TRANSLUCENT_SIDEBAR_SUPPORTED = IS_MAC;

let applied = new Set<string>();
let sentToWindow: string | undefined;

function apply(): void {
  const appearance = appearanceStore.get();
  const root = document.documentElement;
  const vars = appearanceVariables(appearance, resolvedTheme());
  for (const name of applied) {
    if (!(name in vars)) root.style.removeProperty(name);
  }
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  applied = new Set(Object.keys(vars));

  const translucentSidebar = TRANSLUCENT_SIDEBAR_SUPPORTED && appearance.translucentSidebar;
  root.toggleAttribute('data-translucent-sidebar', translucentSidebar);
  // 窗口的底色与材质交给主进程，它也记下来，下次启动时窗口一出现就是这个底色（main/window-appearance.ts）。
  const windowAppearance: WindowAppearanceInput = {
    background: {
      light: appearance.light.background ?? DEFAULT_COLORS.light.background,
      dark: appearance.dark.background ?? DEFAULT_COLORS.dark.background,
    },
    translucentSidebar,
  };
  const key = JSON.stringify(windowAppearance);
  if (key !== sentToWindow) {
    sentToWindow = key;
    // 只影响窗口底下的底色与材质，失败时页面照常（CSS 里半透明的侧栏下面没有材质也只是浅一点）。
    platformApi()
      ?.setWindowAppearance(windowAppearance)
      .catch(() => undefined);
  }
}

/** 启动时调用一次（在 bootstrapTheme 之后）：盖上外观的变量，之后跟着外观与主题的变化重算。 */
export function bootstrapAppearance(): void {
  apply();
  appearanceStore.subscribe(apply);
  subscribeTheme(apply);
}
