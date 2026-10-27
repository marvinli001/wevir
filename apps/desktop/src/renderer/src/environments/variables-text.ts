// 环境变量的文本（0.130.0）：对话框里按 .env 的写法一行一个。Host 只回打码后的值，所以编辑框里显示的是 `名字=打码值`；保存时
// 值还等于原来打码值的那行只回名字，Host 沿用存着的值（`environment.update` 的 `variables`）。

import type { EnvironmentVariable, EnvironmentVariableInput } from '@wevir/protocol';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_PREFIX = 'WEVIR_';

export type VariablesParseError =
  | { kind: 'line'; line: number }
  | { kind: 'duplicate'; name: string }
  | { kind: 'reserved'; name: string };

export type VariablesParse =
  | { ok: true; variables: EnvironmentVariableInput[] }
  | { ok: false; error: VariablesParseError };

/** 编辑框的初始文本：`名字=打码值`，一行一个。 */
export function formatVariables(variables: readonly EnvironmentVariable[] | undefined): string {
  return (variables ?? []).map(({ name, preview }) => `${name}=${preview}`).join('\n');
}

/**
 * 解析编辑框：空行与 `#` 开头的行跳过，可带 `export `；值两边成对的单引号或双引号去掉（双引号里认 `\n`、`\"`、`\\`），不带引号的
 * 去掉首尾空白。值等于 `previous` 里同名变量的打码值时只回名字。
 */
export function parseVariables(
  text: string,
  previous: readonly EnvironmentVariable[] | undefined,
): VariablesParse {
  const previews = new Map((previous ?? []).map(({ name, preview }) => [name, preview]));
  const seen = new Set<string>();
  const variables: EnvironmentVariableInput[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const body = line.startsWith('export ') ? line.slice('export '.length).trimStart() : line;
    const equals = body.indexOf('=');
    const name = equals < 0 ? '' : body.slice(0, equals).trim();
    if (!NAME.test(name)) return { ok: false, error: { kind: 'line', line: index + 1 } };
    if (name.toUpperCase().startsWith(RESERVED_PREFIX)) {
      return { ok: false, error: { kind: 'reserved', name } };
    }
    if (seen.has(name)) return { ok: false, error: { kind: 'duplicate', name } };
    seen.add(name);
    const value = unquote(body.slice(equals + 1).trim());
    variables.push(previews.get(name) === value ? { name } : { name, value });
  }
  return { ok: true, variables };
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value
      .slice(1, -1)
      .replace(/\\([n"\\])/g, (_, char: string) => (char === 'n' ? '\n' : char));
  }
  return value;
}
