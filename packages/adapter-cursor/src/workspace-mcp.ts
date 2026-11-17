// SPDX-License-Identifier: MIT
// 移植自 pingdotgg/t3code packages/provider-cursor/src/server/workspaceMcpServers.ts（cursorWorkspaceMcpServers）
// 来源提交 cc973033818e630dec3c5cc14dc924bfbec7277d
// Copyright (c) 2026 T3 Tools Inc.
// 修改：Effect 与 Schema 改写成普通 TS；JSONC 不用 jsonc-parser，自己去掉注释与尾逗号；SDK 1.2.0 的 McpServerConfig 没有
// `startupTimeoutSec`，不带；读不了的 mcp-disabled.json 照样报错，由适配器告警后不带覆盖。
//
// 工作区 mcp.json 里用了编辑器变量的 stdio 服务（`${workspaceFolder}` 等）：Cursor 的 SDK 从设置层读 mcp.json 时把这些变量原样
// 留着，服务起不来。这里读同样两个文件（项目的 `.cursor/mcp.json` 先于用户的 `~/.cursor/mcp.json`），把这类服务展开后随每次
// `send` 交给 SDK：同名时 agent 级的 stdio 配置优先于文件里的那份。用户在 Cursor 里关掉的（`mcp-disabled.json`）不带。

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import type { McpServerConfig } from '@cursor/sdk';

/** SDK 自己的占位语法：`${env:NAME}`、`${NAME}` 与 `${NAME:-default}`。 */
const PLACEHOLDER_PATTERN = /\$\{(?:env:([A-Za-z_][A-Za-z0-9_]*)|([^:}]+)(?::-([^}]*))?)\}/g;
const WORKSPACE_VARIABLE_PATTERN =
  /\$\{(?:workspaceFolder|workspaceFolderBasename|userHome|pathSeparator|\/)\}/;
const WORKSPACE_PATH_PATTERN = /^\$\{(?:workspaceFolder|userHome)\}[\\/]/;
/** 第一个参数是脚本、脚本不存在就退出的解释器；别的命令的参数可能只是服务不在意的标签。 */
const SCRIPT_INTERPRETERS = new Set(['node', 'bun', 'tsx', 'python', 'python3']);
/** 找仓库根的 git 最多等多久。 */
const GIT_TIMEOUT_MS = 5_000;

type StdioServer = Extract<McpServerConfig, { command: string }>;

export interface WorkspaceMcpOptions {
  /** 展开 `${env:NAME}` 与 `${NAME}` 用的环境变量；`CURSOR_DATA_DIR` 也从这里读。 */
  env: NodeJS.ProcessEnv;
  /** 用户主目录（`~/.cursor/mcp.json` 与 `${userHome}`）。 */
  userHome: string;
}

/**
 * 工作目录的 mcp.json 里要展开变量才起得来的 stdio 服务，展开后的配置（服务名 → 配置），没有时是空对象。读不了
 * `mcp-disabled.json` 时抛错。
 */
export async function workspaceMcpServers(
  cwd: string,
  options: WorkspaceMcpOptions,
): Promise<Record<string, McpServerConfig>> {
  const { env, userHome } = options;
  const projectRoot = (await gitTopLevel(cwd)) ?? cwd;
  const variables = new Map([
    ['workspaceFolder', projectRoot],
    ['workspaceFolderBasename', basename(projectRoot)],
    ['userHome', userHome],
    ['pathSeparator', sep],
    ['/', sep],
  ]);
  const resolve = (text: string) =>
    text.replace(
      PLACEHOLDER_PATTERN,
      (match, envName: string | undefined, name: string, fallback: string | undefined) =>
        (envName === undefined
          ? (variables.get(name) ?? env[name] ?? fallback)
          : (env[envName] ?? '')) ?? match,
    );

  let disabled: Set<string> | undefined;
  const seen = new Set<string>();
  const servers: Record<string, McpServerConfig> = {};
  for (const file of [
    join(projectRoot, '.cursor', 'mcp.json'),
    join(userHome, '.cursor', 'mcp.json'),
  ]) {
    const contents = await readJsonc(file);
    // 同 SDK：先展开再校验，`"type": "${env:TYPE}"` 也算数。
    const config = mcpFile(expand(contents, resolve));
    if (config === undefined) continue;
    const raw = (contents as { mcpServers: Record<string, unknown> }).mcpServers;
    for (const [name, server] of Object.entries(config)) {
      if (seen.has(name)) continue;
      seen.add(name);
      // 插件的定义在 SDK 里优先，它看得到启用了哪些插件。
      if (!('command' in server) || name.startsWith('plugin-') || !needsExpansion(raw[name])) {
        continue;
      }
      disabled ??= await disabledServers(env, userHome, projectRoot);
      if (disabled.has(name)) continue;
      servers[name] = { ...server, cwd: server.cwd ?? projectRoot };
    }
  }
  return servers;
}

/** `git rev-parse --show-toplevel`：Cursor 与 git 一样按解析过符号链接的仓库根定位项目；不在仓库里时是 undefined。 */
function gitTopLevel(cwd: string): Promise<string | undefined> {
  return new Promise((done) => {
    execFile(
      'git',
      ['rev-parse', '--show-toplevel'],
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        const root = error === null ? stdout.trim() : '';
        done(root === '' ? undefined : root);
      },
    );
  });
}

/** Cursor 在 `~/.cursor/projects/<slug>` 下按项目路径存状态。 */
function cursorProjectSlug(projectRoot: string): string {
  return projectRoot
    .replace(/[^a-zA-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function disabledServers(
  env: NodeJS.ProcessEnv,
  userHome: string,
  projectRoot: string,
): Promise<Set<string>> {
  const dataDir = env.CURSOR_DATA_DIR || join(userHome, '.cursor');
  const file = join(dataDir, 'projects', cursorProjectSlug(projectRoot), 'mcp-disabled.json');
  const text = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '[]';
    throw error;
  });
  const names: unknown = JSON.parse(text);
  if (!Array.isArray(names) || !names.every((name) => typeof name === 'string')) {
    throw new Error(`${file} is not a list of server names`);
  }
  return new Set(names);
}

/**
 * 只要字面那份起不来的服务：SDK 也会起文件里定义的那份，保留 agent 级那份时丢掉它的句柄；agent 级的配置又不支持 `envFile`
 * 与 `enabledTools`，带这两项的不覆盖。
 */
function needsExpansion(server: unknown): boolean {
  if (typeof server !== 'object' || server === null) return false;
  if ('envFile' in server || 'enabledTools' in server) return false;
  const { command, cwd, args } = server as Record<string, unknown>;
  return (
    [command, cwd].some(
      (text) => typeof text === 'string' && WORKSPACE_VARIABLE_PATTERN.test(text),
    ) ||
    (typeof command === 'string' &&
      SCRIPT_INTERPRETERS.has(command.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '')) &&
      Array.isArray(args) &&
      typeof args[0] === 'string' &&
      WORKSPACE_PATH_PATTERN.test(args[0]))
  );
}

function expand<A>(value: A, resolve: (text: string) => string): A {
  if (typeof value === 'string') return resolve(value) as A;
  if (Array.isArray(value)) return value.map((item: unknown) => expand(item, resolve)) as A;
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, expand(item, resolve)]),
    ) as A;
  }
  return value;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isStringRecord = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((item) => typeof item === 'string');

/** 校验整个文件（同 T3：有一个服务的形状不对，整个文件都不用），只留 stdio 服务认得的字段；不是 mcp.json 时是 undefined。 */
function mcpFile(value: unknown): Record<string, StdioServer | { url: string }> | undefined {
  if (!isRecord(value) || !isRecord(value.mcpServers)) return undefined;
  const servers: Record<string, StdioServer | { url: string }> = {};
  for (const [name, server] of Object.entries(value.mcpServers)) {
    if (!isRecord(server)) return undefined;
    const { type, command, args, env, cwd, url } = server;
    if (typeof command === 'string') {
      if (type !== undefined && type !== 'stdio') return undefined;
      if (
        args !== undefined &&
        !(Array.isArray(args) && args.every((a) => typeof a === 'string'))
      ) {
        return undefined;
      }
      if (env !== undefined && !isStringRecord(env)) return undefined;
      if (cwd !== undefined && typeof cwd !== 'string') return undefined;
      servers[name] = {
        ...(type === 'stdio' && { type }),
        command,
        ...(args !== undefined && { args: args as string[] }),
        ...(env !== undefined && { env }),
        ...(cwd !== undefined && { cwd }),
      };
    } else if (typeof url === 'string') {
      if (type !== undefined && type !== 'http' && type !== 'sse') return undefined;
      servers[name] = { url };
    } else {
      return undefined;
    }
  }
  return servers;
}

/** 读一个 JSONC 文件（Cursor 的编辑器允许注释与尾逗号）；不存在或解析不了时是 undefined。 */
async function readJsonc(file: string): Promise<unknown> {
  const text = await readFile(file, 'utf8').catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(stripJsonc(text));
  } catch {
    return undefined;
  }
}

/** 去掉 JSONC 的 `//` 与 `/* *\/` 注释和 `}` / `]` 前的尾逗号，字符串里的不动。 */
export function stripJsonc(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index] as string;
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      out += text.slice(index, end + 1);
      index = end + 1;
    } else if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
    } else if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end === -1 ? text.length : end + 2;
    } else if (char === ',') {
      let next = index + 1;
      // 逗号后面只有空白与注释、接着是 } 或 ]：尾逗号。
      for (;;) {
        while (next < text.length && /\s/.test(text[next] as string)) next += 1;
        if (text.startsWith('//', next)) {
          while (next < text.length && text[next] !== '\n') next += 1;
        } else if (text.startsWith('/*', next)) {
          const end = text.indexOf('*/', next + 2);
          next = end === -1 ? text.length : end + 2;
        } else {
          break;
        }
      }
      if (text[next] !== '}' && text[next] !== ']') out += char;
      index += 1;
    } else {
      out += char;
      index += 1;
    }
  }
  return out;
}
