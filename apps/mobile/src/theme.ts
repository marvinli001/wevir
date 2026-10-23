// 手机端的颜色与尺寸：取桌面“静器”的语义变量（design/desktop-tokens.md §2–§3，apps/desktop 的 tokens.css），浅色与深色同一组名字。
// 静器没有彩色强调色：主按钮与选中是墨色，彩色只表示状态。页面底色比桌面深一档，让白色分组卡片浮出来；形状照 iOS 26：
// 胶囊按钮、大圆角分组、同心圆角。

import { useColorScheme } from 'react-native';

export interface Theme {
  dark: boolean;
  background: string;
  card: string;
  muted: string;
  border: string;
  borderStrong: string;
  foreground: string;
  softForeground: string;
  mutedForeground: string;
  primary: string;
  primaryForeground: string;
  running: string;
  warning: string;
  success: string;
  destructive: string;
}

export const LIGHT: Theme = {
  dark: false,
  background: '#f7f6f3',
  card: '#ffffff',
  muted: '#efeee9',
  border: '#e6e4e0',
  borderStrong: '#d3d1cc',
  foreground: '#1a1a17',
  softForeground: '#45433d',
  mutedForeground: '#67635a',
  primary: '#1a1a17',
  primaryForeground: '#fcfbfa',
  running: '#2f5f8a',
  warning: '#94570a',
  success: '#2f6b42',
  destructive: '#a23b30',
};

export const DARK: Theme = {
  dark: true,
  background: '#0c0d10',
  card: '#17181c',
  muted: '#212227',
  border: '#26282d',
  borderStrong: '#36383e',
  foreground: '#eeede8',
  softForeground: '#c4c3bd',
  mutedForeground: '#9d9e9b',
  primary: '#eeede8',
  primaryForeground: '#101114',
  running: '#8db4dc',
  warning: '#e3a857',
  success: '#86c597',
  destructive: '#ee8f84',
};

/** 分组卡片 24、行内图标块 10、输入框 14、胶囊按钮取高度的一半。 */
export const RADIUS = { card: 24, tile: 10, control: 14, capsule: 999 } as const;

export const TEXT = { largeTitle: 34, title: 17, body: 16, small: 14, caption: 12 } as const;

/** 页面左右留白与分组之间的间距。 */
export const SPACE = { page: 16, section: 28 } as const;

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? DARK : LIGHT;
}
