import type { SyncOperation } from '@wevir/protocol/sync';
import type { Storage } from '@wevir/storage';

export function syncParents(
  storage: Storage,
  vaultId: string,
  entityId: string,
  opId: string,
): string[] | undefined {
  const op = storage.sync.getOperation(vaultId, opId);
  if (op)
    return op.entityId === entityId && op.state !== 'quarantined'
      ? (op.envelope as SyncOperation).parents
      : undefined;
  const draft = storage.sync.draft(vaultId, opId);
  return draft?.entityId === entityId ? draft.parents : undefined;
}

export function syncAncestors(
  storage: Storage,
  vaultId: string,
  entityId: string,
  start: string,
): Set<string> | undefined {
  const found = new Set<string>(),
    pending = [start];
  while (pending.length) {
    const id = pending.pop() as string;
    if (found.has(id)) continue;
    if (found.size >= 1024) return;
    const parents = syncParents(storage, vaultId, entityId, id);
    if (!parents) return;
    found.add(id);
    pending.push(...parents);
  }
  return found;
}
