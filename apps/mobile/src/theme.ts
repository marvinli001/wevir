// 手机端的颜色与尺寸：取桌面“静器”的语义变量（design/desktop-tokens.md §2–§3，apps/desktop 的 tokens.css），浅色与深色同一组名字。
// 静器没有彩色强调色：主按钮与选中是墨色，彩色只表示状态。

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
  background: '#fcfbfa',
  card: '#ffffff',
  muted: '#f2f1ee',
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
  background: '#101114',
  card: '#17181c',
  muted: '#1d1e23',
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

export const RADIUS = { card: 12, control: 8 } as const;

export const TEXT = { body: 15, small: 13, caption: 12, title: 17 } as const;

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? DARK : LIGHT;
}
