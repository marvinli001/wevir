import { readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { type ContextPart, contextPart, type SessionConfig } from '@wevir/runtime-adapter';
import type { CodexProcess } from './codex-process.js';
import { systemToolCatalogs } from './context-calibration.js';
import { CODEX_VERSION } from './paths.js';

export async function codexMcpParts(
  process: Pick<CodexProcess, 'request'>,
  threadId: string,
): Promise<ContextPart[]> {
  const parts: ContextPart[] = [];
  let cursor: string | null = null;
  do {
    const page: {
      data: { name: string; tools: Record<string, { name: string }> }[];
      nextCursor?: string | null;
    } = await process.request('mcpServerStatus/list', {
      threadId,
      detail: 'toolsAndAuthOnly',
      ...(cursor && { cursor }),
    });
    for (const server of page.data) {
      for (const tool of Object.values(server.tools)) {
        parts.push(contextPart('MCP tools', JSON.stringify(tool), tool.name, server.name));
      }
    }
    cursor = page.nextCursor ?? null;
  } while (cursor);
  return parts;
}

export async function codexSkillParts(
  process: Pick<CodexProcess, 'request'>,
  cwd: string,
): Promise<ContextPart[]> {
  const result = await process.request<{
    data: Array<{
      cwd: string;
      skills: Array<{ enabled: boolean; name: string; description: string; path: string }>;
    }>;
  }>('skills/list', { cwds: [cwd] });
  const skills =
    result.data.find((entry) => entry.cwd === cwd)?.skills.filter((skill) => skill.enabled) ?? [];
  // Codex abbreviates the SKILL.md paths using numbered roots.
  const roots = [...new Set(skills.map((skill) => dirname(dirname(skill.path))))];
  return skills.map((skill) => {
    const root = dirname(dirname(skill.path));
    const line = `- ${skill.name}: ${skill.description} (file: r${roots.indexOf(root)}/${relative(root, skill.path).replaceAll('\\', '/')})`;
    return contextPart('Skills', line, skill.name);
  });
}

export async function subscriptionToolSearch(home: string, modelId: string): Promise<boolean> {
  try {
    const catalog = JSON.parse(await readFile(join(home, 'models_cache.json'), 'utf8'));
    const model = catalog.models?.find((item: { slug: string }) => item.slug === modelId);
    return model?.supports_search_tool === true;
  } catch {
    return false;
  }
}

export function codexTools(
  config: SessionConfig | undefined,
  mcp: readonly ContextPart[],
  search: boolean,
  version = CODEX_VERSION,
): ContextPart[] {
  const host = config?.contextSupply?.('layered') ?? [];
  const fromHost = new Set(host.filter((p) => p.category === 'MCP tools').map((p) => p.source));
  const tools = [...host, ...mcp.filter((p) => !fromHost.has(p.source))];
  const denied = new Set(config?.engineTools?.denied);
  for (const [name, [bytes, weight]] of Object.entries(systemToolCatalogs[version] ?? {})) {
    if (denied.has('shell') && ['exec_command', 'write_stdin'].includes(name)) continue;
    if (!search && name === 'tool_search') continue;
    tools.push({
      category: 'System tools',
      name,
      bytes,
      weight,
      deferred: search && name.startsWith('multi_agent_v1__'),
    });
  }
  if (!search) return tools;
  return tools
    .filter((p) => p.source !== 'wevir_more' || p.category === 'MCP tools')
    .map((p) =>
      p.category === 'MCP tools' &&
      p.source !== 'wevir' &&
      !['wevir_history', 'wevir_web', 'wevir_tasks'].includes(p.source ?? '')
        ? { ...p, deferred: true }
        : p,
    );
}

export function gatewayDeferred(
  sent: readonly ContextPart[],
  supply: readonly ContextPart[],
): ContextPart[] {
  const loaded = new Set(
    sent.filter((p) => p.name).map((p) => JSON.stringify([p.category, p.source, p.name])),
  );
  return supply
    .filter(
      (p) =>
        p.name &&
        (p.category === 'MCP tools' || (p.category === 'System tools' && p.deferred)) &&
        !loaded.has(JSON.stringify([p.category, p.source, p.name])),
    )
    .map((p) => ({ ...p, deferred: true }));
}
