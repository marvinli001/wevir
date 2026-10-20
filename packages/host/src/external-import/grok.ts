// 从 Grok Build 导入（0.71.0）：只有 skills（`<GROK_HOME 或 ~/.grok>/skills/*/SKILL.md`）。记忆与 MCP 的格式还没支持。

import { join } from 'node:path';
import { type AppScan, exists, type ScanContext, skillDrafts } from './common.js';

export function grokHome(context: ScanContext): string {
  const dir = context.env.GROK_HOME;
  return dir !== undefined && dir !== '' ? dir : join(context.userHome, '.grok');
}

export async function scanGrok(context: ScanContext): Promise<AppScan> {
  const home = grokHome(context);
  const found = await exists(home);
  return {
    home,
    found,
    memories: [],
    connectors: [],
    skills: found ? await skillDrafts([join(home, 'skills')]) : [],
    unsupported: ['memory', 'connector'],
  };
}
