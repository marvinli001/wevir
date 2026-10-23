// Hermes 缺的运行时接口，入口最先 import（M2 的约定：只在 apps/mobile 里补，不改共享包）。
// - `globalThis.crypto.getRandomValues`：@noble/* 生成密钥与 Noise 的临时密钥要用。用 expo-crypto 的同步实现（系统的
//   SecRandomCopyBytes / SecureRandom）；装不上就抛错，绝不退回 `Math.random`。
// - `TextDecoder`：client-sdk 解密后按 UTF-8（`fatal`）解码。Hermes 有时才不补。
import { getRandomValues } from 'expo-crypto';
import { Utf8Decoder } from './utf8';

installRandomValues();
installTextDecoder();

function installRandomValues(): void {
  const existing = (globalThis as { crypto?: { getRandomValues?: unknown } }).crypto;
  if (typeof existing?.getRandomValues === 'function') return;
  if (typeof getRandomValues !== 'function') {
    throw new Error(
      'Wevir needs a secure random source: expo-crypto is not linked into this build',
    );
  }
  const crypto = existing ?? {};
  Object.defineProperty(crypto, 'getRandomValues', {
    value: <T extends ArrayBufferView | null>(array: T): T => {
      if (!(array instanceof Uint8Array)) {
        throw new TypeError('crypto.getRandomValues only takes a Uint8Array here');
      }
      return getRandomValues(array) as unknown as T;
    },
    configurable: true,
  });
  if (existing === undefined) {
    Object.defineProperty(globalThis, 'crypto', { value: crypto, configurable: true });
  }
  // 先试一次：原生模块没链接时 expo-crypto 在调用时才抛。
  const probe = new Uint8Array(16);
  (globalThis as unknown as { crypto: Crypto }).crypto.getRandomValues(probe);
}

function installTextDecoder(): void {
  if (typeof globalThis.TextDecoder === 'function') return;
  Object.defineProperty(globalThis, 'TextDecoder', { value: Utf8Decoder, configurable: true });
}
