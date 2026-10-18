import { IS_MAC } from '@/lib/shortcuts';
import { createPersistedStore } from '@/lib/store';
import {
  type Appearance,
  appearanceVariables,
  DEFAULT_APPEARANCE,
  parseAppearance,
} from './appearance-model';
import { resolvedTheme, subscribeTheme } from './theme';

/** 设置 → 外观的个性化（appearance-model.ts），只存在本机。 */
export const appearanceStore = createPersistedStore<Appearance>(
  'wevir.appearance.v1',
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
let translucent: boolean | undefined;

function apply(): void {
  const appearance = appearanceStore.get();
  const root = document.documentElement;
  const vars = appearanceVariables(appearance, resolvedTheme());
  for (const name of applied) {
    if (!(name in vars)) root.style.removeProperty(name);
  }
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  applied = new Set(Object.keys(vars));

  const nextTranslucent = TRANSLUCENT_SIDEBAR_SUPPORTED && appearance.translucentSidebar;
  root.toggleAttribute('data-translucent-sidebar', nextTranslucent);
  if (nextTranslucent !== translucent) {
    translucent = nextTranslucent;
    // 只影响窗口底下的材质，失败时侧栏照常是不透明的（CSS 里半透明的侧栏下面没有材质也只是浅一点）。
    window.wevir?.setTranslucentSidebar(nextTranslucent).catch(() => undefined);
  }
}

/** 启动时调用一次（在 bootstrapTheme 之后）：盖上外观的变量，之后跟着外观与主题的变化重算。 */
export function bootstrapAppearance(): void {
  apply();
  appearanceStore.subscribe(apply);
  subscribeTheme(apply);
}
