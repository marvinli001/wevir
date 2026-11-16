import { compositeThemeColor } from '@wevir/protocol';
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
import { customThemeStore, recoverCustomTheme } from './custom-theme';
import { resolvedTheme, subscribeTheme } from './theme';
import { applyThemeCss } from './theme-css';

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

/** 系统能给窗口加材质时才有半透明窗口（macOS；Windows 11 22H2 起）。 */
export function translucentWindowSupported(): boolean {
  return platformApi()?.getWindowChrome().material ?? false;
}

let applied = new Set<string>();
let sentToWindow: string | undefined;
let windowBackdrop = false;
const listeners = new Set<() => void>();
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/** 颜色变量已写入 DOM 后通知（终端等需要读取计算后颜色的组件）。 */
export function subscribeAppearance(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 背景层只在实际挂载期间接管材质，不写设备偏好。 */
export function setThemeBackdropPresentation(
  window: boolean,
  glass: boolean,
  reduced = false,
): void {
  windowBackdrop = window;
  document.documentElement.toggleAttribute('data-theme-window-backdrop', window);
  document.documentElement.toggleAttribute('data-theme-glass', glass);
  document.documentElement.toggleAttribute('data-theme-backdrop-reduced', reduced);
  applySafely();
}

function apply(): void {
  const appearance = appearanceStore.get();
  const root = document.documentElement;
  const theme = customThemeStore.get().theme;
  const backdrop = theme?.backdrop;
  const backdropImage = backdrop?.kind === 'image' ? theme?.assets.file : undefined;
  const vars = {
    ...appearanceVariables(appearance, resolvedTheme()),
    ...theme?.variables[resolvedTheme()],
    ...(backdrop && {
      '--theme-backdrop-opacity': String(backdrop.opacity ?? 1),
      '--theme-backdrop-blur': `${backdrop.blur ?? 0}px`,
      '--theme-backdrop-scrim': String(backdrop.scrim ?? 0),
    }),
    ...(backdropImage && { '--theme-backdrop-image': `url(${JSON.stringify(backdropImage)})` }),
  };
  for (const name of applied) {
    if (!(name in vars)) root.style.removeProperty(name);
  }
  for (const [name, value] of Object.entries(vars)) {
    applied.add(name);
    root.style.setProperty(name, value);
  }
  applied = new Set(Object.keys(vars));
  applyThemeCss(theme?.css, reducedMotion.matches);

  const translucentWindow =
    !windowBackdrop && translucentWindowSupported() && appearance.translucentWindow;
  root.toggleAttribute('data-translucent-window', translucentWindow);
  // 窗口的底色与材质交给主进程，它也记下来，下次启动时窗口一出现就是这个底色（main/window-appearance.ts）。
  const windowAppearance: WindowAppearanceInput = {
    background: {
      light: compositeThemeColor(
        theme?.variables.light['--background'] ??
          appearance.light.background ??
          DEFAULT_COLORS.light.background,
        appearance.light.background ?? DEFAULT_COLORS.light.background,
      ),
      dark: compositeThemeColor(
        theme?.variables.dark['--background'] ??
          appearance.dark.background ??
          DEFAULT_COLORS.dark.background,
        appearance.dark.background ?? DEFAULT_COLORS.dark.background,
      ),
    },
    translucentWindow,
  };
  const key = JSON.stringify(windowAppearance);
  if (key !== sentToWindow) {
    sentToWindow = key;
    // 只影响窗口底下的底色与材质，失败时页面照常（CSS 里半透明的壳下面没有材质也只是浅一点）。
    platformApi()
      ?.setWindowAppearance(windowAppearance)
      .catch(() => undefined);
  }
  for (const listener of listeners) listener();
}

function applySafely(): void {
  try {
    apply();
  } catch (reason) {
    if (!customThemeStore.get().theme) throw reason;
    recoverCustomTheme(reason);
  }
}

/** 启动时调用一次（在 bootstrapTheme 之后）：盖上外观的变量，之后跟着外观与主题的变化重算。 */
export function bootstrapAppearance(): void {
  applySafely();
  appearanceStore.subscribe(applySafely);
  subscribeTheme(applySafely);
  reducedMotion.addEventListener('change', applySafely);
}
