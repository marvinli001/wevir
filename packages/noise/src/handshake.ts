import { CipherState, MAX_MESSAGE_LENGTH, TAG_LENGTH } from './cipher-state.js';
import { NoiseError } from './errors.js';
import {
  concatBytes,
  DH_LENGTH,
  equalBytes,
  HASH_LENGTH,
  hmacWith,
  type KeyPair,
  type NoisePrimitives,
  noblePrimitives,
} from './primitives.js';

/** 配对：设备与 Host 互相认证静态公钥，PSK 由配对秘密派生，在第二条消息末尾混入。 */
export const PAIRING_PROTOCOL = 'Noise_XXpsk2_25519_ChaChaPoly_SHA256';
/** 配对之后的每次连接：设备已知 Host 的静态公钥，Host 只接受登记过的设备公钥。 */
export const RECONNECT_PROTOCOL = 'Noise_IK_25519_ChaChaPoly_SHA256';
export type NoiseProtocol = typeof PAIRING_PROTOCOL | typeof RECONNECT_PROTOCOL;

export interface HandshakeOptions {
  readonly protocol: NoiseProtocol;
  /** 发起方是设备（手机、CLI），响应方是 Host。 */
  readonly initiator: boolean;
  /** 双方必须一致（`remotePrologue` 拼出）。 */
  readonly prologue: Uint8Array;
  readonly staticKeyPair: KeyPair;
  /**
   * 事先知道的对方静态公钥。`IK` 的发起方必填（Host 公钥）；`XXpsk2` 里是对方必须出示的公钥（二维码里的 Host 公钥），
   * 对方在握手里出示的与它不一致就以 `remote_key_rejected` 失败。
   */
  readonly remoteStaticKey?: Uint8Array;
  /** 读到对方静态公钥时调用，返回 false 就以 `remote_key_rejected` 失败（Host 用它查设备表）。 */
  readonly acceptRemoteStaticKey?: (key: Uint8Array) => boolean;
  /** `XXpsk2` 必填，32 字节（`derivePairingPsk`）。 */
  readonly psk?: Uint8Array;
  readonly primitives?: NoisePrimitives;
}

/** 握手结束后的两个方向。 */
export interface TransportCiphers {
  readonly send: CipherState;
  readonly receive: CipherState;
  /** 握手哈希，可用于通道绑定。 */
  readonly handshakeHash: Uint8Array;
}

/** 建一个 `XXpsk2` 或 `IK` 握手。对外只有这两种。 */
export function createHandshake(options: HandshakeOptions): HandshakeState {
  const { protocol, psk, ...rest } = options;
  if (protocol === PAIRING_PROTOCOL) {
    if (psk?.length !== 32)
      throw new NoiseError('invalid_key', 'pairing handshake needs a 32-byte psk');
    return new HandshakeState({ ...rest, protocolName: protocol, psks: [psk] });
  }
  if (protocol === RECONNECT_PROTOCOL) {
    if (psk !== undefined) throw new NoiseError('invalid_key', 'reconnect handshake takes no psk');
    if (options.initiator && options.remoteStaticKey === undefined) {
      throw new NoiseError('invalid_key', 'reconnect initiator needs the responder static key');
    }
    return new HandshakeState({ ...rest, protocolName: protocol });
  }
  throw new NoiseError('invalid_state', `unsupported protocol ${String(protocol)}`);
}

type Token = 'e' | 's' | 'ee' | 'es' | 'se' | 'ss' | 'psk';

interface Pattern {
  /** 响应方的静态公钥是预先消息（`IK`）。 */
  readonly responderStaticKnown: boolean;
  readonly messages: readonly (readonly Token[])[];
  readonly psk: boolean;
}

const BASE_PATTERNS: Record<string, Omit<Pattern, 'psk'>> = {
  XX: {
    responderStaticKnown: false,
    messages: [['e'], ['e', 'ee', 's', 'es'], ['s', 'se']],
  },
  IK: {
    responderStaticKnown: true,
    messages: [
      ['e', 'es', 's', 'ss'],
      ['e', 'ee', 'se'],
    ],
  },
};

/** XX / IK 加 pskN 修饰符，DH、密码、哈希固定。测试向量里有 XXpsk3、XXpsk0+psk2，所以内部按通用规则展开。 */
export function parsePattern(protocolName: string): Pattern {
  const match = /^Noise_(XX|IK)((?:psk\d)(?:\+psk\d)*)?_25519_ChaChaPoly_SHA256$/.exec(
    protocolName,
  );
  const base = match?.[1] === undefined ? undefined : BASE_PATTERNS[match[1]];
  if (match === null || base === undefined) {
    throw new NoiseError('invalid_state', `unsupported protocol ${protocolName}`);
  }
  const messages = base.messages.map((tokens) => [...tokens]);
  const modifiers = match[2]?.split('+') ?? [];
  for (const modifier of modifiers) {
    const n = Number(modifier.slice(3));
    const target = n === 0 ? messages[0] : messages[n - 1];
    if (target === undefined)
      throw new NoiseError('invalid_state', `bad modifier ${modifier} in ${protocolName}`);
    if (n === 0) target.unshift('psk');
    else target.push('psk');
  }
  return { ...base, messages, psk: modifiers.length > 0 };
}

const EMPTY = new Uint8Array(0);

class SymmetricState {
  readonly #primitives: NoisePrimitives;
  cipher: CipherState;
  #chainingKey: Uint8Array;
  hash: Uint8Array;

  constructor(primitives: NoisePrimitives, protocolName: string) {
    this.#primitives = primitives;
    const name = new TextEncoder().encode(protocolName);
    if (name.length <= HASH_LENGTH) {
      this.hash = new Uint8Array(HASH_LENGTH);
      this.hash.set(name);
    } else {
      this.hash = primitives.hash(name);
    }
    this.#chainingKey = this.hash;
    this.cipher = new CipherState(primitives);
  }

  mixKey(inputKeyMaterial: Uint8Array): void {
    const [chainingKey, key] = this.#hkdf2(inputKeyMaterial);
    this.#chainingKey = chainingKey;
    this.cipher = new CipherState(this.#primitives, key);
  }

  mixHash(data: Uint8Array): void {
    this.hash = this.#primitives.hash(concatBytes(this.hash, data));
  }

  mixKeyAndHash(inputKeyMaterial: Uint8Array): void {
    const [chainingKey, hashInput, key] = this.#hkdf3(inputKeyMaterial);
    this.#chainingKey = chainingKey;
    this.mixHash(hashInput);
    this.cipher = new CipherState(this.#primitives, key);
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipher.encryptWithAd(this.hash, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipher.decryptWithAd(this.hash, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  split(): [CipherState, CipherState] {
    const [first, second] = this.#hkdf2(EMPTY);
    return [new CipherState(this.#primitives, first), new CipherState(this.#primitives, second)];
  }

  // Noise §4.3 的 HKDF（输出都是 HASHLEN = 32 字节，正好是密钥长度，不用截断）。
  #hkdf2(inputKeyMaterial: Uint8Array): [Uint8Array, Uint8Array, Uint8Array] {
    const tempKey = hmacWith(this.#primitives, this.#chainingKey, inputKeyMaterial);
    const first = hmacWith(this.#primitives, tempKey, Uint8Array.of(1));
    const second = hmacWith(this.#primitives, tempKey, concatBytes(first, Uint8Array.of(2)));
    return [first, second, tempKey];
  }

  #hkdf3(inputKeyMaterial: Uint8Array): [Uint8Array, Uint8Array, Uint8Array] {
    const [first, second, tempKey] = this.#hkdf2(inputKeyMaterial);
    return [
      first,
      second,
      hmacWith(this.#primitives, tempKey, concatBytes(second, Uint8Array.of(3))),
    ];
  }
}

/** 内部构造参数：测试向量要用任意 psk 位置与固定的临时密钥，对外的 `createHandshake` 不开放这两项。 */
export interface InternalHandshakeOptions extends Omit<HandshakeOptions, 'protocol' | 'psk'> {
  readonly protocolName: string;
  readonly psks?: readonly Uint8Array[];
  /** 固定的临时密钥，只给测试向量用。 */
  readonly ephemeralKeyPair?: KeyPair;
}

/**
 * Noise 的 HandshakeState（rev 34）。双方轮流 `writeMessage` / `readMessage`，最后一条消息之后 `split()` 拿到传输用的两个
 * CipherState。任何一步失败后对象作废（`invalid_state`），调用方断开连接。
 */
export class HandshakeState {
  readonly #primitives: NoisePrimitives;
  readonly #symmetric: SymmetricState;
  readonly #pattern: Pattern;
  readonly #initiator: boolean;
  readonly #staticKeyPair: KeyPair;
  readonly #expectedRemoteStatic: Uint8Array | undefined;
  readonly #acceptRemoteStatic: ((key: Uint8Array) => boolean) | undefined;
  readonly #psks: Uint8Array[];
  #fixedEphemeral: KeyPair | undefined;
  #ephemeral: KeyPair | undefined;
  #remoteStatic: Uint8Array | undefined;
  #remoteEphemeral: Uint8Array | undefined;
  #index = 0;
  #failed = false;
  #transport: TransportCiphers | undefined;
  #split = false;

  constructor(options: InternalHandshakeOptions) {
    this.#primitives = options.primitives ?? noblePrimitives;
    this.#pattern = parsePattern(options.protocolName);
    this.#initiator = options.initiator;
    this.#staticKeyPair = checkKeyPair(options.staticKeyPair);
    this.#acceptRemoteStatic = options.acceptRemoteStaticKey;
    this.#psks = [...(options.psks ?? [])];
    for (const psk of this.#psks) {
      if (psk.length !== 32) throw new NoiseError('invalid_key', 'psk must be 32 bytes');
    }
    this.#fixedEphemeral = options.ephemeralKeyPair;
    const remoteStatic = options.remoteStaticKey;
    if (remoteStatic !== undefined && remoteStatic.length !== DH_LENGTH) {
      throw new NoiseError('invalid_key', 'remote static key must be 32 bytes');
    }

    this.#symmetric = new SymmetricState(this.#primitives, options.protocolName);
    this.#symmetric.mixHash(options.prologue);
    if (this.#pattern.responderStaticKnown) {
      if (this.#initiator) {
        if (remoteStatic === undefined)
          throw new NoiseError('invalid_key', 'missing responder static key');
        this.#remoteStatic = remoteStatic;
        this.#symmetric.mixHash(remoteStatic);
      } else {
        this.#symmetric.mixHash(this.#staticKeyPair.publicKey);
      }
      this.#expectedRemoteStatic = undefined;
    } else {
      this.#expectedRemoteStatic = remoteStatic;
    }
  }

  get isInitiator(): boolean {
    return this.#initiator;
  }

  get isComplete(): boolean {
    return this.#transport !== undefined;
  }

  /** 轮到这一方写下一条消息。 */
  get isMyTurn(): boolean {
    return !this.isComplete && this.#index % 2 === (this.#initiator ? 0 : 1);
  }

  /** 对方的静态公钥（读到之后才有）。 */
  get remoteStaticKey(): Uint8Array | undefined {
    return this.#remoteStatic;
  }

  /** 当前的握手哈希；握手结束后即 Noise 的 handshake hash。 */
  get handshakeHash(): Uint8Array {
    return this.#symmetric.hash;
  }

  writeMessage(payload: Uint8Array = EMPTY): Uint8Array {
    this.#checkUsable();
    if (!this.isMyTurn) throw new NoiseError('invalid_state', 'not this side’s turn to write');
    return this.#guard(() => {
      const parts: Uint8Array[] = [];
      for (const token of this.#pattern.messages[this.#index] ?? []) {
        if (token === 'e') {
          const ephemeral = this.#fixedEphemeral ?? this.#primitives.generateKeyPair();
          this.#ephemeral = checkKeyPair(ephemeral);
          parts.push(ephemeral.publicKey);
          this.#symmetric.mixHash(ephemeral.publicKey);
          if (this.#pattern.psk) this.#symmetric.mixKey(ephemeral.publicKey);
        } else if (token === 's') {
          parts.push(this.#symmetric.encryptAndHash(this.#staticKeyPair.publicKey));
        } else if (token === 'psk') {
          this.#symmetric.mixKeyAndHash(this.#nextPsk());
        } else {
          this.#symmetric.mixKey(this.#dhToken(token));
        }
      }
      parts.push(this.#symmetric.encryptAndHash(payload));
      const message = concatBytes(...parts);
      if (message.length > MAX_MESSAGE_LENGTH) {
        throw new NoiseError('bad_message', `handshake message of ${message.length} bytes`);
      }
      this.#advance();
      return message;
    });
  }

  readMessage(message: Uint8Array): Uint8Array {
    this.#checkUsable();
    if (this.isComplete || this.isMyTurn)
      throw new NoiseError('invalid_state', 'not this side’s turn to read');
    return this.#guard(() => {
      if (message.length > MAX_MESSAGE_LENGTH) {
        throw new NoiseError('bad_message', `handshake message of ${message.length} bytes`);
      }
      let offset = 0;
      const take = (length: number): Uint8Array => {
        if (message.length < offset + length)
          throw new NoiseError('bad_message', 'handshake message too short');
        const bytes = message.slice(offset, offset + length);
        offset += length;
        return bytes;
      };
      for (const token of this.#pattern.messages[this.#index] ?? []) {
        if (token === 'e') {
          const remoteEphemeral = take(DH_LENGTH);
          this.#remoteEphemeral = remoteEphemeral;
          this.#symmetric.mixHash(remoteEphemeral);
          if (this.#pattern.psk) this.#symmetric.mixKey(remoteEphemeral);
        } else if (token === 's') {
          const length = this.#symmetric.cipher.hasKey ? DH_LENGTH + TAG_LENGTH : DH_LENGTH;
          const remoteStatic = this.#symmetric.decryptAndHash(take(length));
          this.#checkRemoteStatic(remoteStatic);
          this.#remoteStatic = remoteStatic;
        } else if (token === 'psk') {
          this.#symmetric.mixKeyAndHash(this.#nextPsk());
        } else {
          this.#symmetric.mixKey(this.#dhToken(token));
        }
      }
      const payload = this.#symmetric.decryptAndHash(message.slice(offset));
      this.#advance();
      return payload;
    });
  }

  /** 握手结束后取一次传输用的 CipherState。 */
  split(): TransportCiphers {
    this.#checkUsable();
    if (this.#transport === undefined)
      throw new NoiseError('invalid_state', 'handshake is not complete');
    if (this.#split) throw new NoiseError('invalid_state', 'transport ciphers were already taken');
    this.#split = true;
    return this.#transport;
  }

  #checkUsable(): void {
    if (this.#failed) throw new NoiseError('invalid_state', 'handshake failed earlier');
  }

  #guard<T>(step: () => T): T {
    try {
      return step();
    } catch (error) {
      this.#failed = true;
      throw error;
    }
  }

  #checkRemoteStatic(key: Uint8Array): void {
    if (this.#expectedRemoteStatic !== undefined && !equalBytes(key, this.#expectedRemoteStatic)) {
      throw new NoiseError(
        'remote_key_rejected',
        'remote static key does not match the expected key',
      );
    }
    if (this.#acceptRemoteStatic !== undefined && !this.#acceptRemoteStatic(key)) {
      throw new NoiseError('remote_key_rejected', 'remote static key is not accepted');
    }
  }

  #nextPsk(): Uint8Array {
    const psk = this.#psks.shift();
    if (psk === undefined) throw new NoiseError('invalid_key', 'missing psk');
    return psk;
  }

  // 发起方：es = DH(e, rs)，se = DH(s, re)；响应方反过来。
  #dhToken(token: 'ee' | 'es' | 'se' | 'ss'): Uint8Array {
    const local = (which: 'e' | 's') =>
      required(which === 'e' ? this.#ephemeral : this.#staticKeyPair).secretKey;
    const remote = (which: 'e' | 's') =>
      required(which === 'e' ? this.#remoteEphemeral : this.#remoteStatic);
    switch (token) {
      case 'ee':
        return this.#dh(local('e'), remote('e'));
      case 'ss':
        return this.#dh(local('s'), remote('s'));
      case 'es':
        return this.#initiator
          ? this.#dh(local('e'), remote('s'))
          : this.#dh(local('s'), remote('e'));
      case 'se':
        return this.#initiator
          ? this.#dh(local('s'), remote('e'))
          : this.#dh(local('e'), remote('s'));
    }
  }

  #dh(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
    let shared: Uint8Array;
    try {
      shared = this.#primitives.dh(secretKey, publicKey);
    } catch {
      throw new NoiseError('invalid_key', 'X25519 rejected the public key');
    }
    // 原语可以替换，这里不依赖它自己的检查：全零结果说明对方给的是全零 / 低阶点。
    if (shared.length !== DH_LENGTH || shared.every((byte) => byte === 0)) {
      throw new NoiseError('invalid_key', 'X25519 produced an all-zero shared secret');
    }
    return shared;
  }

  #advance(): void {
    this.#index++;
    if (this.#index < this.#pattern.messages.length) return;
    const [first, second] = this.#symmetric.split();
    const handshakeHash = this.#symmetric.hash;
    this.#transport = this.#initiator
      ? { send: first, receive: second, handshakeHash }
      : { send: second, receive: first, handshakeHash };
    this.#ephemeral = undefined;
    this.#fixedEphemeral = undefined;
  }
}

function required<T>(value: T | undefined): T {
  if (value === undefined)
    throw new NoiseError('invalid_state', 'key needed by this handshake step is missing');
  return value;
}

function checkKeyPair(keyPair: KeyPair): KeyPair {
  if (keyPair.publicKey.length !== DH_LENGTH || keyPair.secretKey.length !== DH_LENGTH) {
    throw new NoiseError('invalid_key', 'X25519 key pair must be 32-byte keys');
  }
  return keyPair;
}
