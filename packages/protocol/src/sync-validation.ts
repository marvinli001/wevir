import { jcs, LIMITS, schemas, validateOperation } from './sync-wire.js';

export function validateSyncBatch(value: unknown) {
  const batch = schemas.commit.parse(value);
  if (new TextEncoder().encode(jcs(batch)).length > LIMITS.commitBytes)
    throw new Error('commit size limit');
  if (batch.recordManifest.length !== batch.operations.length)
    throw new Error('manifest count mismatch');
  const manifests = new Map(batch.recordManifest.map((entry) => [entry.opId, entry]));
  if (manifests.size !== batch.recordManifest.length) throw new Error('duplicate manifest');
  const opIds = new Set<string>();
  const sequences = new Set<string>();
  let eventCount = 0n;
  for (const value of batch.operations) {
    const op = validateOperation(value);
    const sequence = `${op.deviceId}:${op.deviceSeq}`;
    if (opIds.has(op.opId) || sequences.has(sequence)) throw new Error('duplicate operation');
    opIds.add(op.opId);
    sequences.add(sequence);
    const manifest = manifests.get(op.opId);
    if (
      !manifest ||
      manifest.blobId !== op.payload?.blobId ||
      manifest.recordIndex !== op.payload?.recordIndex
    )
      throw new Error('manifest reference mismatch');
    if (
      ['project', 'session', 'event-segment', 'workspace-snapshot'].includes(op.entityType) &&
      !manifest.projectId
    )
      throw new Error('project required');
    if (op.entityType === 'project' && manifest.projectId !== op.entityId)
      throw new Error('project identity mismatch');
    if (op.origin) {
      const count = BigInt(op.origin.throughSeq) - BigInt(op.origin.fromSeq) + 1n;
      eventCount += count;
      if (eventCount > 4096n) throw new Error('source sequence limit');
      if (!manifest.events || BigInt(manifest.events.length) !== count)
        throw new Error('manifest event range mismatch');
      for (const [index, event] of manifest.events.entries()) {
        if (BigInt(event.seq) !== BigInt(op.origin.fromSeq) + BigInt(index))
          throw new Error('manifest event sequence mismatch');
      }
    } else if (manifest.events?.length) {
      throw new Error('manifest origin required');
    }
  }
  return batch;
}
