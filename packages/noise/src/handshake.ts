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
  type StaticKey,
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
  /** 本方的静态密钥。`StaticKey` 的 DH 是异步的时候，握手只能用 `writeMessageAsync` / `readMessageAsync`。 */
  readonly staticKeyPair: KeyPair | StaticKey;
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

/** 一步 DH：本方的临时或静态私钥，与对方的公钥。 */
interface DhRequest {
  readonly local: 'e' | 's';
  readonly remote: Uint8Array;
}

/** 一条消息的处理步骤：遇到 DH 时交出请求、拿回结果，这样同一份步骤既能同步跑，也能等异步的静态密钥 DH。 */
type Steps<T> = Generator<DhRequest, T, Uint8Array>;

/**
 * Noise 的 HandshakeState（rev 34）。双方轮流 `writeMessage` / `readMessage`，最后一条消息之后 `split()` 拿到传输用的两个
 * CipherState。静态密钥的 DH 是异步的（`StaticKey`）时改用 `writeMessageAsync` / `readMessageAsync`，两者的结果相同。任何一步
 * 失败后对象作废（`invalid_state`），调用方断开连接。
 */
export class HandshakeState {
  readonly #primitives: NoisePrimitives;
  readonly #symmetric: SymmetricState;
  readonly #pattern: Pattern;
  readonly #initiator: boolean;
  readonly #staticKeyPair: KeyPair | StaticKey;
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
  /** 异步的一步还没结束。 */
  #busy = false;

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
    this.#checkWrite();
    return this.#guard(() => this.#runSync(this.#writeSteps(payload)));
  }

  readMessage(message: Uint8Array): Uint8Array {
    this.#checkRead();
    return this.#guard(() => this.#runSync(this.#readSteps(message)));
  }

  /** 同 `writeMessage`，静态密钥的 DH 可以是异步的。结束之前不能开始下一步。 */
  writeMessageAsync(payload: Uint8Array = EMPTY): Promise<Uint8Array> {
    try {
      this.#checkWrite();
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#guardAsync(() => this.#runAsync(this.#writeSteps(payload)));
  }

  /** 同 `readMessage`，静态密钥的 DH 可以是异步的。结束之前不能开始下一步。 */
  readMessageAsync(message: Uint8Array): Promise<Uint8Array> {
    try {
      this.#checkRead();
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#guardAsync(() => this.#runAsync(this.#readSteps(message)));
  }

  #checkWrite(): void {
    this.#checkUsable();
    if (!this.isMyTurn) throw new NoiseError('invalid_state', 'not this side’s turn to write');
  }

  #checkRead(): void {
    this.#checkUsable();
    if (this.isComplete || this.isMyTurn)
      throw new NoiseError('invalid_state', 'not this side’s turn to read');
  }

  *#writeSteps(payload: Uint8Array): Steps<Uint8Array> {
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
        this.#symmetric.mixKey(yield this.#dhRequest(token));
      }
    }
    parts.push(this.#symmetric.encryptAndHash(payload));
    const message = concatBytes(...parts);
    if (message.length > MAX_MESSAGE_LENGTH) {
      throw new NoiseError('bad_message', `handshake message of ${message.length} bytes`);
    }
    this.#advance();
    return message;
  }

  *#readSteps(message: Uint8Array): Steps<Uint8Array> {
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
        this.#symmetric.mixKey(yield this.#dhRequest(token));
      }
    }
    const payload = this.#symmetric.decryptAndHash(message.slice(offset));
    this.#advance();
    return payload;
  }

  #runSync<T>(steps: Steps<T>): T {
    let next = steps.next();
    while (!next.done) {
      const shared = this.#dh(next.value);
      if (shared instanceof Promise) {
        shared.catch(() => {});
        throw new NoiseError(
          'invalid_state',
          'static key DH is asynchronous: use writeMessageAsync / readMessageAsync',
        );
      }
      next = steps.next(shared);
    }
    return next.value;
  }

  async #runAsync<T>(steps: Steps<T>): Promise<T> {
    let next = steps.next();
    while (!next.done) next = steps.next(await this.#dh(next.value));
    return next.value;
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
    if (this.#busy) throw new NoiseError('invalid_state', 'an asynchronous step is in progress');
  }

  #guard<T>(step: () => T): T {
    try {
      return step();
    } catch (error) {
      this.#failed = true;
      throw error;
    }
  }

  async #guardAsync<T>(step: () => Promise<T>): Promise<T> {
    this.#busy = true;
    try {
      return await step();
    } catch (error) {
      this.#failed = true;
      throw error;
    } finally {
      this.#busy = false;
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
  #dhRequest(token: 'ee' | 'es' | 'se' | 'ss'): DhRequest {
    const remote = (which: 'e' | 's') =>
      required(which === 'e' ? this.#remoteEphemeral : this.#remoteStatic);
    switch (token) {
      case 'ee':
        return { local: 'e', remote: remote('e') };
      case 'ss':
        return { local: 's', remote: remote('s') };
      case 'es':
        return this.#initiator
          ? { local: 'e', remote: remote('s') }
          : { local: 's', remote: remote('e') };
      case 'se':
        return this.#initiator
          ? { local: 's', remote: remote('e') }
          : { local: 'e', remote: remote('s') };
    }
  }

  /** 临时密钥的 DH 总是同步的；静态密钥是 `StaticKey` 时它的 DH 可能是异步的。 */
  #dh(request: DhRequest): Uint8Array | Promise<Uint8Array> {
    let shared: Uint8Array | Promise<Uint8Array>;
    try {
      if (request.local === 'e') {
        shared = this.#primitives.dh(required(this.#ephemeral).secretKey, request.remote);
      } else {
        const local = this.#staticKeyPair;
        shared =
          'secretKey' in local
            ? this.#primitives.dh(local.secretKey, request.remote)
            : local.dh(request.remote);
      }
    } catch (error) {
      if (error instanceof NoiseError && error.code === 'invalid_state') throw error;
      throw new NoiseError('invalid_key', 'X25519 rejected the public key');
    }
    if (shared instanceof Promise) {
      return shared.then(checkShared, () => {
        throw new NoiseError('invalid_key', 'X25519 rejected the public key');
      });
    }
    return checkShared(shared);
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

function checkKeyPair<K extends KeyPair | StaticKey>(keyPair: K): K {
  if (
    keyPair.publicKey.length !== DH_LENGTH ||
    ('secretKey' in keyPair && keyPair.secretKey.length !== DH_LENGTH)
  ) {
    throw new NoiseError('invalid_key', 'X25519 key pair must be 32-byte keys');
  }
  return keyPair;
}

// 原语可以替换，这里不依赖它自己的检查：全零结果说明对方给的是全零 / 低阶点。
function checkShared(shared: Uint8Array): Uint8Array {
  if (shared.length !== DH_LENGTH || shared.every((byte) => byte === 0)) {
    throw new NoiseError('invalid_key', 'X25519 produced an all-zero shared secret');
  }
  return shared;
}
