import { decimal, id } from '@wevir/protocol/sync';
import type { SecretStore } from '@wevir/storage';
import type { ZuvClient } from '../zuv/client.js';
import { ZuvRequestError } from '../zuv/transport.js';

export class SyncVaultKeys {
  readonly #client: ZuvClient;
  readonly #secrets: SecretStore;
  readonly #onSecret: (value: string) => void;
  readonly #unlocking = new Map<string, Promise<Uint8Array>>();
  constructor(options: {
    client: ZuvClient;
    secrets: SecretStore;
    onSecret: (value: string) => void;
  }) {
    this.#client = options.client;
    this.#secrets = options.secrets;
    this.#onSecret = options.onSecret;
  }

  unlock(vaultId: string, keyEpoch: string, signal: AbortSignal): Promise<Uint8Array> {
    id.parse(vaultId);
    decimal.parse(keyEpoch);
    const ref = `sync.${vaultId}.key.${keyEpoch}`;
    let pending = this.#unlocking.get(ref);
    if (!pending) {
      pending = this.#unlock(vaultId, keyEpoch, ref, signal).finally(() => {
        this.#unlocking.delete(ref);
      });
      this.#unlocking.set(ref, pending);
    }
    return pending;
  }

  async cached(vaultId: string, keyEpoch: string): Promise<Uint8Array> {
    id.parse(vaultId);
    decimal.parse(keyEpoch);
    const material = await this.#secrets.get(`sync.${vaultId}.key.${keyEpoch}`);
    if (material === undefined) throw new ZuvRequestError('RECOVERY_REQUIRED');
    this.#onSecret(material);
    return this.#decode(material);
  }

  async #unlock(
    vaultId: string,
    keyEpoch: string,
    ref: string,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const vault = this.#client.entitlements?.vault;
    if (!vault || vault.vaultId !== vaultId || BigInt(keyEpoch) > BigInt(vault.keyEpoch))
      throw new ZuvRequestError('RECOVERY_REQUIRED');
    let material = await this.#secrets.get(ref);
    if (material === undefined) {
      if (signal.aborted) throw new ZuvRequestError('SCOPE_DISABLED');
      const unlocked = await this.#client.json(
        'unlocked',
        'POST',
        '/api/wevir/sync/v1/keys/unlock',
        { keyEpoch },
        { signal },
      );
      if (unlocked.vaultId !== vaultId || unlocked.keyEpoch !== keyEpoch || signal.aborted)
        throw new ZuvRequestError('INTEGRITY_FAILED');
      material = unlocked.keyMaterial;
      this.#onSecret(material);
      const bytes = this.#decode(material);
      await this.#secrets.set(ref, material);
      return bytes;
    }
    this.#onSecret(material);
    return this.#decode(material);
  }

  #decode(material: string): Uint8Array {
    const bytes = Buffer.from(material, 'base64url');
    if (bytes.length !== 32 || bytes.toString('base64url') !== material)
      throw new ZuvRequestError('INTEGRITY_FAILED');
    return bytes;
  }
}
