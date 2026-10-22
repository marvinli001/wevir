import { ed25519 } from '@noble/curves/ed25519.js';
import { generateKeyPair, publicKeyFromSecretKey } from '@wevir/noise';
import type { SecretStore } from '@wevir/storage';

/** secrets.json 里 Host 的两对远程密钥（ADR-0017 §2）。名字带点，不会与 Provider ID 相撞。 */
export const NOISE_KEY_REF = 'remote.noise-static';
export const ROUTE_KEY_REF = 'remote.route-signing';

/** 一对 32 字节的密钥。私钥只给远程监听与中继注册用，不进日志、不上线缆。 */
export interface KeyPair {
  readonly publicKey: Uint8Array;
  readonly secretKey: Uint8Array;
}

/** Host 的远程身份：Noise 静态密钥（X25519）与路由密钥（Ed25519，公钥就是路由 ID）。 */
export interface RemoteKeys {
  readonly noise: KeyPair;
  readonly route: KeyPair;
  /** `noise.publicKey` 的 base64url。 */
  readonly hostPublicKey: string;
  /** `route.publicKey` 的 base64url。 */
  readonly routeId: string;
}

/**
 * Host 的远程密钥（domain-model §3.49）：第一次打开远程或第一次配对时生成，存进 `SecretStore`（secrets.json，ADR-0003），之后一直用
 * 同一对。条目缺了或读不懂时重新生成：已配对的设备认的是旧的 Host 公钥，要重新配对。Noise 静态密钥用 `@wevir/noise` 生成，路由密钥
 * （Ed25519）用 `@noble/curves`。
 */
export class RemoteIdentity {
  readonly #secrets: SecretStore;
  #keys: Promise<RemoteKeys> | undefined;

  constructor(options: { secrets: SecretStore }) {
    this.#secrets = options.secrets;
  }

  /** 读出密钥，没有时生成并存下。并发调用共用一次。 */
  ensure(): Promise<RemoteKeys> {
    this.#keys ??= this.#load().catch((error: unknown) => {
      this.#keys = undefined;
      throw error;
    });
    return this.#keys;
  }

  async #load(): Promise<RemoteKeys> {
    const noise =
      decode(await this.#secrets.get(NOISE_KEY_REF), publicKeyFromSecretKey) ??
      (await this.#create(NOISE_KEY_REF, generateKeyPair()));
    const route =
      decode(await this.#secrets.get(ROUTE_KEY_REF), (sk) => ed25519.getPublicKey(sk)) ??
      (await this.#create(ROUTE_KEY_REF, ed25519.keygen()));
    return {
      noise,
      route,
      hostPublicKey: base64url(noise.publicKey),
      routeId: base64url(route.publicKey),
    };
  }

  async #create(ref: string, pair: KeyPair): Promise<KeyPair> {
    await this.#secrets.set(
      ref,
      JSON.stringify({
        publicKey: base64url(pair.publicKey),
        secretKey: base64url(pair.secretKey),
      }),
    );
    return pair;
  }
}

/** 存的是 `{ publicKey, secretKey }`（base64url）；公钥按私钥重算核对，不一致或格式不对当作没有。 */
function decode(
  stored: string | undefined,
  publicKeyOf: (secretKey: Uint8Array) => Uint8Array,
): KeyPair | undefined {
  if (stored === undefined) return undefined;
  try {
    const value = JSON.parse(stored) as { publicKey?: unknown; secretKey?: unknown };
    if (typeof value.secretKey !== 'string' || typeof value.publicKey !== 'string')
      return undefined;
    const secretKey = new Uint8Array(Buffer.from(value.secretKey, 'base64url'));
    if (secretKey.length !== 32) return undefined;
    const publicKey = publicKeyOf(secretKey);
    return base64url(publicKey) === value.publicKey ? { publicKey, secretKey } : undefined;
  } catch {
    return undefined;
  }
}

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}
