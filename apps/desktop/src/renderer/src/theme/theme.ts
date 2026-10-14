// SPDX-License-Identifier: MIT
// 移植自 different-ai/openwork apps/app/src/app/theme.ts
// 来源提交 ad22cdc2217370f28f24f0f8758016c2921e3c73
// Copyright (c) 2026-present Different AI, Inc.
// 修改：修掉 OpenWork 候选 #17 的两处问题——首帧前脚本只读旧 key（这里与 public/theme-init.js 共用
// shared/theme.ts 的 THEME_STORAGE_KEY）；暗色同时认 `.dark` 类（这里只写 data-theme，CSS 的暗色变体也只认
// 它，color-scheme 由 tokens.css 按 data-theme 设置，不再写内联样式）。另外：去掉旧 key 的迁移；Electron
// nativeTheme 经 preload 的 setThemeSource 同步；系统主题变化时不再重复同步 nativeTheme（跟随系统时
// themeSource 本来就是 'system'）；加了 useTheme；U1 起启动时去掉首帧前脚本给 <html> 涂的底色。

import { useSyncExternalStore } from 'react';
import {
  isThemeMode,
  type ResolvedTheme,
  THEME_STORAGE_KEY,
  type ThemeMode,
} from '../../../shared/theme.js';

const DARK_QUERY = '(prefers-color-scheme: dark)';
const listeners = new Set<() => void>();
let currentMode: ThemeMode | undefined;
let currentResolved: ResolvedTheme = 'light';
let systemSubscribed = false;

function readStoredMode(): ThemeMode {
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemeMode(stored)) return stored;
  } catch {
    // localStorage 不可用：按跟随系统处理。
  }
  return 'system';
}

function getMode(): ThemeMode {
  currentMode ??= readStoredMode();
  return currentMode;
}

function resolve(mode: ThemeMode): ResolvedTheme {
  if (mode !== 'system') return mode;
  return window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light';
}

function apply(mode: ThemeMode): void {
  currentResolved = resolve(mode);
  document.documentElement.dataset.theme = currentResolved;
  for (const listener of listeners) listener();
}

function syncNativeTheme(mode: ThemeMode): void {
  // 只影响窗口外观（标题栏、原生控件、窗口底色），失败不影响页面主题。
  window.wevir?.setThemeSource(mode).catch(() => undefined);
}

function ensureSystemSubscription(): void {
  if (systemSubscribed) return;
  systemSubscribed = true;
  // nativeTheme.themeSource 不是 'system' 时，prefers-color-scheme 跟着它变；这里只在跟随系统时响应。
  window.matchMedia(DARK_QUERY).addEventListener('change', () => {
    if (getMode() === 'system') apply('system');
  });
}

/**
 * 启动时调用一次：按存储的模式设置 data-theme（首帧前脚本已经设过，这里再确认）并同步 nativeTheme。样式表此时已经
 * 生效，去掉首帧前脚本给 <html> 涂的底色，之后切换主题只看 CSS。
 */
export function bootstrapTheme(): void {
  const mode = getMode();
  document.documentElement.style.removeProperty('background-color');
  apply(mode);
  syncNativeTheme(mode);
  ensureSystemSubscription();
}

export function setThemeMode(mode: ThemeMode): void {
  currentMode = mode;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // 存不下就只对本次运行生效。
  }
  // 先同步 nativeTheme：从固定模式切回跟随系统时，prefers-color-scheme 要等 themeSource 变回 'system'
  // 才反映系统设置，届时 change 事件会再 apply 一次。
  syncNativeTheme(mode);
  apply(mode);
  ensureSystemSubscription();
}

export interface ThemeState {
  mode: ThemeMode;
  resolved: ResolvedTheme;
}

let snapshot: ThemeState = { mode: 'system', resolved: 'light' };

function getSnapshot(): ThemeState {
  const mode = getMode();
  if (snapshot.mode !== mode || snapshot.resolved !== currentResolved) {
    snapshot = { mode, resolved: currentResolved };
  }
  return snapshot;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTheme(): ThemeState {
  return useSyncExternalStore(subscribe, getSnapshot);
}
