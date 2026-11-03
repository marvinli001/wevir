import { hostSupports } from '@wevir/client-sdk';
import type { DiffSource, HostFeatures, Session, Workspace } from '@wevir/protocol';

export function changeFolders(
  workspace: Pick<Workspace, 'extraFolders'>,
  session: Pick<Session, 'cwd' | 'extraRoots' | 'worktrees'>,
): string[] {
  const extra = session.extraRoots?.length
    ? session.extraRoots
    : session.worktrees?.length
      ? []
      : (workspace.extraFolders ?? []);
  return [...new Set([session.cwd, ...extra])];
}

/** 旧 Host 会丢弃未知字段，写操作也必须先确认支持目录选择。 */
export function folderParams(
  features: HostFeatures | undefined,
  folder: string | undefined,
  source?: DiffSource,
): { folder?: string } {
  return features && hostSupports(features, 'multi_folder_changes') && source?.kind !== 'turn'
    ? { ...(folder !== undefined && { folder }) }
    : {};
}

export function folderCacheKey(id: string, folder: string | undefined): string {
  return JSON.stringify([id, folder ?? null]);
}
