import { SyncRecoveryJournalSchema } from '@wevir/protocol';
import { id } from '@wevir/protocol/sync';
import type { SecretStore } from '@wevir/storage';
import type { ZuvClient } from '../zuv/client.js';
import { ZuvRequestError } from '../zuv/transport.js';
import type { SyncVaultKeys } from './keys.js';

type State = typeof SyncRecoveryJournalSchema._output;

export class SyncLifecycle {
  constructor(readonly options: { client: ZuvClient; keys: SyncVaultKeys; secrets: SecretStore }) {}
  info() {
    const { client } = this.options;
    const identity =
      client.signedIn && !client.requiresLogin && !client.changingIdentity
        ? client.entitlements
        : undefined;
    return {
      ...(identity?.vault && {
        vaultId: identity.vault.vaultId,
        keyEpoch: identity.vault.keyEpoch,
      }),
      ...(identity && { deviceId: identity.identity.deviceId }),
      eligible: identity?.recovery.eligible ?? false,
      manageUrl: new URL('/console/subscription', client.transport.origin).href,
    };
  }

  async status(vaultId: string, refresh = false) {
    const binding = this.#identity(vaultId);
    const state = await this.#load(binding);
    if (refresh && state.request) {
      const request = await this.options.client.json(
        'recoveryState',
        'GET',
        `/api/wevir/recovery/requests/${state.request.requestId}`,
      );
      if (request.requestId !== state.request.requestId)
        throw new ZuvRequestError('INTEGRITY_FAILED');
      state.request = request;
      await this.#save(state);
    }
    return this.#view(state);
  }

  async request(vaultId: string) {
    const binding = this.#identity(vaultId);
    const state = await this.#load(binding);
    if (state.request && !['completed', 'cancelled'].includes(state.request.state))
      return this.status(vaultId, true);
    const request = await this.options.client.json(
      'recoveryState',
      'POST',
      '/api/wevir/recovery/requests',
      { vaultId },
    );
    state.request = request;
    state.requestedEpoch = this.options.client.entitlements?.vault?.keyEpoch;
    await this.#save(state);
    return this.#view(state);
  }

  async complete(vaultId: string, requestId: string) {
    const binding = this.#identity(vaultId);
    const state = await this.#load(binding);
    if (state.request?.requestId !== requestId) throw new ZuvRequestError('RECOVERY_REQUIRED');
    await this.status(vaultId, true);
    const current = await this.#load(binding);
    const request = current.request;
    if (!request || !current.requestedEpoch) throw new ZuvRequestError('RECOVERY_REQUIRED');
    let completedEpoch: string | undefined;
    if (request.state !== 'completed') {
      if (
        request.state !== 'approved' ||
        Date.parse(request.notBefore) > Date.now() ||
        Date.parse(request.expiresAt) <= Date.now()
      )
        throw new ZuvRequestError('RECOVERY_REQUIRED');
      const completed = await this.options.client.json(
        'recoveryCompleted',
        'POST',
        `/api/wevir/recovery/requests/${requestId}/complete`,
        { requestId },
      );
      if (completed.requestId !== requestId) throw new ZuvRequestError('INTEGRITY_FAILED');
      completedEpoch = completed.keyEpoch;
      current.request = { ...request, state: 'completed' };
      await this.#save(current);
    }
    // A lost complete response is reconciled by GET before any second POST.
    await this.options.client.getEntitlements();
    this.#guard(binding);
    const epoch = this.options.client.entitlements?.vault?.keyEpoch;
    if (
      !epoch ||
      BigInt(epoch) <= BigInt(current.requestedEpoch) ||
      (completedEpoch && epoch !== completedEpoch)
    )
      throw new ZuvRequestError('INTEGRITY_FAILED');
    return this.unlock(vaultId);
  }

  async unlock(vaultId: string) {
    const binding = this.#identity(vaultId);
    const epoch = this.options.client.entitlements?.vault?.keyEpoch;
    if (!epoch) throw new ZuvRequestError('RECOVERY_REQUIRED');
    const state = await this.#load(binding);
    const key = await this.options.keys.unlock(vaultId, epoch, new AbortController().signal);
    key.fill(0);
    this.#guard(binding);
    state.unlockedEpoch = epoch;
    await this.#save(state);
    return this.#view(state);
  }

  async deleteCloud(vaultId: string, stepUpId: string) {
    const binding = this.#identity(vaultId);
    const result = await this.options.client.json(
      'deleted',
      'POST',
      '/api/wevir/sync/v1/vaults/delete',
      { stepUpId },
    );
    this.#guard(binding);
    return result;
  }

  #identity(vaultId: string) {
    id.parse(vaultId);
    const { client } = this.options;
    const identity = client.entitlements;
    if (
      !client.signedIn ||
      client.requiresLogin ||
      client.changingIdentity ||
      client.enrollment ||
      identity?.vault?.vaultId !== vaultId
    )
      throw new ZuvRequestError('AUTH_REQUIRED');
    return {
      v: 1 as const,
      origin: client.transport.origin,
      accountId: identity.identity.userId,
      deviceId: identity.identity.deviceId,
      vaultId,
    };
  }
  #guard(state: State) {
    const binding = this.#identity(state.vaultId);
    if (
      binding.accountId !== state.accountId ||
      binding.deviceId !== state.deviceId ||
      binding.origin !== state.origin
    )
      throw new ZuvRequestError('AUTH_REQUIRED');
  }
  #ref(state: State) {
    return `sync.${state.vaultId}.recovery.${state.deviceId}`;
  }
  async #load(binding: State): Promise<State> {
    const raw = await this.options.secrets.get(this.#ref(binding));
    const state = raw === undefined ? binding : SyncRecoveryJournalSchema.parse(JSON.parse(raw));
    this.#guard(state);
    return state;
  }
  async #save(state: State) {
    this.#guard(state);
    await this.options.secrets.set(this.#ref(state), JSON.stringify(state));
    this.#guard(state);
  }
  #view(state: State) {
    this.#guard(state);
    const keyEpoch = this.options.client.entitlements?.vault?.keyEpoch;
    return {
      vaultId: state.vaultId,
      ...(state.request && { request: state.request }),
      ...(keyEpoch && { keyEpoch }),
      unlocked: state.unlockedEpoch === keyEpoch,
    };
  }
}
