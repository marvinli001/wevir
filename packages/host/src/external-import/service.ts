// `import.scan` / `import.apply`（0.71.0）：按应用调扫描器，和 Wevir 里已有的比出状态；导入时重新扫描，按 `key` 找到条目再写入
// （客户端只给 key、目标与改名，内容总从源文件读）。只增不改：同名的已有就不写。

import { readFile } from 'node:fs/promises';
import {
  type Connector,
  ConnectorNameSchema,
  type ImportApp,
  type ImportApplyItem,
  type ImportApplyResultItem,
  type ImportCandidateStatus,
  type ImportConnectorCandidate,
  type ImportMemoryCandidate,
  type ImportScanResult,
  type ImportSkillCandidate,
  type McpServerConfig,
  type WorkspaceId,
} from '@wevir/protocol';
import type { WorkspaceRecord } from '@wevir/storage';
import { HostError } from '../errors.js';
import { MEMORY_NAME_PATTERN, MemoryError, type MemoryStore } from '../memory.js';
import type { PluginRegistry } from '../plugins.js';
import { scanAntigravity } from './antigravity.js';
import { scanClaude } from './claude.js';
import { scanCodex } from './codex.js';
import {
  type AppScan,
  type ConnectorDraft,
  contentHash,
  type ImportProject,
  type MemoryDraft,
  type ScanContext,
  type SkillDraft,
} from './common.js';
import { scanGrok } from './grok.js';

const SCANNERS: Record<ImportApp, (context: ScanContext) => Promise<AppScan>> = {
  claude: scanClaude,
  codex: scanCodex,
  grok: scanGrok,
  antigravity: scanAntigravity,
};

export interface ExternalImportOptions {
  /** 用户主目录。 */
  userHome: string;
  /** 读 `CLAUDE_CONFIG_DIR`、`CODEX_HOME`、`GROK_HOME`。 */
  env: Readonly<Record<string, string | undefined>>;
  /** Wevir 的项目（没移除的）。 */
  workspaces: { list(): WorkspaceRecord[]; get(id: string): WorkspaceRecord | undefined };
  memory: MemoryStore;
  plugins: PluginRegistry;
}

export class ExternalImport {
  readonly #options: ExternalImportOptions;

  constructor(options: ExternalImportOptions) {
    this.#options = options;
  }

  async scan(app: ImportApp): Promise<ImportScanResult> {
    const scan = await this.#read(app);
    const connectors = this.#options.plugins.connectors();
    const skills = await this.#skillHashes();
    return {
      app,
      found: scan.found,
      home: scan.home,
      memories: await Promise.all(scan.memories.map((draft) => this.#memoryCandidate(draft))),
      connectors: scan.connectors.map((draft) => connectorCandidate(draft, connectors)),
      skills: await Promise.all(scan.skills.map((draft) => skillCandidate(draft, skills))),
      unsupported: scan.unsupported,
    };
  }

  async apply(app: ImportApp, items: readonly ImportApplyItem[]): Promise<ImportApplyResultItem[]> {
    const scan = await this.#read(app);
    const drafts = new Map<
      string,
      | { kind: 'memory'; draft: MemoryDraft }
      | { kind: 'connector'; draft: ConnectorDraft }
      | { kind: 'skill'; draft: SkillDraft }
    >([
      ...scan.memories.map((draft) => [draft.key, { kind: 'memory' as const, draft }] as const),
      ...scan.connectors.map(
        (draft) => [draft.key, { kind: 'connector' as const, draft }] as const,
      ),
      ...scan.skills.map((draft) => [draft.key, { kind: 'skill' as const, draft }] as const),
    ]);
    const results: ImportApplyResultItem[] = [];
    // 一条一条来：上限与重名按前面已导入的算。
    for (const item of items) {
      const found = drafts.get(item.key);
      if (found === undefined) {
        results.push({ key: item.key, outcome: 'failed', reason: 'not_found' });
        continue;
      }
      const fail = (reason: string): ImportApplyResultItem => ({
        key: item.key,
        outcome: 'failed',
        kind: found.kind,
        reason,
      });
      if (found.draft.problem !== undefined) {
        results.push(fail(found.draft.problem));
        continue;
      }
      try {
        results.push(
          found.kind === 'memory'
            ? await this.#applyMemory(app, item, found.draft)
            : found.kind === 'connector'
              ? await this.#applyConnector(app, item, found.draft)
              : await this.#applySkill(app, item, found.draft),
        );
      } catch (error) {
        results.push(fail(error instanceof MemoryError ? error.code : 'invalid'));
      }
    }
    return results;
  }

  async #read(app: ImportApp): Promise<AppScan> {
    const projects: ImportProject[] = this.#options.workspaces.list().map((workspace) => ({
      id: workspace.id as WorkspaceId,
      folders: [workspace.rootPath, ...(workspace.extraFolders ?? [])],
    }));
    const scan = await SCANNERS[app]({
      userHome: this.#options.userHome,
      env: this.#options.env,
      projects,
    });
    // Antigravity 会把 ~/.codex/skills 等目录再列一遍：同名同内容的只留一个。
    const seen = new Set<string>();
    return {
      ...scan,
      skills: scan.skills.filter((draft) => {
        const id = `${draft.name}\n${draft.hash}`;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      }),
    };
  }

  /** 项目在、没被移除。 */
  #workspace(id: string | undefined): boolean {
    if (id === undefined) return false;
    const workspace = this.#options.workspaces.get(id);
    return workspace !== undefined && workspace.removedAt === undefined;
  }

  async #memoryCandidate(draft: MemoryDraft): Promise<ImportMemoryCandidate> {
    const status = await this.#options.memory
      .compare(draft.scope, draft.workspaceId, draft)
      .catch((): ImportCandidateStatus => 'new');
    return {
      key: draft.key,
      path: draft.path,
      status,
      ...(draft.problem !== undefined && { problem: draft.problem }),
      recommended: draft.recommended ?? (status === 'new' && draft.problem === undefined),
      ...(draft.project !== undefined && { project: draft.project }),
      name: draft.name,
      type: draft.type,
      description: draft.description,
      content: draft.content,
      scope: draft.scope,
      ...(draft.workspaceId !== undefined && { workspaceId: draft.workspaceId }),
    };
  }

  async #applyMemory(
    app: ImportApp,
    item: ImportApplyItem,
    draft: MemoryDraft,
  ): Promise<ImportApplyResultItem> {
    const memory = this.#options.memory;
    const scope = item.scope ?? draft.scope;
    const workspaceId =
      scope === 'project'
        ? (item.workspaceId ?? (draft.scope === 'project' ? draft.workspaceId : undefined))
        : undefined;
    const name = item.name ?? draft.name;
    const result = (outcome: ImportApplyResultItem['outcome'], reason?: string) => ({
      key: item.key,
      outcome,
      kind: 'memory' as const,
      name,
      ...(reason !== undefined && { reason }),
    });
    if (scope === 'project' && !this.#workspace(workspaceId))
      return result('failed', 'no_workspace');
    if (!MEMORY_NAME_PATTERN.test(name)) return result('failed', 'invalid_name');
    const input = {
      name,
      type: draft.type,
      description: draft.description,
      content: draft.content,
    };
    const status = await memory.compare(scope, workspaceId, input);
    if (status === 'same') return result('skipped');
    if (status === 'exists') return result('failed', 'exists');
    await memory.importNote(scope, workspaceId, input, { app, path: draft.path });
    return result('imported');
  }

  async #applyConnector(
    app: ImportApp,
    item: ImportApplyItem,
    draft: ConnectorDraft,
  ): Promise<ImportApplyResultItem> {
    // 连接器的项目：给了 workspaceId 就是它；`scope: global` 是全局；都没给用扫描时建议的。
    const workspaceId =
      item.workspaceId ?? (item.scope === 'global' ? undefined : draft.workspaceId);
    const name = item.name ?? draft.name;
    const result = (outcome: ImportApplyResultItem['outcome'], reason?: string) => ({
      key: item.key,
      outcome,
      kind: 'connector' as const,
      name,
      ...(reason !== undefined && { reason }),
    });
    if (draft.config === undefined) return result('failed', 'invalid');
    if (workspaceId !== undefined && !this.#workspace(workspaceId))
      return result('failed', 'no_workspace');
    if (!ConnectorNameSchema.safeParse(name).success) return result('failed', 'invalid_name');
    const status = connectorStatus(
      this.#options.plugins.connectors(),
      name,
      workspaceId,
      draft.config,
    );
    if (status === 'same') return result('skipped');
    if (status === 'exists') return result('failed', 'exists');
    try {
      await this.#options.plugins.add(name, draft.config, undefined, undefined, {
        ...(workspaceId !== undefined && { workspaceId }),
        importedFrom: { app, path: draft.path },
        pending: draft.pending,
      });
    } catch (error) {
      if (error instanceof HostError && /already exists/.test(error.message))
        return result('failed', 'exists');
      throw error;
    }
    return result('imported');
  }

  async #applySkill(
    app: ImportApp,
    item: ImportApplyItem,
    draft: SkillDraft,
  ): Promise<ImportApplyResultItem> {
    const result = (outcome: ImportApplyResultItem['outcome'], reason?: string) => ({
      key: item.key,
      outcome,
      kind: 'skill' as const,
      name: draft.name,
      ...(reason !== undefined && { reason }),
    });
    // skills 的名字写在 SKILL.md 里，不能改名。
    if (item.name !== undefined && item.name !== draft.name)
      return result('failed', 'invalid_name');
    const status = skillStatus(draft, await this.#skillHashes());
    if (status === 'same') return result('skipped');
    if (status === 'exists') return result('failed', 'exists');
    const imported = await this.#options.plugins.importSkill(draft.folder, {
      app,
      path: draft.path,
    });
    return 'exists' in imported ? result('failed', 'exists') : result('imported');
  }

  /** Wevir 已知的 skills：名字 → SKILL.md 内容的散列（读不出来时是空串）。 */
  async #skillHashes(): Promise<Map<string, string[]>> {
    const hashes = new Map<string, string[]>();
    for (const skill of await this.#options.plugins.skills()) {
      const hash = await readFile(skill.path, 'utf8').then(contentHash, () => '');
      hashes.set(skill.name, [...(hashes.get(skill.name) ?? []), hash]);
    }
    return hashes;
  }
}

function skillStatus(draft: SkillDraft, existing: Map<string, string[]>): ImportCandidateStatus {
  const hashes = existing.get(draft.name);
  if (hashes === undefined) return 'new';
  return hashes.includes(draft.hash) ? 'same' : 'exists';
}

async function skillCandidate(
  draft: SkillDraft,
  existing: Map<string, string[]>,
): Promise<ImportSkillCandidate> {
  const status = skillStatus(draft, existing);
  return {
    key: draft.key,
    path: draft.path,
    status,
    ...(draft.problem !== undefined && { problem: draft.problem }),
    recommended: draft.recommended ?? (status === 'new' && draft.problem === undefined),
    ...(draft.project !== undefined && { project: draft.project }),
    name: draft.name,
    description: draft.description,
  };
}

/** 连接器配置的可比形状：值不比（导入的是空的），只比键名。 */
function shape(config: Connector['config'] | McpServerConfig): string {
  const keys = (value: Record<string, unknown> | undefined) =>
    value === undefined ? [] : Object.keys(value).sort();
  return JSON.stringify(
    config.transport === 'stdio'
      ? [
          'stdio',
          config.command,
          config.args ?? [],
          config.cwd ?? null,
          keys(config.env),
          config.toolTimeoutSec ?? null,
        ]
      : ['http', config.url, keys(config.headers), config.toolTimeoutSec ?? null],
  );
}

/**
 * 和已有的比：名字在“全局 ∪ 同一项目”里冲突的（全局的目标与任何项目里的同名都冲突）有一个就不是 `new`；冲突的是散装的、形状一样
 * 时是 `same`。
 */
function connectorStatus(
  existing: readonly Connector[],
  name: string,
  workspaceId: string | undefined,
  config: McpServerConfig,
): ImportCandidateStatus {
  const conflicts = existing.filter(
    (item) =>
      item.name === name &&
      (workspaceId === undefined ||
        item.workspaceId === undefined ||
        item.workspaceId === workspaceId),
  );
  if (conflicts.length === 0) return 'new';
  return conflicts.some(
    (item) =>
      item.pluginId === undefined &&
      item.workspaceId === workspaceId &&
      shape(item.config) === shape(config),
  )
    ? 'same'
    : 'exists';
}

function connectorCandidate(
  draft: ConnectorDraft,
  existing: readonly Connector[],
): ImportConnectorCandidate {
  const status =
    draft.config === undefined
      ? 'new'
      : connectorStatus(existing, draft.name, draft.workspaceId, draft.config);
  return {
    key: draft.key,
    path: draft.path,
    status,
    ...(draft.problem !== undefined && { problem: draft.problem }),
    recommended:
      draft.recommended === false ? false : status === 'new' && draft.problem === undefined,
    ...(draft.project !== undefined && { project: draft.project }),
    name: draft.name,
    ...(draft.config !== undefined && { config: markers(draft.config) }),
    ...(draft.workspaceId !== undefined && { workspaceId: draft.workspaceId }),
  };
}

/** 线缆上的配置：环境变量与请求头只有键名。 */
function markers(config: McpServerConfig): ImportConnectorCandidate['config'] {
  if (config.transport === 'stdio') {
    const { env, ...rest } = config;
    return {
      ...rest,
      ...(env !== undefined && {
        env: Object.fromEntries(Object.keys(env).map((key) => [key, true as const])),
      }),
    };
  }
  const { headers, ...rest } = config;
  return {
    ...rest,
    ...(headers !== undefined && {
      headers: Object.fromEntries(Object.keys(headers).map((key) => [key, true as const])),
    }),
  };
}
