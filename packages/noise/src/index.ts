// 远程访问的 Noise 实现（ADR-0017）：配对用 Noise_XXpsk2_25519_ChaChaPoly_SHA256，之后每次连接用
// Noise_IK_25519_ChaChaPoly_SHA256。Host、CLI 与手机共用；不 import Node 内置模块。
export type { CipherState } from './cipher-state.js';
export { MAX_MESSAGE_LENGTH, MAX_NONCE } from './cipher-state.js';
export { NoiseError, type NoiseErrorCode } from './errors.js';
export { FrameReader, MAX_FRAGMENT_LENGTH, MAX_FRAME_LENGTH, sealFrame } from './frame.js';
export {
  createHandshake,
  type HandshakeOptions,
  type HandshakeState,
  type NoiseProtocol,
  PAIRING_PROTOCOL,
  RECONNECT_PROTOCOL,
  type TransportCiphers,
} from './handshake.js';
export {
  generateKeyPair,
  type KeyPair,
  type NoisePrimitives,
  noblePrimitives,
  publicKeyFromSecretKey,
  randomBytes,
} from './primitives.js';
export {
  derivePairingPsk,
  REMOTE_PROTOCOL_VERSION,
  type RemoteRouteIds,
  remotePrologue,
} from './remote.js';
