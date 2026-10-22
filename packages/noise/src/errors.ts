/**
 * `@wevir/noise` 抛出的错误。调用方按 `code` 处理；远程连接上任何一种都应当直接断开，不重试、不重同步。
 */
export type NoiseErrorCode =
  /** AEAD 校验失败：配对码不对、prologue 不一致、重放、乱序、篡改。 */
  | 'decrypt_failed'
  /** 消息长度不对、超过 Noise 的 65535 字节、帧标志不对。 */
  | 'bad_message'
  /** 不是这一方的回合、握手已结束，或这个对象之前已经失败过。 */
  | 'invalid_state'
  /** 密钥长度不对，或 DH 结果全零（全零 / 低阶点）。 */
  | 'invalid_key'
  /** 对方的静态公钥与预期不符，或调用方不接受它（未知或已吊销的设备）。 */
  | 'remote_key_rejected'
  /** nonce 用到了 2^53 - 1。 */
  | 'nonce_exhausted'
  /** 应用帧超过上限（默认 4 MiB）。 */
  | 'frame_too_large'
  /** 运行环境没有 `globalThis.crypto.getRandomValues`。 */
  | 'no_random';

export class NoiseError extends Error {
  readonly code: NoiseErrorCode;

  constructor(code: NoiseErrorCode, message: string) {
    super(message);
    this.name = 'NoiseError';
    this.code = code;
  }
}
