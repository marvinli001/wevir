// 在这台手机（Hermes）上跑一遍 @wevir/noise 的 `XXpsk2` 配对与 `IK` 重连（两端都在本进程里），确认随机数与原语可用并量出握手耗时。
// 开发构建启动时跑一次，结果打到 Metro 日志（ADR-0017 补记里记下的模拟器数字来自这里）。

import {
  createHandshake,
  derivePairingPsk,
  generateKeyPair,
  PAIRING_PROTOCOL,
  RECONNECT_PROTOCOL,
  randomBytes,
  remotePrologue,
} from '@wevir/noise';

export interface NoiseSelfTest {
  /** 设备一侧的一次 `XXpsk2`（三条消息，含读写）。 */
  pairMs: number;
  /** 设备一侧的一次 `IK`（两条消息）。 */
  reconnectMs: number;
  /** 一次 X25519 生成密钥。 */
  keygenMs: number;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function runNoiseSelfTest(rounds = 5): NoiseSelfTest {
  const host = generateKeyPair();
  const prologue = remotePrologue({ host: 'self-test' });
  let pairTotal = 0;
  let reconnectTotal = 0;
  let keygenTotal = 0;
  for (let round = 0; round < rounds; round += 1) {
    let t = now();
    const device = generateKeyPair();
    keygenTotal += now() - t;
    const psk = derivePairingPsk(randomBytes(32), host.publicKey);
    const d = createHandshake({
      protocol: PAIRING_PROTOCOL,
      initiator: true,
      prologue,
      staticKeyPair: device,
      remoteStaticKey: host.publicKey,
      psk,
    });
    const h = createHandshake({
      protocol: PAIRING_PROTOCOL,
      initiator: false,
      prologue,
      staticKeyPair: host,
      psk,
    });
    t = now();
    const m1 = d.writeMessage();
    h.readMessage(m1);
    const m2 = h.writeMessage(new TextEncoder().encode('{}'));
    d.readMessage(m2);
    const m3 = d.writeMessage(new TextEncoder().encode('{"name":"self-test","platform":"ios"}'));
    h.readMessage(m3);
    pairTotal += now() - t;
    assertSameKeys(d.split(), h.split());

    const di = createHandshake({
      protocol: RECONNECT_PROTOCOL,
      initiator: true,
      prologue,
      staticKeyPair: device,
      remoteStaticKey: host.publicKey,
    });
    const hi = createHandshake({
      protocol: RECONNECT_PROTOCOL,
      initiator: false,
      prologue,
      staticKeyPair: host,
    });
    t = now();
    hi.readMessage(di.writeMessage());
    di.readMessage(hi.writeMessage());
    reconnectTotal += now() - t;
    assertSameKeys(di.split(), hi.split());
  }
  const round = (ms: number) => Math.round((ms / rounds) * 10) / 10;
  return {
    pairMs: round(pairTotal),
    reconnectMs: round(reconnectTotal),
    keygenMs: round(keygenTotal),
  };
}

function assertSameKeys(
  device: { handshakeHash: Uint8Array },
  host: { handshakeHash: Uint8Array },
): void {
  const a = device.handshakeHash;
  const b = host.handshakeHash;
  if (a.length !== b.length || a.some((byte, i) => byte !== b[i])) {
    throw new Error('Noise self-test failed: the two sides derived different handshake hashes');
  }
}
