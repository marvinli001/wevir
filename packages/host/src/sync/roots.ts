import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, relative } from 'node:path';
import { ImageIdSchema } from '@wevir/protocol';
import type { Storage, SyncVaultRecord } from '@wevir/storage';
import type { ImageStore } from '../images.js';
import type { PluginRegistry } from '../plugins.js';
import { discoverRuleFiles } from '../rule-files.js';
import type { SyncBundleRoot } from './files-capture.js';

export async function syncBundleRoots(options: {
  vault: SyncVaultRecord;
  storage: Storage;
  plugins: PluginRegistry;
  images: ImageStore;
  userHome?: string;
  env?: NodeJS.ProcessEnv;
  allLocal?: boolean;
}): Promise<SyncBundleRoot[]> {
  const { vault, storage } = options;
  const roots: SyncBundleRoot[] = [];
  const mappings = options.allLocal
    ? storage.workspaces.list({ includeRemoved: true }).map((workspace) => ({
        projectId: workspace.id,
        workspaceId: workspace.id,
        displayName: workspace.displayName,
      }))
    : storage.sync.projects(vault.vaultId);
  const projects = mappings
    .filter(
      (value) =>
        value.workspaceId && (options.allLocal || vault.projectIds.includes(value.projectId)),
    )
    .flatMap((value) => {
      const workspace = storage.workspaces.get(value.workspaceId as string);
      return workspace ? [{ ...value, workspace }] : [];
    });
  const projectFor = (path: string) =>
    projects.find((value) => {
      const child = relative(value.workspace.rootPath, path);
      return (
        child !== '..' &&
        !child.startsWith('../') &&
        !child.startsWith('..\\') &&
        !isAbsolute(child)
      );
    });
  if (vault.categories.includes('skill-bundle'))
    for (const skill of await options.plugins.skills()) {
      if (skill.builtin) continue;
      const project = skill.source === 'project' ? projectFor(skill.path) : undefined;
      if (skill.source === 'project' && !project) continue;
      roots.push({
        category: 'skill-bundle',
        localKey: `skill:${skill.path}`,
        name: skill.name,
        path: dirname(skill.path),
        ...(project && { projectId: project.projectId }),
        metadata: { source: skill.source, enabled: skill.enabled },
      });
    }
  if (vault.categories.includes('rule')) {
    const seen = new Set<string>();
    const importRoots: string[] = [];
    for (const local of storage.sync.vaults()) {
      let after = '';
      while (true) {
        const bindings = storage.sync.bundleBindings(local.vaultId, after);
        if (!bindings.length) break;
        for (const binding of bindings) {
          importRoots.push(
            binding.targetKind === 'file' ? dirname(binding.targetPath) : binding.targetPath,
          );
          after = binding.entityId;
        }
      }
    }
    const userHome = options.userHome ?? homedir();
    for (const cwd of projects.length
      ? projects.map((value) => value.workspace.rootPath)
      : [userHome]) {
      for (const rule of await discoverRuleFiles({
        cwd,
        home: userHome,
        env: options.env ?? process.env,
        importRoots,
      })) {
        if (seen.has(rule.real) || rule.unreadable) continue;
        const project = rule.scope === 'project' ? projectFor(rule.real) : undefined;
        if (rule.scope === 'project' && !project) continue;
        seen.add(rule.real);
        roots.push({
          category: 'rule',
          localKey: `rule:${rule.real}`,
          name: basename(rule.path),
          path: rule.real,
          ...(project && { projectId: project.projectId }),
          metadata: { kind: rule.kind, scope: rule.scope },
        });
      }
    }
  }
  if (vault.categories.includes('artifact'))
    for (const [imageId, sessions] of storage.events.imageRefs()) {
      const project = projects.find((value) =>
        [...sessions].some((id) => storage.sessions.get(id)?.workspaceId === value.workspaceId),
      );
      if (!project) continue;
      const asset = await options.images.syncAsset(ImageIdSchema.parse(imageId));
      if (asset)
        roots.push({
          category: 'artifact',
          localKey: `image:${imageId}`,
          name: imageId,
          path: asset.path,
          projectId: project.projectId,
          metadata: { schema: 'wevir-image/1', part: asset.part },
        });
    }
  return roots;
}
