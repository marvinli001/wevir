// 从 Claude Code 导入（0.74.0）：记忆、MCP 服务器与 skills。
//
// 位置照 Claude Agent SDK 0.3.286 打包的 Claude Code：配置目录是 `CLAUDE_CONFIG_DIR` 或 `~/.claude`；全局配置文件是
// `join(CLAUDE_CONFIG_DIR || homedir(), '.claude.json')`（设了 `CLAUDE_CONFIG_DIR` 时在那个目录里，否则在主目录）。项目目录名是路径把
// 非字母数字的字符都换成 `-`，超过 200 个字符时截到 200 再接 `-<散列>`。
//
// - 记忆：`<配置目录>/projects/<项目>/memory/*.md`（`MEMORY.md` 是索引，不导）。
// - MCP：`.claude.json` 顶层的 `mcpServers` 是全局的，`projects[<路径>].mcpServers` 按路径对 Wevir 的项目；每个 Wevir 项目文件夹下的
//   `.mcp.json` 是那个项目的。
// - skills：`<配置目录>/skills/*/SKILL.md`。

import { readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { WorkspaceId } from '@wevir/protocol';
import { parse } from 'yaml';
import { record } from '../plugin-skills.js';
import {
  type AppScan,
  type ConnectorDraft,
  connectorDrafts,
  exists,
  type ImportProject,
  isWindowsPath,
  type MemoryDraft,
  matchProject,
  memoryDraft,
  memoryName,
  memoryType,
  readSource,
  type ScanContext,
  skillDrafts,
  splitFrontmatter,
} from './common.js';

const PROJECT_DIR_MAX = 200;

/** Claude Code 的项目目录名。 */
export function claudeProjectDir(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-');
}

/** 目录名对得上的 Wevir 项目文件夹（长路径只比前 200 个字符；Windows 路径不分大小写）。 */
function projectForDir(
  projects: readonly ImportProject[],
  dir: string,
): { workspaceId: WorkspaceId; folder: string } | undefined {
  for (const project of projects)
    for (const folder of project.folders) {
      const encoded = claudeProjectDir(folder);
      const [a, b] = isWindowsPath(folder)
        ? [dir.toLowerCase(), encoded.toLowerCase()]
        : [dir, encoded];
      if (
        a === b ||
        (b.length > PROJECT_DIR_MAX && a.startsWith(`${b.slice(0, PROJECT_DIR_MAX)}-`))
      )
        return { workspaceId: project.id, folder };
    }
  return undefined;
}

export function claudeHome(context: ScanContext): { home: string; globalConfig: string } {
  const dir = context.env.CLAUDE_CONFIG_DIR;
  return dir !== undefined && dir !== ''
    ? { home: dir, globalConfig: join(dir, '.claude.json') }
    : {
        home: join(context.userHome, '.claude'),
        globalConfig: join(context.userHome, '.claude.json'),
      };
}

export async function scanClaude(context: ScanContext): Promise<AppScan> {
  const { home, globalConfig } = claudeHome(context);
  const found = (await exists(home)) || (await exists(globalConfig));
  return {
    home,
    found,
    memories: found ? await memories(context, home) : [],
    // 项目文件夹里的 .mcp.json 不依赖 Claude Code 的用户目录。
    connectors: await connectors(context, globalConfig),
    skills: found ? await skillDrafts([join(home, 'skills')]) : [],
    unsupported: [],
  };
}

async function memories(context: ScanContext, home: string): Promise<MemoryDraft[]> {
  const root = join(home, 'projects');
  const dirs = await readdir(root, { withFileTypes: true }).catch(() => []);
  const drafts: MemoryDraft[] = [];
  for (const dir of dirs
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()) {
    const memoryDir = join(root, dir, 'memory');
    const files = await readdir(memoryDir, { withFileTypes: true }).catch(() => []);
    const project = projectForDir(context.projects, dir);
    for (const file of files
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'MEMORY.md')
      .map((entry) => entry.name)
      .sort()) {
      const path = join(memoryDir, file);
      const text = await readSource(path);
      if (text === undefined) continue;
      drafts.push(
        memoryFile(path, text, {
          scope: project === undefined ? 'global' : 'project',
          ...(project !== undefined && { workspaceId: project.workspaceId }),
          project: project?.folder ?? dir,
        }),
      );
    }
  }
  return drafts;
}

/** 一份记忆文件：frontmatter 的 name / description，type 在顶层或 `metadata.type`；没有说明时取正文第一行。 */
function memoryFile(
  path: string,
  text: string,
  target: { scope: 'global' | 'project'; workspaceId?: WorkspaceId; project: string },
): MemoryDraft {
  const { yaml, body } = splitFrontmatter(text);
  let fields: Record<string, unknown> = {};
  let broken = false;
  if (yaml !== undefined) {
    try {
      fields = record(parse(yaml));
    } catch {
      broken = true;
    }
  }
  const stem = basename(path, '.md');
  const rawName = typeof fields.name === 'string' ? fields.name : stem;
  const description =
    typeof fields.description === 'string'
      ? fields.description
      : (body
          .split('\n')
          .map((line) => line.replace(/^#+\s*/, '').trim())
          .find((line) => line !== '') ?? '');
  const draft = memoryDraft({
    path,
    entry: '',
    name: memoryName(rawName, memoryName(stem, 'imported-note')),
    type: memoryType(fields.type) ?? memoryType(record(fields.metadata).type) ?? 'project',
    description,
    content: body,
    ...target,
  });
  return broken && draft.problem === undefined ? { ...draft, problem: 'invalid' } : draft;
}

async function connectors(context: ScanContext, globalConfig: string): Promise<ConnectorDraft[]> {
  const drafts: ConnectorDraft[] = [];
  const text = await readSource(globalConfig);
  if (text !== undefined) {
    let data: Record<string, unknown> = {};
    try {
      data = record(JSON.parse(text));
    } catch {}
    drafts.push(...connectorDrafts(record(data.mcpServers), 'json', { path: globalConfig }));
    for (const [projectPath, value] of Object.entries(record(data.projects))) {
      const servers = record(record(value).mcpServers);
      if (Object.keys(servers).length === 0) continue;
      const project = matchProject(context.projects, projectPath);
      drafts.push(
        ...connectorDrafts(servers, 'json', {
          path: globalConfig,
          // 同一份文件里不同项目可以有同名的服务器：条目标识带上项目路径。
          entry: `${projectPath}\n`,
          project: projectPath,
          // 对不上 Wevir 项目的建议全局，但默认不勾（它原本只给那个项目）。
          ...(project === undefined
            ? { recommended: false }
            : { workspaceId: project.workspaceId }),
        }),
      );
    }
  }
  for (const project of context.projects)
    for (const folder of project.folders) {
      const path = join(folder, '.mcp.json');
      const json = await readSource(path);
      if (json === undefined) continue;
      let data: Record<string, unknown> = {};
      try {
        data = record(JSON.parse(json));
      } catch {
        continue;
      }
      drafts.push(
        ...connectorDrafts(record(data.mcpServers), 'json', {
          path,
          workspaceId: project.id,
          project: folder,
        }),
      );
    }
  return drafts;
}
