// “终端”窗格（0.69.0）的纯逻辑：大段输入分成几次发、按位置接上输出（重复的丢掉、缺了一段就重新 attach）、标签名与配色。

import type { Terminal } from '@wevir/protocol';
import { TERMINAL_INPUT_MAX_LENGTH } from '@wevir/protocol';

/** 把输入切成每段不超过 `max` 个码元，不切在代理对中间（粘贴大段文字时）。 */
export function chunkInput(data: string, max = TERMINAL_INPUT_MAX_LENGTH): string[] {
  if (data.length <= max) return data === '' ? [] : [data];
  const chunks: string[] = [];
  let at = 0;
  while (at < data.length) {
    let end = Math.min(data.length, at + max);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    chunks.push(data.slice(at, end));
    at = end;
  }
  return chunks;
}

/**
 * 一条 `terminal.output` 对照客户端读到的位置 `next`：整段已经有了（`skip`），接着写其中新的部分（`write`），或者中间缺了一段
 * （`gap`，要带上 `next` 重新 attach）。
 */
export function placeOutput(
  next: number,
  output: { offset: number; data: string },
): { kind: 'skip' } | { kind: 'gap' } | { kind: 'write'; data: string; next: number } {
  const end = output.offset + output.data.length;
  if (end <= next) return { kind: 'skip' };
  if (output.offset > next) return { kind: 'gap' };
  return { kind: 'write', data: output.data.slice(next - output.offset), next: end };
}

/** 标签名：程序设的标题，没有时是 shell 的名字。 */
export function terminalLabel(terminal: Pick<Terminal, 'title' | 'shell'>): string {
  if (terminal.title.trim() !== '') return terminal.title.trim();
  const name = terminal.shell.split(/[\\/]/).at(-1) ?? terminal.shell;
  return name.replace(/\.exe$/i, '');
}

/**
 * 结束的对象：POSIX 上是整个终端会话（shell 是会话首进程），Windows 上是进程树。按 Host 那边 shell 的路径判断（Host 不一定在本机）。
 */
export function endTarget(shell: string): 'session' | 'tree' {
  return /\\|\.exe$/i.test(shell) ? 'tree' : 'session';
}

export interface TerminalPalette {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

/** 16 色：浅色主题上黄、白要压暗才看得清；底色与前景取界面的颜色。 */
export function terminalPalette(
  theme: 'light' | 'dark',
  colors: { background: string; foreground: string; selection: string },
): TerminalPalette {
  const base = {
    background: colors.background,
    foreground: colors.foreground,
    cursor: colors.foreground,
    cursorAccent: colors.background,
    selectionBackground: colors.selection,
  };
  return theme === 'light'
    ? {
        ...base,
        black: '#1a1a17',
        red: '#c4372d',
        green: '#2f7d32',
        yellow: '#8a6a00',
        blue: '#2b5fb8',
        magenta: '#9b3aa6',
        cyan: '#1f7a86',
        white: '#6b6a64',
        brightBlack: '#57564f',
        brightRed: '#d9473c',
        brightGreen: '#3a9440',
        brightYellow: '#a07c00',
        brightBlue: '#3a6fd0',
        brightMagenta: '#b04abb',
        brightCyan: '#2a8f9c',
        brightWhite: '#3d3c37',
      }
    : {
        ...base,
        black: '#1e1f24',
        red: '#f2675d',
        green: '#7ccf7f',
        yellow: '#e6c45c',
        blue: '#6fa3f2',
        magenta: '#d68ae0',
        cyan: '#63c7d1',
        white: '#d4d3ce',
        brightBlack: '#6e6f76',
        brightRed: '#ff8a80',
        brightGreen: '#9be39d',
        brightYellow: '#f5d77e',
        brightBlue: '#94bcff',
        brightMagenta: '#e8a8f0',
        brightCyan: '#8fdde5',
        brightWhite: '#f4f3ee',
      };
}
