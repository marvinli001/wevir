// 公开测试向量（cacophony、snow）里 25519 + ChaChaPoly + SHA256 的 IK、XXpsk3、XXpsk0+psk2，加 Rust snow 0.10.0 生成的
// XXpsk2 与 IK（test-vectors/snowgen/）。来源与许可写在每个 JSON 的 source 里。比对每条消息的密文、对端解出的负载与握手哈希。
import { describe, expect, it } from 'vitest';
import cacophony from '../test-vectors/cacophony.json' with { type: 'json' };
import snow from '../test-vectors/snow.json' with { type: 'json' };
import snowGenerated from '../test-vectors/snow-generated.json' with { type: 'json' };
import { HandshakeState, PAIRING_PROTOCOL, RECONNECT_PROTOCOL } from './handshake.js';
import { publicKeyFromSecretKey } from './primitives.js';
import { fromHex, toHex } from './test-utils.js';

interface Vector {
  readonly protocol_name: string;
  readonly init_prologue: string;
  readonly init_psks?: readonly string[];
  readonly init_static?: string;
  readonly init_ephemeral: string;
  readonly init_remote_static?: string;
  readonly resp_prologue: string;
  readonly resp_psks?: readonly string[];
  readonly resp_static?: string;
  readonly resp_ephemeral: string;
  readonly resp_remote_static?: string;
  readonly handshake_hash?: string;
  readonly messages: readonly { readonly payload: string; readonly ciphertext: string }[];
}

const keyPair = (secret: string) => {
  const secretKey = fromHex(secret);
  return { secretKey, publicKey: publicKeyFromSecretKey(secretKey) };
};

function party(vector: Vector, side: 'init' | 'resp'): HandshakeState {
  const field = <K extends string>(name: K) =>
    vector[`${side}_${name}` as keyof Vector] as string | undefined;
  const staticSecret = field('static');
  if (staticSecret === undefined) throw new Error('vector without a static key');
  const remote = field('remote_static');
  const psks = (side === 'init' ? vector.init_psks : vector.resp_psks) ?? [];
  return new HandshakeState({
    protocolName: vector.protocol_name,
    initiator: side === 'init',
    prologue: fromHex(field('prologue') ?? ''),
    staticKeyPair: keyPair(staticSecret),
    ephemeralKeyPair: keyPair(field('ephemeral') ?? ''),
    ...(remote === undefined ? {} : { remoteStaticKey: fromHex(remote) }),
    psks: psks.map(fromHex),
  });
}

function run(vector: Vector): void {
  const initiator = party(vector, 'init');
  const responder = party(vector, 'resp');
  let transport:
    | { init: ReturnType<HandshakeState['split']>; resp: ReturnType<HandshakeState['split']> }
    | undefined;
  vector.messages.forEach((message, index) => {
    const fromInitiator = index % 2 === 0;
    const payload = fromHex(message.payload);
    let ciphertext: Uint8Array;
    let received: Uint8Array;
    if (!initiator.isComplete) {
      const [writer, reader] = fromInitiator ? [initiator, responder] : [responder, initiator];
      ciphertext = writer.writeMessage(payload);
      received = reader.readMessage(ciphertext);
    } else {
      transport ??= { init: initiator.split(), resp: responder.split() };
      const [writer, reader] = fromInitiator
        ? [transport.init, transport.resp]
        : [transport.resp, transport.init];
      ciphertext = writer.send.encryptWithAd(new Uint8Array(0), payload);
      received = reader.receive.decryptWithAd(new Uint8Array(0), ciphertext);
    }
    expect(toHex(ciphertext), `message ${index} ciphertext`).toBe(message.ciphertext);
    expect(toHex(received), `message ${index} payload`).toBe(message.payload);
  });
  expect(initiator.isComplete && responder.isComplete).toBe(true);
  expect(toHex(initiator.handshakeHash)).toBe(toHex(responder.handshakeHash));
  if (vector.handshake_hash !== undefined)
    expect(toHex(initiator.handshakeHash)).toBe(vector.handshake_hash);
}

const sets: Record<string, { vectors: readonly Vector[] }> = {
  cacophony,
  snow,
  'snow-generated': snowGenerated,
};

describe.each(Object.entries(sets))('%s vectors', (_name, set) => {
  it.each(set.vectors.map((vector) => [vector.protocol_name, vector] as const))(
    '%s',
    (_protocol, vector) => {
      run(vector);
    },
  );
});

describe('vector coverage', () => {
  it('covers both Wevir protocols and the public psk placements', () => {
    const names = Object.values(sets).flatMap((set) =>
      set.vectors.map((vector) => vector.protocol_name),
    );
    expect(names.filter((name) => name === PAIRING_PROTOCOL)).toHaveLength(1);
    expect(names.filter((name) => name === RECONNECT_PROTOCOL)).toHaveLength(3);
    expect(names).toContain('Noise_XXpsk3_25519_ChaChaPoly_SHA256');
    expect(names).toContain('Noise_XXpsk0+psk2_25519_ChaChaPoly_SHA256');
  });
});
