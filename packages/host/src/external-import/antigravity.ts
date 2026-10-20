// 从 Antigravity 导入（0.71.0）：skills 与 MCP 服务器。用户目录是 `~/.gemini`（Wevir 给 Antigravity 账号建的私有目录不扫）。
//
// - skills：运行体读的两个用户目录（adapter-antigravity 的 `antigravityUserSkillDirectories`），加上 `config/skills.json` 的
//   `entries[].path`（用户另加的 skills 目录，常见的是 `~/.codex/skills`，与 Codex 的重复由导入去重）。
// - MCP：`config/mcp_config.json` 的 `mcpServers`，`serverUrl` 是 Streamable HTTP 的地址。OAuth 令牌文件
//   （`antigravity/mcp_oauth_tokens.json`）不读。
// - 记忆的格式还没支持。

import { isAbsolute, join, resolve } from 'node:path';
import { antigravityUserSkillDirectories } from '@wevir/adapter-antigravity';
import { record } from '../plugin-skills.js';
import {
  type AppScan,
  connectorDrafts,
  exists,
  readSource,
  type ScanContext,
  skillDrafts,
} from './common.js';

export function antigravityHome(context: ScanContext): string {
  return join(context.userHome, '.gemini');
}

export async function scanAntigravity(context: ScanContext): Promise<AppScan> {
  const home = antigravityHome(context);
  const found = await exists(home);
  if (!found)
    return { home, found, memories: [], connectors: [], skills: [], unsupported: ['memory'] };
  const config = join(home, 'config');
  const roots: string[] = [...antigravityUserSkillDirectories(home)];
  const listed = await readSource(join(config, 'skills.json'));
  if (listed !== undefined) {
    let entries: unknown[] = [];
    try {
      const value = record(JSON.parse(listed)).entries;
      if (Array.isArray(value)) entries = value;
    } catch {}
    for (const entry of entries) {
      const path = record(entry).path;
      if (typeof path !== 'string' || path === '') continue;
      roots.push(
        path === '~' || path.startsWith('~/')
          ? join(context.userHome, path.slice(1))
          : isAbsolute(path)
            ? path
            : resolve(config, path),
      );
    }
  }
  const mcpPath = join(config, 'mcp_config.json');
  const mcp = await readSource(mcpPath);
  let servers: Record<string, unknown> = {};
  if (mcp !== undefined) {
    try {
      servers = record(record(JSON.parse(mcp)).mcpServers);
    } catch {}
  }
  return {
    home,
    found,
    memories: [],
    connectors: connectorDrafts(servers, 'antigravity', { path: mcpPath }),
    skills: await skillDrafts(roots),
    unsupported: ['memory'],
  };
}
