import { type MethodParams, validateSyncBatch } from '@wevir/protocol';
import { jcs, packRecord, type SyncOperation } from '@wevir/protocol/sync';
import type { Storage, SyncDraftRecord } from '@wevir/storage';
import { newId } from '../ids.js';
import type { ZuvClient } from '../zuv/client.js';
import { ZuvRequestError } from '../zuv/transport.js';
import { eventDigest, sha256 } from './crypto.js';
import type { SyncEngine } from './engine.js';
import type { SyncDraftPayload } from './queue.js';

export class SyncOutboxRecovery {
  constructor(readonly options: { storage: Storage; client: ZuvClient; engine: SyncEngine }) {}

  async recover(params: MethodParams<'sync.recoverOutbox'>, signal: AbortSignal): Promise<void> {
    const { storage, client, engine } = this.options;
    const vault = storage.sync.activeVault();
    const identity = await client.getEntitlements();
    if (
      !vault?.enabled ||
      vault.deviceId !== params.expectedDeviceId ||
      identity.identity.userId !== vault.accountId ||
      identity.subscriptionState !== 'active'
    )
      throw new ZuvRequestError('RECOVERY_REQUIRED');
    const guard = () => {
      signal.throwIfAborted();
      const current = storage.sync.activeVault();
      if (
        client.changingIdentity ||
        !client.signedIn ||
        current?.vaultId !== vault.vaultId ||
        current.revision !== vault.revision ||
        current.deviceId !== params.expectedDeviceId ||
        client.entitlements?.identity.userId !== vault.accountId ||
        client.entitlements.identity.deviceId !== identity.identity.deviceId ||
        client.entitlements.subscriptionState !== 'active'
      )
        throw new ZuvRequestError('SCOPE_DISABLED');
    };
    guard();
    const commits = storage.sync.commits(vault.vaultId);
    if (
      new Set(params.commitIds).size !== params.commitIds.length ||
      commits.length !== params.commitIds.length ||
      commits.some((commit) => !params.commitIds.includes(commit.commitId))
    )
      throw new ZuvRequestError('REVISION_CONFLICT');
    const entries: Array<{ draft: SyncDraftRecord; operation?: SyncOperation; commitId?: string }> =
      [];
    for (const commit of commits) {
      const batch = validateSyncBatch(JSON.parse(commit.body));
      const records = await engine.outboxRecords(commit, signal);
      for (const op of batch.operations) {
        const record = packRecord.parse(records.get(op.opId));
        entries.push({
          draft: {
            vaultId: vault.vaultId,
            opId: op.opId,
            entityId: op.entityId,
            kind: op.kind,
            parents: op.parents,
            createdAt: op.clientTime ?? new Date().toISOString(),
            content: {
              schema: 'wevir-sync-draft/1',
              body: record.content,
              ...(op.origin && { origin: op.origin }),
              ...(record.events && { events: record.events }),
            },
          },
          operation: op,
          commitId: commit.commitId,
        });
      }
    }
    const drafts = storage.sync.drafts(vault.vaultId, 4097);
    if (drafts.length > 4096 || entries.length > 4096) throw new ZuvRequestError('QUOTA_EXCEEDED');
    entries.push(...drafts.map((draft) => ({ draft })));
    for (const { draft } of entries) {
      const entity = storage.sync.entity(vault.vaultId, draft.entityId);
      if (
        !entity ||
        !vault.categories.includes(entity.entityType) ||
        (entity.projectId && !vault.projectIds.includes(entity.projectId))
      )
        throw new ZuvRequestError('SCOPE_DISABLED');
    }
    let target = vault;
    if (identity.identity.deviceId !== vault.deviceId) {
      const opened = await client.json(
        'vaultOpened',
        'POST',
        '/api/wevir/sync/v1/vaults/open',
        { protocol: 'wevir-sync/1', consent: true },
        { signal },
      );
      if (
        opened.vaultId !== vault.vaultId ||
        opened.deviceId !== identity.identity.deviceId ||
        opened.keyState !== 'ready'
      )
        throw new ZuvRequestError('RECOVERY_REQUIRED');
      const devices = await client.json('devices', 'GET', '/api/wevir/sync/v1/devices', undefined, {
        signal,
      });
      const device = devices.devices.find((value) => value.deviceId === opened.deviceId);
      if (!device || device.revokedAt) throw new ZuvRequestError('DEVICE_REVOKED');
      const scopes = await client.json(
        'scopesUpdated',
        'PUT',
        '/api/wevir/sync/v1/scopes',
        {
          expectedRevision: device.revision,
          enabled: true,
          categories: vault.categories,
          projectIds: vault.projectIds,
        },
        { signal },
      );
      target = {
        ...vault,
        deviceId: opened.deviceId,
        originHostId: opened.originHostId,
        deviceSeq: '0',
        revision: scopes.revision,
      };
      await client.getEntitlements();
    }
    guard();
    const ids = new Map(entries.map(({ draft }) => [draft.opId, newId('sop')]));
    const sources = new Map<
      string,
      { hostId: string; deviceId: string; sessionId: string; streamId: string }
    >();
    const entityIds = new Map<string, string>();
    const sessionIds = new Map<string, string>();
    const sessionsById = new Map<string, string>();
    const sourceKey = (source: { hostId: string; sessionId: string; streamId: string }) =>
      jcs([source.hostId, source.sessionId, source.streamId]);
    const recoverSource = (source: { hostId: string; sessionId: string; streamId: string }) => {
      const key = sourceKey(source);
      let value = sources.get(key);
      if (!value) {
        const sessionKey = jcs([source.hostId, source.sessionId]);
        const sessionId = sessionIds.get(sessionKey) ?? newId('ses');
        sessionIds.set(sessionKey, sessionId);
        sessionsById.set(source.sessionId, sessionId);
        value = {
          hostId: target.originHostId,
          deviceId: target.deviceId,
          sessionId,
          streamId: newId('sst'),
        };
        sources.set(key, value);
      }
      return value;
    };
    for (const { draft } of entries) {
      const payload = draft.content as SyncDraftPayload;
      if (payload.schema !== 'wevir-sync-draft/1') throw new ZuvRequestError('UPGRADE_REQUIRED');
      if (payload.origin) recoverSource(payload.origin);
      const body = payload.body as {
        schema?: string;
        source?: {
          hostId: string;
          sessionId: string;
          streamId: string;
        };
        metadata?: {
          source?: {
            hostId: string;
            sessionId: string;
            streamId: string;
          };
        };
      };
      if (body?.source) {
        const source = recoverSource(body.source);
        entityIds.set(
          draft.entityId,
          body.schema === 'wevir-episode/1'
            ? `ep_${source.sessionId.slice(4)}`
            : body.schema === 'wevir-retro-summary/1'
              ? `retro_${source.sessionId}`
              : source.sessionId,
        );
      }
      if (body?.metadata?.source) {
        recoverSource(body.metadata.source);
        entityIds.set(draft.entityId, newId('sen'));
      }
      if (payload.origin) entityIds.set(draft.entityId, newId('sen'));
    }
    for (const { draft } of entries) {
      const body = (draft.content as SyncDraftPayload).body as {
        schema?: string;
        ownerId?: string;
      };
      if (body?.schema === 'wevir-chunk/1' && body.ownerId && entityIds.has(body.ownerId))
        entityIds.set(draft.entityId, newId('sen'));
    }
    const remap = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(remap);
      if (!value || typeof value !== 'object') return value;
      const object = value as Record<string, unknown>;
      const source =
        typeof object.hostId === 'string' &&
        typeof object.sessionId === 'string' &&
        typeof object.streamId === 'string'
          ? sources.get(
              sourceKey(
                object as {
                  hostId: string;
                  sessionId: string;
                  streamId: string;
                },
              ),
            )
          : undefined;
      return Object.fromEntries(
        Object.entries(object).map(([key, entry]) => [
          key,
          source && ['hostId', 'deviceId', 'sessionId', 'streamId'].includes(key)
            ? source[key as keyof typeof source]
            : key === 'opId' && typeof entry === 'string'
              ? (ids.get(entry) ?? entry)
              : ['entityId', 'ownerId', 'episodeId', 'id'].includes(key) &&
                  typeof entry === 'string'
                ? (entityIds.get(entry) ?? entry)
                : ['sessionId', 'rootSessionId', 'parentSessionId'].includes(key) &&
                    typeof entry === 'string'
                  ? (sessionsById.get(entry) ?? entry)
                  : key === 'recoveredFrom'
                    ? entry
                    : remap(entry),
        ]),
      );
    };
    storage.transaction(() => {
      guard();
      const currentDrafts = storage.sync.drafts(vault.vaultId, 4097);
      const currentCommits = storage.sync.commits(vault.vaultId);
      if (
        currentDrafts.length !== drafts.length ||
        currentDrafts.some((value, index) => value.opId !== drafts[index]?.opId) ||
        currentCommits.length !== commits.length ||
        currentCommits.some((value, index) => value.commitId !== commits[index]?.commitId) ||
        storage.sync.captures(vault.vaultId).length
      )
        throw new ZuvRequestError('REVISION_CONFLICT');
      if (target.deviceId !== vault.deviceId) {
        storage.sync.rebindVaultDevice(
          vault.vaultId,
          vault.accountId,
          params.expectedDeviceId,
          target.deviceId,
          target.originHostId,
        );
        storage.sync.setScopes(vault.vaultId, target);
        const job = storage.sync.activeBootstrapJob(vault.vaultId);
        if (job) storage.sync.closeBootstrapJob(vault.vaultId, job.jobId);
      }
      for (const { draft, operation, commitId } of entries) {
        const payload = draft.content as SyncDraftPayload;
        const entity = storage.sync.entity(vault.vaultId, draft.entityId);
        if (!entity) throw new ZuvRequestError('INTEGRITY_FAILED');
        const opId = ids.get(draft.opId) as string;
        const originalBody = payload.body as { source?: unknown; metadata?: { source?: unknown } };
        const originalSource = originalBody?.source ?? originalBody?.metadata?.source;
        const recoveredFrom = {
          vaultId: vault.vaultId,
          deviceId: operation?.deviceId ?? vault.deviceId,
          opId: draft.opId,
          ...(commitId && { commitId }),
          ...(payload.origin && { origin: payload.origin }),
          ...(originalSource !== undefined && { source: originalSource }),
        };
        let body = remap(payload.body) as Record<string, unknown>;
        body = { ...body, recoveredFrom };
        let origin = payload.origin;
        let events = payload.events;
        let entityId = entityIds.get(entity.entityId) ?? entity.entityId;
        let localKey = entityId === entity.entityId ? entity.localKey : `recovered:${entityId}`;
        if (body.schema === 'wevir-session/1') body = { ...body, sessionId: entityId };
        if (origin) {
          const source = recoverSource(origin);
          origin = {
            ...origin,
            hostId: source.hostId,
            sessionId: source.sessionId,
            streamId: source.streamId,
          };
          body = { ...body, sessionId: source.sessionId, streamId: source.streamId };
          events = events?.map((event) => {
            const content = {
              ...(event.content as Record<string, unknown>),
              sessionId: source.sessionId,
            };
            return {
              ...event,
              content,
              sha256: eventDigest(
                {
                  vaultId: vault.vaultId,
                  hostId: source.hostId,
                  sessionId: source.sessionId,
                  streamId: source.streamId,
                  seq: event.seq,
                },
                content,
              ),
            };
          });
          entityId = entityIds.get(entity.entityId) as string;
          localKey = `recovered:${opId}`;
        }
        const content: SyncDraftPayload = {
          schema: 'wevir-sync-draft/1',
          body,
          ...(origin && { origin }),
          ...(events && { events }),
        };
        const next: SyncDraftRecord = {
          ...draft,
          opId,
          entityId,
          kind: draft.kind === 'resolve' ? 'put' : draft.kind,
          parents: draft.parents.flatMap((id) => (ids.has(id) ? [ids.get(id) as string] : [])),
          content,
        };
        if (!operation) storage.sync.removeDraft(vault.vaultId, draft.opId);
        else storage.sync.recoverOutboxOperation(vault.vaultId, draft.opId, opId);
        storage.sync.putOutboxRecovery(vault.vaultId, draft.opId, opId, recoveredFrom);
        if (entityId !== entity.entityId || entity.revision === draft.opId)
          storage.sync.putEntity({
            ...entity,
            entityId,
            localKey,
            revision: opId,
            fingerprint: sha256(jcs({ kind: next.kind, content })),
          });
        storage.sync.putDraft(next);
      }
      for (const commit of commits)
        storage.sync.recoverOutboxCommit(vault.vaultId, commit.commitId);
      for (const [key, source] of sources) {
        const [hostId, sessionId, streamId] = JSON.parse(key) as string[];
        const oldSource = storage.sync
          .sources(vault.vaultId)
          .find(
            (value) =>
              value.hostId === hostId &&
              value.sessionId === sessionId &&
              value.streamId === streamId,
          );
        const local = oldSource?.localSessionId && storage.sessions.get(oldSource.localSessionId);
        if (!local || oldSource.mirrored) continue;
        storage.sync.putSource({
          vaultId: vault.vaultId,
          ...source,
          localSessionId: local.id,
          mirrored: false,
        });
        const project = storage.sync
          .projects(vault.vaultId)
          .find((value) => value.workspaceId === local.workspaceId);
        if (project)
          storage.sync.capture({
            vaultId: vault.vaultId,
            localSessionId: local.id,
            streamId: source.streamId,
            projectId: project.projectId,
            throughSeq: local.lastSeq,
            preparedSeq: local.lastSeq,
          });
        const execution = storage.sync.execution(vault.vaultId, local.id);
        storage.sync.putExecution({
          vaultId: vault.vaultId,
          localSessionId: local.id,
          runId: execution?.runId ?? (sessionId as string),
          epoch: execution?.epoch ?? '0',
          streamId: source.streamId,
          state: 'offline',
          source: { hostId, deviceId: oldSource.deviceId ?? vault.deviceId, sessionId, streamId },
        });
      }
      storage.sync.setVaultTransport(vault.vaultId, {
        ...storage.sync.vaultTransport(vault.vaultId),
        state: 'pending',
        errorCode: undefined,
        retryAt: 0,
      });
    });
  }
}
