// 从 Codex 导入（0.74.0）：记忆、MCP 服务器与 skills。用户目录是 `CODEX_HOME` 或 `~/.codex`。
//
// - 记忆：`memories/MEMORY.md` 是 Codex 自己整理的手册（codex-rs/memories/write/templates/memories/consolidation.md，提交
//   092d3acd6bec3e3a14bdc7e7a2810ab628ab759d），每节以 `# Task Group: <标题>` 开头，节里有 `applies_to: cwd=<目录>; …`。一节一条
//   project 类的笔记：说明取标题，名字由标题生成，正文是这一节；`cwd` 对得上 Wevir 项目时建议放进那个项目。这些是 Codex 自动
//   总结的，默认都不勾。
// - MCP：`config.toml` 的 `[mcp_servers.*]` 是全局的；每个 Wevir 项目文件夹下的 `.codex/config.toml` 是那个项目的。
// - skills：`skills/*/SKILL.md`，Codex 自带的 `.system` 不导。

import { join } from 'node:path';
import type { WorkspaceId } from '@wevir/protocol';
import { parse } from 'smol-toml';
import { record } from '../plugin-skills.js';
import {
  type AppScan,
  type ConnectorDraft,
  connectorDrafts,
  exists,
  type MemoryDraft,
  matchProject,
  memoryDraft,
  memoryName,
  readSource,
  type ScanContext,
  skillDrafts,
} from './common.js';

export function codexHome(context: ScanContext): string {
  const dir = context.env.CODEX_HOME;
  return dir !== undefined && dir !== '' ? dir : join(context.userHome, '.codex');
}

export async function scanCodex(context: ScanContext): Promise<AppScan> {
  const home = codexHome(context);
  const found = await exists(home);
  const connectors: ConnectorDraft[] = [];
  if (found) connectors.push(...(await tomlServers(join(home, 'config.toml'), {})));
  for (const project of context.projects)
    for (const folder of project.folders)
      connectors.push(
        ...(await tomlServers(join(folder, '.codex', 'config.toml'), {
          workspaceId: project.id,
          project: folder,
        })),
      );
  return {
    home,
    found,
    memories: found ? await memories(context, join(home, 'memories', 'MEMORY.md')) : [],
    connectors,
    skills: found ? await skillDrafts([join(home, 'skills')]) : [],
    unsupported: [],
  };
}

async function tomlServers(
  path: string,
  target: { workspaceId?: WorkspaceId; project?: string },
): Promise<ConnectorDraft[]> {
  const text = await readSource(path);
  if (text === undefined) return [];
  let data: Record<string, unknown>;
  try {
    data = record(parse(text));
  } catch {
    return [];
  }
  return connectorDrafts(record(data.mcp_servers), 'codex', { path, ...target });
}

const HEADING = /^#\s+Task Group:\s*(.*)$/;

/** 把 MEMORY.md 按 `# Task Group:` 拆成几节；标题前的内容不算。 */
export function taskGroups(text: string): { title: string; body: string }[] {
  const groups: { title: string; lines: string[] }[] = [];
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const heading = HEADING.exec(line);
    if (heading !== null) groups.push({ title: (heading[1] ?? '').trim(), lines: [] });
    else groups.at(-1)?.lines.push(line);
  }
  return groups.map(({ title, lines }) => ({ title, body: lines.join('\n').trim() }));
}

/** 节里 `applies_to:` 的 `cwd=`（到 `;` 为止）。 */
export function appliesToCwd(body: string): string | undefined {
  const line = body.split('\n').find((item) => /^\s*applies_to:/i.test(item));
  const match = line === undefined ? null : /cwd=([^;]*)/.exec(line);
  const cwd = match?.[1]?.trim();
  return cwd === undefined || cwd === '' ? undefined : cwd;
}

async function memories(context: ScanContext, path: string): Promise<MemoryDraft[]> {
  const text = await readSource(path);
  if (text === undefined) return [];
  const used = new Map<string, number>();
  const titles = new Map<string, number>();
  return taskGroups(text).map(({ title, body }) => {
    // 同名的节：名字与条目标识按出现的次序加后缀。
    const seenTitle = (titles.get(title) ?? 0) + 1;
    titles.set(title, seenTitle);
    const base = memoryName(title, 'codex-memory');
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    const name = count === 1 ? base : `${base.slice(0, 60)}-${count}`;
    const cwd = appliesToCwd(body);
    const project = cwd === undefined ? undefined : matchProject(context.projects, cwd, true);
    return memoryDraft({
      path,
      entry: `${title}\n${seenTitle}`,
      name,
      type: 'project',
      description: title,
      content: body,
      scope: project === undefined ? 'global' : 'project',
      ...(project !== undefined && { workspaceId: project.workspaceId }),
      ...(cwd !== undefined && { project: cwd }),
      recommended: false,
    });
  });
}
