// “终端”窗格（0.69.0）的纯逻辑：大段输入分成几次发、按位置接上输出（重复的丢掉、缺了一段就重新 attach）、标签名与配色。

import type { Terminal } from '@wevir/protocol';
import { DEFAULT_THEME_TOKENS, TERMINAL_INPUT_MAX_LENGTH } from '@wevir/protocol';

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

export const TERMINAL_ANSI_TOKENS = {
  black: 'terminal-black',
  red: 'terminal-red',
  green: 'terminal-green',
  yellow: 'terminal-yellow',
  blue: 'terminal-blue',
  magenta: 'terminal-magenta',
  cyan: 'terminal-cyan',
  white: 'terminal-white',
  brightBlack: 'terminal-bright-black',
  brightRed: 'terminal-bright-red',
  brightGreen: 'terminal-bright-green',
  brightYellow: 'terminal-bright-yellow',
  brightBlue: 'terminal-bright-blue',
  brightMagenta: 'terminal-bright-magenta',
  brightCyan: 'terminal-bright-cyan',
  brightWhite: 'terminal-bright-white',
} as const;
type AnsiPalette = Pick<TerminalPalette, keyof typeof TERMINAL_ANSI_TOKENS>;

/** 16 色取语义 token；未覆盖时保持各模式原有的 ANSI 色。 */
export function terminalPalette(
  theme: 'light' | 'dark',
  colors: { background: string; foreground: string; selection: string },
  ansi: Partial<AnsiPalette> = {},
): TerminalPalette {
  return {
    background: colors.background,
    foreground: colors.foreground,
    cursor: colors.foreground,
    cursorAccent: colors.background,
    selectionBackground: colors.selection,
    ...(Object.fromEntries(
      Object.entries(TERMINAL_ANSI_TOKENS).map(([name, token]) => [
        name,
        ansi[name as keyof AnsiPalette] || DEFAULT_THEME_TOKENS[theme][`--${token}`],
      ]),
    ) as AnsiPalette),
  };
}
