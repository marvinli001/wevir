import {
  type SessionId,
  type SyncContinuation,
  SyncContinuationSchema,
  type TurnId,
} from '@wevir/protocol';
import type { Storage, SyncExecutionRecord, SyncVaultRecord } from '@wevir/storage';
import type { EventStore } from '../event-store.js';
import { newId } from '../ids.js';
import type { ZuvClient } from '../zuv/client.js';
import { ZuvRequestError } from '../zuv/transport.js';
import type { SyncEventCapture } from './capture.js';

const LEASE_SECONDS = 30;

interface ExecutionOptions {
  storage: Storage;
  events: EventStore;
  client: ZuvClient;
  capture: SyncEventCapture;
  eligible: () => SyncVaultRecord | undefined;
}
export class SyncExecutions {
  readonly #options: ExecutionOptions;
  readonly #active = new Map<
    string,
    { value: SyncExecutionRecord; timer?: ReturnType<typeof setTimeout> }
  >();
  readonly #releasing = new Map<string, Promise<void>>();
  readonly #pending = new Set<Promise<void>>();
  readonly #preparing = new Map<
    string,
    { turnId: TurnId; abort: AbortController; finished: boolean; task?: Promise<void> }
  >();
  #abort = new AbortController();

  constructor(options: ExecutionOptions) {
    this.#options = options;
  }

  continuation(sessionId: SessionId): SyncContinuation | undefined {
    const { storage } = this.#options;
    const vault = this.#options.eligible();
    if (!vault) return undefined;
    const session = storage.sessions.get(sessionId);
    if (!session) return undefined;
    const source = storage.sync
      .sources(vault.vaultId)
      .find((value) => value.localSessionId === sessionId);
    if (!source?.deviceId) return undefined;
    const execution = this.#options.events.state(sessionId)?.syncExecution;
    return {
      vaultId: vault.vaultId,
      runId: execution?.runId ?? source.sessionId,
      epoch: execution?.epoch ?? '0',
      source: {
        hostId: source.hostId,
        deviceId: source.deviceId,
        sessionId: source.sessionId as SessionId,
        streamId: execution?.streamId ?? source.streamId,
      },
    };
  }

  prepare(sessionId: SessionId, turnId: TurnId): Promise<void> {
    const previous = this.#preparing.get(sessionId);
    const claim = {
      turnId,
      abort: new AbortController(),
      finished: false,
      task: undefined as Promise<void> | undefined,
    };
    if (previous && !previous.finished) previous.abort.abort();
    this.#preparing.set(sessionId, claim);
    const task = (async () => {
      if (previous?.finished) await previous.task;
      await this.#prepare(sessionId, turnId, claim);
    })().finally(() => {
      if (this.#preparing.get(sessionId) === claim) this.#preparing.delete(sessionId);
      this.#pending.delete(task);
    });
    claim.task = task;
    this.#pending.add(task);
    return task;
  }

  async #prepare(
    sessionId: SessionId,
    turnId: TurnId,
    claim: { abort: AbortController; finished: boolean },
  ): Promise<void> {
    const signal = AbortSignal.any([this.#abort.signal, claim.abort.signal]);
    await this.#releasing.get(sessionId);
    if (signal.aborted) return;
    const { storage, client } = this.#options;
    const vault = this.#options.eligible();
    const session = storage.sessions.get(sessionId);
    if (!vault || !session || session.engine === 'sync' || session.parentSessionId) return;
    const project = storage.sync
      .projects(vault.vaultId)
      .find((value) => value.workspaceId === session.workspaceId);
    if (
      !project ||
      !vault.projectIds.includes(project.projectId) ||
      !vault.categories.includes('session') ||
      !vault.categories.includes('event-segment')
    )
      return;
    const inherited = SyncContinuationSchema.safeParse(
      session.origin?.kind === 'history' ? session.origin.syncContinuation : undefined,
    );
    if (inherited.success && inherited.data.vaultId !== vault.vaultId) return;
    const previous = storage.sync.execution(vault.vaultId, sessionId);
    const value: SyncExecutionRecord = {
      vaultId: vault.vaultId,
      localSessionId: sessionId,
      runId: previous?.runId ?? (inherited.success ? inherited.data.runId : sessionId),
      epoch: previous?.epoch ?? (inherited.success ? inherited.data.epoch : '0'),
      streamId:
        previous?.streamId ?? this.#options.capture.source(sessionId)?.streamId ?? newId('sst'),
      state: 'offline',
      turnId,
      ...(inherited.success && { source: inherited.data.source }),
    };
    // A crashed or disconnected holder is never evidence that its commands stopped.
    if (previous && previous.state !== 'released') value.streamId = newId('sst');
    let branchRequired = inherited.success;
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(2000)]);
    try {
      const request = () =>
        client.json(
          'execution',
          'POST',
          '/api/wevir/sync/v1/executions/claim',
          { runId: value.runId, expectedEpoch: value.epoch, leaseSeconds: LEASE_SECONDS },
          { signal: requestSignal },
        );
      let result: Awaited<ReturnType<typeof request>>;
      try {
        result = await request();
      } catch (error) {
        if (!(error instanceof ZuvRequestError) || error.code !== 'EXECUTION_CONFLICT') throw error;
        if (claim.finished || !this.#sameVault(vault) || signal.aborted) return;
        const current = await client.executionState(value.runId, requestSignal);
        if (claim.finished || !this.#sameVault(vault) || signal.aborted) return;
        requestSignal.throwIfAborted();
        if (!current) throw error;
        if (current.runId !== value.runId || BigInt(current.epoch) < BigInt(value.epoch))
          throw new ZuvRequestError('INTEGRITY_FAILED');
        value.epoch = current.epoch;
        if (current.state === 'held') throw error;
        result = await request();
      }
      if (!this.#sameVault(vault) || (signal.aborted && !claim.finished)) return;
      if (
        result.runId !== value.runId ||
        BigInt(result.epoch) !== BigInt(value.epoch) + 1n ||
        Date.parse(result.expiresAt) <= client.transport.serverNow() ||
        Date.parse(result.expiresAt) > client.transport.serverNow() + LEASE_SECONDS * 1000 + 2000
      )
        throw new ZuvRequestError('INTEGRITY_FAILED');
      Object.assign(value, {
        epoch: result.epoch,
        fencingToken: result.fencingToken,
        expiresAt: result.expiresAt,
        state: 'claimed',
      });
      branchRequired ||= result.branchRequired;
      if (result.branchRequired) value.streamId = newId('sst');
      if (claim.finished) {
        this.#save(value, branchRequired);
        await this.#trackRelease(value);
        return;
      }
    } catch (error) {
      if (claim.finished || !this.#sameVault(vault) || signal.aborted) return;
      value.state =
        error instanceof ZuvRequestError && error.code === 'EXECUTION_CONFLICT'
          ? 'conflict'
          : 'offline';
      value.streamId = newId('sst');
      branchRequired = true;
    }
    this.#save(value, branchRequired);
    const active = { value };
    this.#active.set(sessionId, active);
    if (value.state === 'claimed') this.#schedule(sessionId);
  }

  finish(sessionId: SessionId, turnId: TurnId): void {
    const claim = this.#preparing.get(sessionId);
    if (claim?.turnId === turnId) {
      claim.finished = true;
    }
    const active = this.#active.get(sessionId);
    if (!active || active.value.turnId !== turnId) return;
    clearTimeout(active.timer);
    this.#active.delete(sessionId);
    if (active.value.state === 'claimed') {
      void this.#trackRelease(active.value);
    }
  }

  stop(): void {
    this.#abort.abort();
    for (const { value, timer } of this.#active.values()) {
      clearTimeout(timer);
      if (value.state === 'claimed')
        this.#save(
          { ...value, state: 'lost', streamId: newId('sst'), fencingToken: undefined },
          true,
        );
    }
    this.#active.clear();
    this.#abort = new AbortController();
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.#pending]);
  }

  #sameVault(vault: SyncVaultRecord): boolean {
    const current = this.#options.eligible();
    return (
      current?.vaultId === vault.vaultId &&
      current.deviceId === vault.deviceId &&
      current.revision === vault.revision
    );
  }

  #schedule(sessionId: string): void {
    const active = this.#active.get(sessionId);
    if (active?.value.state !== 'claimed') return;
    active.timer = setTimeout(
      () => {
        const task = this.#renew(sessionId, active.value).finally(() => this.#pending.delete(task));
        this.#pending.add(task);
      },
      Math.max(
        1,
        Math.min(
          (LEASE_SECONDS * 1000) / 3,
          Date.parse(active.value.expiresAt as string) -
            this.#options.client.transport.serverNow() -
            1000,
        ),
      ),
    );
    active.timer.unref?.();
  }

  async #renew(sessionId: string, value: SyncExecutionRecord): Promise<void> {
    const vault = this.#options.eligible();
    try {
      if (!vault || vault.vaultId !== value.vaultId) throw new ZuvRequestError('SCOPE_DISABLED');
      const result = await this.#options.client.json(
        'execution',
        'POST',
        '/api/wevir/sync/v1/executions/renew',
        {
          runId: value.runId,
          expectedEpoch: value.epoch,
          fencingToken: value.fencingToken,
          leaseSeconds: LEASE_SECONDS,
        },
        { signal: this.#abort.signal },
      );
      if (this.#active.get(sessionId)?.value !== value) return;
      if (
        !this.#sameVault(vault) ||
        result.runId !== value.runId ||
        result.epoch !== value.epoch ||
        result.fencingToken !== value.fencingToken ||
        Date.parse(result.expiresAt) <= this.#options.client.transport.serverNow() ||
        Date.parse(result.expiresAt) >
          this.#options.client.transport.serverNow() + LEASE_SECONDS * 1000 + 2000
      )
        throw new ZuvRequestError('EXECUTION_CONFLICT');
      const next = { ...value, expiresAt: result.expiresAt };
      this.#save(next, false);
      this.#active.set(sessionId, { value: next });
      this.#schedule(sessionId);
    } catch {
      if (this.#active.get(sessionId)?.value !== value) return;
      const lost = {
        ...value,
        state: 'lost' as const,
        streamId: newId('sst'),
        fencingToken: undefined,
      };
      this.#save(lost, true);
      this.#active.set(sessionId, { value: lost });
    }
  }

  #trackRelease(value: SyncExecutionRecord): Promise<void> {
    const sessionId = value.localSessionId;
    const task = this.#release(value).finally(() => {
      if (this.#releasing.get(sessionId) === task) this.#releasing.delete(sessionId);
      this.#pending.delete(task);
    });
    this.#releasing.set(sessionId, task);
    this.#pending.add(task);
    return task;
  }

  async #release(value: SyncExecutionRecord): Promise<void> {
    try {
      const vault = this.#options.eligible();
      if (!vault || vault.vaultId !== value.vaultId) return;
      const result = await this.#options.client.json(
        'execution',
        'POST',
        '/api/wevir/sync/v1/executions/release',
        { runId: value.runId, expectedEpoch: value.epoch, fencingToken: value.fencingToken },
        { signal: AbortSignal.any([this.#abort.signal, AbortSignal.timeout(2000)]) },
      );
      const current = this.#options.storage.sync.execution(value.vaultId, value.localSessionId);
      if (!this.#sameVault(vault) || current?.turnId !== value.turnId) return;
      if (
        result.runId !== value.runId ||
        result.epoch !== value.epoch ||
        result.fencingToken !== value.fencingToken
      )
        throw new ZuvRequestError('INTEGRITY_FAILED');
      this.#save(
        { ...value, state: 'released', expiresAt: result.expiresAt, fencingToken: undefined },
        false,
      );
    } catch {
      // Release is best effort; expiry cannot authorize replay or terminate another holder.
    }
  }

  #save(value: SyncExecutionRecord, branchRequired: boolean): void {
    const { storage, events, capture } = this.#options;
    if (!storage.sessions.get(value.localSessionId)) return;
    events.appendMany(
      value.localSessionId as SessionId,
      [
        {
          type: 'session.execution',
          source: 'host',
          payload: {
            runId: value.runId,
            streamId: value.streamId,
            epoch: value.epoch,
            state: value.state,
            ...(value.turnId && { turnId: value.turnId as TurnId }),
            ...(value.expiresAt && { expiresAt: value.expiresAt }),
            branchRequired,
            ...(value.source !== undefined && {
              source: SyncContinuationSchema.shape.source.parse(value.source),
            }),
          },
        },
      ],
      {
        inTransaction: () => {
          const previous = storage.sync.execution(value.vaultId, value.localSessionId);
          if (previous?.streamId !== value.streamId)
            capture.preserveForRemoval([value.localSessionId]);
          storage.sync.putExecution(value);
        },
      },
    );
  }
}
